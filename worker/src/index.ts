// sc-cascade — Cloudflare Worker proxy for the Structural Content cascade demo.
// Calls Claude on Amazon Bedrock with IAM keys held as Worker secrets. Two routes:
//   POST /v1/cascade — the ranked diagnosis (fast, compact), shape `cascade-v3`
//   POST /v1/brief   — the full campaign brief for ONE opportunity, generated only
//                      when the visitor opens it, shape `brief-v1`
// Both prompts are bundled into the Worker at deploy time from the gitignored
// prompts/*.md — they exceed the 5.1 kB Worker-secret limit, so they can't be
// secrets. The demo section of structuralcontent.com (index.html#demo) is the only
// intended caller.

import { BedrockError, bedrockStream } from "./bedrock";
import { JsonEvents } from "./jsonstream";
import { BRIEF_SCHEMA, DIAGNOSIS_SCHEMA, OPPORTUNITY_SCHEMA } from "./schema";
// Inlined at build time via the Text module rule in wrangler.toml. Core IP — the
// .md files are gitignored and must exist locally for `wrangler deploy` to succeed.
import SYSTEM_PROMPT from "../prompts/system-prompt.md";
import BRIEF_PROMPT from "../prompts/brief-prompt.md";

interface Env {
  // Dedicated IAM user limited to invoking the one model (see bedrock.ts).
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  MODEL: string;
  // Optional Worker secret: comma-separated IPs exempt from the burst limiter and the
  // usage cap (Sebastian's own connections). Loopback is always exempt for wrangler dev.
  EXEMPT_IPS?: string;
  RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // Research storage for consented runs; absent until the KV namespace is bound.
  RESEARCH?: {
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  };
  // Per-IP usage cap counter; absent until the KV namespace is bound.
  USAGE?: {
    get(key: string, type: "json"): Promise<UsageRecord | null>;
    put(key: string, value: string, opts?: { expiration?: number }): Promise<void>;
  };
}

interface UsageRecord {
  count: number;
  resetAt: number; // unix seconds — when this IP's window expires and the count resets
}

