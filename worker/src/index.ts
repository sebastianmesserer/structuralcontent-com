// sc-cascade — Cloudflare Worker proxy for the Structural Content cascade demo.
// Holds the API key as a Worker secret. The system prompt is bundled into the
// Worker at deploy time from the gitignored prompts/system-prompt.md — it exceeds
// the 5.1 kB Worker-secret limit, so it can't be a secret. The page at
// structuralcontent.com/cascade.html is the only intended caller.

import Anthropic, { APIError, RateLimitError } from "@anthropic-ai/sdk";
import { CASCADE_SCHEMA } from "./schema";
// Inlined at build time via the Text module rule in wrangler.toml. Core IP — the
// .md is gitignored and must exist locally for `wrangler deploy` to succeed.
import SYSTEM_PROMPT from "../prompts/system-prompt.md";

interface Env {
  ANTHROPIC_API_KEY: string;
  MODEL: string;
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
const MAX_BODY_BYTES = 4096;
// Longer-window per-IP cap so the demo can't be used as an ongoing work tool.
// (The RATE_LIMITER binding only stops bursts; its window maxes out at 60s.)
const USAGE_CAP = 10;
const USAGE_WINDOW_SEC = 30 * 24 * 60 * 60; // resets 30 days after an IP's first run
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

interface CascadeInput {
  priority: string;
  metrics: MetricInput[];
  consent: boolean;
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
    },
  };
}

// Depth rule backstop: the prompt enforces 1-2 owners and 2-3 jobs; structured
// outputs can't express minItems/maxItems, so truncate any overshoot here.
function truncateCascade(cascade: any): any {
  cascade.metrics = (cascade.metrics ?? []).slice(0, 3).map((metric: any) => ({
    ...metric,
    owners: (metric.owners ?? []).slice(0, 2).map((owner: any) => ({
      ...owner,
      jobs: (owner.jobs ?? []).slice(0, 3),
    })),
  }));
  return cascade;
}

// Best-effort per-IP run counter. KV isn't atomic, but the burst limiter caps
// per-IP concurrency, so a rare off-by-one under a race is acceptable here.
// Uses an absolute `expiration` so the 30-day window stays anchored to the
// first run rather than sliding forward on every increment.
async function incrementUsage(env: Env, ip: string): Promise<void> {
  if (!env.USAGE) return;
  const now = Math.floor(Date.now() / 1000);
  const key = `runs:${ip}`;
  const existing = await env.USAGE.get(key, "json");
  const record: UsageRecord =
    existing && existing.resetAt - now > 60
      ? { count: existing.count + 1, resetAt: existing.resetAt }
      : { count: 1, resetAt: now + USAGE_WINDOW_SEC };
  await env.USAGE.put(key, JSON.stringify(record), { expiration: record.resetAt });
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/cascade") {
      return errorResponse("not_found", "Not found.", 404, origin);
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return errorResponse("forbidden", "Origin not allowed.", 403, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return errorResponse(
        "rate_limited",
        "High demand right now — please try again in a minute.",
        429,
        origin,
      );
    }

    // Longer-window cap: the demo is for evaluation, not ongoing content work.
    if (env.USAGE && ip !== "unknown") {
      const now = Math.floor(Date.now() / 1000);
      const usage = await env.USAGE.get(`runs:${ip}`, "json");
      if (usage && usage.resetAt > now && usage.count >= USAGE_CAP) {
        return errorResponse(
          "usage_limited",
          "You've reached this demo's limit. The full Structural Content system runs continuously on your own stack — get in touch to see it on your real priorities.",
          429,
          origin,
        );
      }
    }

    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) {
      return errorResponse("too_large", "Request too large.", 400, origin);
    }

    let raw: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return errorResponse("too_large", "Request too large.", 400, origin);
      raw = JSON.parse(text);
    } catch {
      return errorResponse("bad_json", "Request body must be valid JSON.", 400, origin);
    }

    const { input, error } = validate(raw);
    if (!input) return errorResponse("invalid_input", error ?? "Invalid input.", 400, origin);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const modelInput = { priority: input.priority, metrics: input.metrics };

    try {
      const response = await client.messages.create({
        model: env.MODEL,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        output_config: {
          format: { type: "json_schema", schema: CASCADE_SCHEMA },
        },
        // Prospect input is data, never instructions — it goes only in the user turn.
        messages: [{ role: "user", content: JSON.stringify(modelInput) }],
      } as any);

      if (response.stop_reason === "refusal") {
        return jsonResponse(
          {
            refusal:
              "This tool turns business priorities into content tickets – give it a real strategic priority and a metric under pressure, and it will show you the cascade.",
            priority: input.priority,
            metrics: [],
          },
          200,
          origin,
        );
      }
      if (response.stop_reason === "max_tokens") {
        return errorResponse(
          "too_long",
          "That cascade ran long — try again with fewer metrics.",
          502,
          origin,
        );
      }

      const textBlock = response.content.find((b: any) => b.type === "text");
      if (!textBlock) {
        return errorResponse("empty", "The cascade engine returned nothing — try again.", 502, origin);
      }

      const cascade = truncateCascade(JSON.parse((textBlock as any).text));
      console.log(
        JSON.stringify({
          request_id: (response as any)._request_id ?? null,
          model: response.model,
          usage: response.usage,
          metrics: input.metrics.length,
          refused: Boolean(cascade.refusal),
          consent: input.consent,
        }),
      );

      // Consented research storage — best-effort, never blocks the response.
      if (input.consent && !cascade.refusal && env.RESEARCH) {
        const record = JSON.stringify({
          ts: new Date().toISOString(),
          input: modelInput,
          cascade,
          model: response.model,
        });
        ctx.waitUntil(
          env.RESEARCH.put(`run:${Date.now()}:${crypto.randomUUID()}`, record, {
            expirationTtl: 31536000, // 1 year
          }).catch((e) => console.log("research put failed:", e instanceof Error ? e.message : String(e))),
        );
      }

      // Count this completed run toward the per-IP cap (best-effort, non-blocking).
      if (env.USAGE && ip !== "unknown") {
        ctx.waitUntil(incrementUsage(env, ip));
      }

      return jsonResponse(cascade, 200, origin);
    } catch (err) {
      const overloaded = err instanceof APIError && err.status === 529;
      if (err instanceof RateLimitError || overloaded) {
        return errorResponse(
          "upstream_busy",
          "High demand right now — please try again in a minute.",
          429,
          origin,
        );
      }
      console.log("cascade error:", err instanceof Error ? err.message : String(err));
      return errorResponse(
        "engine_error",
        "The cascade engine hiccuped — please try again.",
        502,
        origin,
      );
    }
  },
};