const ALLOWED_ORIGINS = [
  "https://structuralcontent.com",
  "https://www.structuralcontent.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

const DIRECTIONS = ["increase", "maintain", "decrease"];
// The brief request carries an opportunity back from the page, so it may be larger.
const MAX_BODY_BYTES = { cascade: 4096, brief: 12288 };
// Longer-window per-IP caps so the demo can't be used as an ongoing work tool.
// (The RATE_LIMITER binding only stops bursts; its window maxes out at 60s.)
// Briefs have their own counter so opening briefs never eats the run allowance.
const USAGE_CAP = { cascade: 10, brief: 30 };
const USAGE_WINDOW_SEC = 30 * 24 * 60 * 60; // resets 30 days after an IP's first run
const LOOPBACK_IPS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

function isExempt(env: Env, ip: string): boolean {
  const needle = ip.trim().toLowerCase();
  if (LOOPBACK_IPS.includes(needle)) return true;
  const list = (env.EXEMPT_IPS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(needle);
}
const LIMITS = {
  priority: { min: 10, max: 300 },
  name: { max: 120 },
  status_quo: { max: 80 },
  target: { max: 80 },
  deadline: { max: 80 },
  metrics: { min: 1, max: 3 },
};

interface MetricInput {
  name: string;
  direction: string;
  status_quo: string;
  target: string;
  deadline: string;
}

const SOURCES = ["example", "typed"] as const;
type Source = (typeof SOURCES)[number];

interface CascadeInput {
  priority: string;
  metrics: MetricInput[];
  consent: boolean;
  // Whether the visitor ran the prefilled example unchanged or typed their own input —
  // the page's own report (it compares the submission with its prefill); "unknown"
  // when the page sent nothing. Stored with consented research records so the canned
  // example is not mistaken for a prospect's priority.
  source: Source | "unknown";
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  origin: string | null,
): Response {
  return jsonResponse({ error: { code, message } }, status, origin);
}

function validate(raw: unknown): { input?: CascadeInput; error?: string } {
  if (typeof raw !== "object" || raw === null) return { error: "Request body must be a JSON object." };
  const body = raw as Record<string, unknown>;

  const priority = body.priority;
  if (typeof priority !== "string" || priority.trim().length < LIMITS.priority.min)
    return { error: "Please describe the strategic priority in at least a short sentence." };
  if (priority.length > LIMITS.priority.max)
    return { error: `The priority must be at most ${LIMITS.priority.max} characters.` };

  const metrics = body.metrics;
  if (!Array.isArray(metrics) || metrics.length < LIMITS.metrics.min || metrics.length > LIMITS.metrics.max)
    return { error: "Provide between 1 and 3 metrics under pressure." };

  const cleaned: MetricInput[] = [];
  for (const m of metrics) {
    if (typeof m !== "object" || m === null) return { error: "Each metric must be an object." };
    const metric = m as Record<string, unknown>;
    const name = metric.name;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > LIMITS.name.max)
      return { error: "Each metric needs a name (up to 120 characters)." };
    const direction = metric.direction;
    if (typeof direction !== "string" || !DIRECTIONS.includes(direction))
      return { error: "Each metric's required change must be increase, maintain, or decrease." };
    for (const field of ["status_quo", "target", "deadline"] as const) {
      const v = metric[field];
      if (typeof v !== "string" || v.length > LIMITS[field].max)
        return { error: `Each metric's ${field.replace("_", " ")} must be a string of up to 80 characters.` };
    }
    cleaned.push({
      name: name.trim(),
      direction,
      status_quo: (metric.status_quo as string).trim(),
      target: (metric.target as string).trim(),
      deadline: (metric.deadline as string).trim(),
    });
  }

  return {
    input: {
      priority: priority.trim(),
      metrics: cleaned,
      consent: body.consent === true,
      source: SOURCES.includes(body.source as Source) ? (body.source as Source) : "unknown",
    },
  };
}

// Shape check for an opportunity the page sends back to /v1/brief. It is the
// diagnosis call's own output, so it must match OPPORTUNITY_SCHEMA exactly: closed
// objects, every field present, enums respected. Size is bounded by the request's
// byte cap (MAX_BODY_BYTES.brief), not per field — the diagnosis call holds no field
// to a character limit, so a per-field cap could reject a valid opportunity.
function checkShape(schema: any, value: unknown): boolean {
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== schema.required.length) return false;
    return schema.required.every((k: string) => k in obj && checkShape(schema.properties[k], obj[k]));
  }
  return false;
}

// Length backstop, in ONE table: the prompts set these list lengths, but structured
// outputs can't express minItems/maxItems, so every streamed event and the final body
// pass through limitItem / limitField / limitBody. The page renders streamed events
// directly, so a cap applied only to the final body would not reach it.
// Keys are root-level lists, or "parent.child" for a list inside a root-level value
// (a list element's object, or a root object field).
const LIST_LIMITS: Record<Route, Record<string, number>> = {
  cascade: { required_changes: 3, opportunities: 3, below_the_line: 3 },
  brief: {
    target_queries: 4, ai_questions: 3, pieces: 3, dependencies: 3,
    "pieces.establishes": 4, "problem.evidence": 3,
  },
};

// Lists nested inside one element or field value, capped from the same table.
function limitNested(route: Route, key: string, value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  let out = value;
  for (const [path, max] of Object.entries(LIST_LIMITS[route])) {
    const [parent, child] = path.split(".");
    if (parent === key && child && Array.isArray(value[child])) {
      out = { ...out, [child]: value[child].slice(0, max) };
    }
  }
  return out;
}

// An element of a root-level list: dropped past the list's limit, nested lists capped.
function limitItem(route: Route, key: string, index: number, value: unknown): unknown | undefined {
  const max = LIST_LIMITS[route][key];
  if (max !== undefined && index >= max) return undefined;
  return limitNested(route, key, value);
}

// A complete root-level field: lists cut to their limit, nested lists capped.
function limitField(route: Route, key: string, value: unknown): unknown {
  const max = LIST_LIMITS[route][key];
  if (max !== undefined && Array.isArray(value)) {
    return value.slice(0, max).map((v) => limitNested(route, key, v));
  }
  return limitNested(route, key, value);
}

function limitBody(route: Route, body: Record<string, unknown>): Record<string, any> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) out[key] = limitField(route, key, value);
  return out;
}

// The response shapes the page expects; the page refuses anything else with a
// "this page is out of date" notice, so a site/worker deploy skew is explicit.
const CASCADE_SHAPE = "cascade-v3";
const BRIEF_SHAPE = "brief-v1";

type Route = "cascade" | "brief";

// One model call. Structured outputs constrain the JSON to the route's schema; the
// prospect's input stays in the user turn only — data, never instructions.
const CALLS: Record<Route, { system: string; schema: unknown; max_tokens: number }> = {
  cascade: { system: SYSTEM_PROMPT, schema: DIAGNOSIS_SCHEMA, max_tokens: 6000 },
  brief: { system: BRIEF_PROMPT, schema: BRIEF_SCHEMA, max_tokens: 6000 },
};

function streamModel(env: Env, route: Route, modelInput: unknown) {
  const call = CALLS[route];
  return bedrockStream(env, {
    max_tokens: call.max_tokens,
    system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: call.schema } },
    messages: [{ role: "user", content: JSON.stringify(modelInput) }],
  });
}

// Every call that reaches the model counts toward the per-IP cap — refusals,
// truncations and unparsable output included — because the cap bounds spend.
function countRun(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  route: Route,
  ip: string,
  exempt: boolean,
): void {
  if (exempt || !env.USAGE || ip === "unknown") return;
  ctx.waitUntil(incrementUsage(env, usageKey(route, ip)));
}

function usageKey(route: Route, ip: string): string {
  return route === "cascade" ? `runs:${ip}` : `briefs:${ip}`;
}

// Best-effort per-IP counter. KV get-then-put isn't atomic: requests that overlap
// (e.g. several briefs opened at once) can lose increments, so a cap can be exceeded
// by the number of parallel requests the burst limiter lets through (5 per 60 s).
// Accepted: the caps bound spend loosely, not exactly. Uses an
// absolute `expiration` so the 30-day window stays anchored to the first call
// rather than sliding forward on every increment.
async function incrementUsage(env: Env, key: string): Promise<void> {
  if (!env.USAGE) return;
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.USAGE.get(key, "json");
  const record: UsageRecord =
    existing && existing.resetAt - now > 60
      ? { count: existing.count + 1, resetAt: existing.resetAt }
      : { count: 1, resetAt: now + USAGE_WINDOW_SEC };
  await env.USAGE.put(key, JSON.stringify(record), { expiration: record.resetAt });
}

function storeResearch(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  route: Route,
  record: Record<string, unknown>,
): void {
  if (!env.RESEARCH) return;
  ctx.waitUntil(
    env.RESEARCH.put(
      `${route === "cascade" ? "run" : "brief"}:${Date.now()}:${crypto.randomUUID()}`,
      JSON.stringify({ ts: new Date().toISOString(), ...record }),
      { expirationTtl: 31536000 }, // 1 year
    ).catch((e) => console.log("research put failed:", e instanceof Error ? e.message : String(e))),
  );
}

function upstreamError(err: unknown, route: Route, origin: string | null): Response {
  // Bedrock throttles with 429 and reports an unavailable model with 503.
  if (err instanceof BedrockError && [429, 503].includes(err.status)) {
    return errorResponse("upstream_busy", "High demand right now — please try again in a minute.", 429, origin);
  }
  console.log(`${route} error:`, err instanceof Error ? err.message : String(err));
  return errorResponse("engine_error", "The engine hiccuped — please try again.", 502, origin);
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const route: Route | null =
      url.pathname === "/v1/cascade" ? "cascade" : url.pathname === "/v1/brief" ? "brief" : null;
    if (request.method !== "POST" || !route) {
      return errorResponse("not_found", "Not found.", 404, origin);
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return errorResponse("forbidden", "Origin not allowed.", 403, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const exempt = isExempt(env, ip);
    const { success } = exempt ? { success: true } : await env.RATE_LIMITER.limit({ key: `${route}:${ip}` });
    if (!success) {
      return errorResponse(
        "rate_limited",
        "High demand right now — please try again in a minute.",
        429,
        origin,
      );
    }

    // Longer-window cap: the demo is for evaluation, not ongoing content work.
    if (!exempt && env.USAGE && ip !== "unknown") {
      const now = Math.floor(Date.now() / 1000);
      const usage = await env.USAGE.get(usageKey(route, ip), "json");
      if (usage && usage.resetAt > now && usage.count >= USAGE_CAP[route]) {
        return errorResponse(
          "usage_limited",
          "You've reached this demo's limit. The full Structural Content system runs continuously on your own stack — get in touch to see it on your real priorities.",
          429,
          origin,
        );
      }
    }

    const maxBytes = MAX_BODY_BYTES[route];
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > maxBytes) {
      return errorResponse("too_large", "Request too large.", 400, origin);
    }

    let raw: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > maxBytes) {
        return errorResponse("too_large", "Request too large.", 400, origin);
      }
      raw = JSON.parse(text);
    } catch {
      return errorResponse("bad_json", "Request body must be valid JSON.", 400, origin);
    }

    // Shape handshake, first thing after parsing: a page that expects another response
    // shape is refused before validation (its input contract may differ too) and before
    // the model is called, so a stale page costs nothing and shows the reload notice.
    // `shape` is absent from pages built before 6 Oct 2026; they keep their own check.
    const shape = route === "cascade" ? CASCADE_SHAPE : BRIEF_SHAPE;
    const wanted = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).shape : undefined;
    if (wanted !== undefined && wanted !== null && wanted !== shape) {
      return errorResponse("out_of_date", "This page is out of date – please reload it and run again.", 409, origin);
    }

    const { input, error } = validate(raw);
    if (!input) return errorResponse("invalid_input", error ?? "Invalid input.", 400, origin);

    const opportunity = (raw as Record<string, unknown>).opportunity;
    if (route === "brief" && !checkShape(OPPORTUNITY_SCHEMA, opportunity)) {
      return errorResponse("invalid_input", "That opportunity can't be expanded — run the demo again.", 400, origin);
    }

    const modelInput =
      route === "cascade"
        ? { priority: input.priority, metrics: input.metrics }
        : { priority: input.priority, metrics: input.metrics, opportunity };

    // Bedrock refusing the request (throttled, misconfigured) is known before any
    // byte is streamed, so it still gets a normal HTTP error.
    const started = Date.now();
    let upstream: Awaited<ReturnType<typeof streamModel>>;
    try {
      upstream = await streamModel(env, route, modelInput);
    } catch (err) {
      return upstreamError(err, route, origin);
    }

    // From here the answer streams to the page as NDJSON, one event per line:
    //   {type:"start", schema}            — first, so the page can check the shape
    //   {type:"item", key, index, value}  — a finished card (or list entry)
    //   {type:"field", key, value}        — a finished top-level field
    //   {type:"done", body}               — the whole answer, strictly parsed
    //   {type:"error", error:{code,message}}
    const encoder = new TextEncoder();
    let cancelled = false;
    const out = new ReadableStream<Uint8Array>({
      // The visitor closed the page or aborted: stop reading Bedrock's stream so the
      // generation is not paid for to the end, and stop writing to a closed stream.
      cancel() {
        cancelled = true;
        upstream.events.return(undefined).catch(() => {});
      },
      async start(controller) {
        const send = (event: unknown) => {
          if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        const fail = (code: string, message: string) => send({ type: "error", error: { code, message } });
        send({ type: "start", schema: shape });

        // The model has been paid for from here on, whatever comes back.
        countRun(env, ctx, route, ip, exempt);

        let text = "";
        let stop: string | null = null;
        let usage: unknown = null;
        let model: string | null = null;
        let sawFinalUsage = false; // output tokens arrive with the final message_delta
        // One log line per paid call, whatever the outcome, so spend and failures are
        // both visible in the worker log.
        const logRun = (outcome: string, extra: Record<string, unknown> = {}) =>
          console.log(
            JSON.stringify({
              route,
              outcome,
              request_id: upstream.requestId,
              model,
              ms: Date.now() - started,
              usage,
              metrics: input.metrics.length,
              consent: input.consent,
              source: input.source,
              ...extra,
            }),
          );
        const json = new JsonEvents();
        try {
          for await (const ev of upstream.events) {
            if (ev.type === "message_start") {
              model = ev.message?.model ?? null;
              usage = ev.message?.usage ?? null;
            } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              text += ev.delta.text;
              for (const part of json.push(ev.delta.text)) {
                if (part.type === "item") {
                  const value = limitItem(route, part.key, part.index, part.value);
                  if (value !== undefined) send({ ...part, value });
                } else {
                  send({ ...part, value: limitField(route, part.key, part.value) });
                }
              }
            } else if (ev.type === "message_delta") {
              sawFinalUsage = true;
              stop = ev.delta?.stop_reason ?? stop;
              usage = { ...(usage as object), ...ev.usage };
            }
          }
          // The visitor aborted: the loop ended early on a partial answer — not an error.
          if (cancelled) {
            // Output tokens arrive with the final message_delta, so an abort usually logs
            // input usage only (usage_partial says which); Bedrock still bills what was
            // generated before the cancel.
            logRun("aborted", { usage_partial: !sawFinalUsage });
            return;
          }

          if (stop === "refusal") {
            const refusal =
              route === "cascade"
                ? "This tool turns business priorities into ranked content opportunities — give it a real strategic priority and a metric under pressure, and it will show you what it finds."
                : "This brief can only be written for a real business opportunity — run the demo with a real priority and metric.";
            send({ type: "done", body: { schema: shape, refusal } });
            logRun("refusal");
          } else if (stop === "max_tokens") {
            logRun("too_long");
            fail(
              "too_long",
              route === "cascade"
                ? "That diagnosis ran long — please try again, with fewer metrics if you entered several."
                : "That brief ran long — please try again.",
            );
          } else if (!text) {
            logRun("empty");
            fail("empty", "The engine returned nothing — try again.");
          } else {
            const parsed = JSON.parse(text);
            const body: Record<string, any> = { ...limitBody(route, parsed), schema: shape };
            send({ type: "done", body });
            logRun(body.refusal ? "refusal" : "ok", {
              items: route === "cascade" ? body.opportunities?.length : body.pieces?.length,
            });
            // Consented research storage — best-effort, never blocks the response. Runs
            // only: the consent text and privacy notice cover the submission and its
            // generated result, not the briefs opened afterwards.
            if (route === "cascade" && input.consent && !body.refusal) {
              storeResearch(env, ctx, route, {
                input: modelInput,
                source: input.source,
                output: body,
                model,
              });
            }
          }
        } catch (err) {
          logRun("error", { error: err instanceof Error ? err.message : String(err) });
          const busy = err instanceof BedrockError && [429, 503].includes(err.status);
          fail(
            busy ? "upstream_busy" : "engine_error",
            busy ? "High demand right now — please try again in a minute." : "The engine hiccuped — please try again.",
          );
        }
        if (!cancelled) controller.close();
      },
    });

    return new Response(out, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
        ...corsHeaders(origin),
      },
    });
  },
};
