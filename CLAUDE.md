# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`structuralcontent.com` — the marketing site for Structural Content, plus the
Cloudflare Worker backend that powers its "cascade" sales demo. Two independent
deployables in one repo:

- **The site** (repo root): a static one-page site. `index.html` (inline CSS +
  JS, no build step) plus the standalone `impressum.html` and `privacy.html`
  legal pages, `Media/`, `favicon.ico`. Served by **GitHub Pages** from `main`
  at path `/`. `CNAME` pins the domain and `.nojekyll` disables Jekyll
  processing. (`examples-anim-preview.html` is gitignored local scratch, not
  part of the deployed site.)
- **The worker** (`worker/`): a Cloudflare Worker that proxies the cascade demo
  to Claude on Amazon Bedrock, holding the AWS keys as Worker secrets and the system
  prompt as a bundled Text module (see "Secrets and gitignored IP" below).

There is no build, lint, or test tooling for the static site — edit the HTML
directly.

## Shipping a site edit

Edit the files, then push — Pages auto-redeploys in ~1 min:

```bash
python3 -m http.server   # preview locally at http://localhost:8000 first
git add -A && git commit && git push origin main
```

Hosting details (DNS at Namecheap, GitHub Pages IPs, HTTPS enforcement) are in
the `structuralcontent-deploy` memory.

## Working on the worker

```bash
cd worker
npm install
wrangler dev      # local; reads the AWS keys from worker/.dev.vars (gitignored)
wrangler deploy   # production — bundles prompts/*.md into the script
```

The worker is **deployed and live** at `https://sc-cascade.structuralcontent.workers.dev`
(`POST /v1/cascade`, `POST /v1/brief`), and `index.html` points at it.

**Site and worker are deployed separately.** The worker tags every answer with its
shape (`cascade-v3` for the diagnosis, `brief-v1` for a brief, sent as the stream's
first event) and the page refuses any other shape with a "this page is out
of date – reload" notice. When a change alters the shape: **merge the site PR first,
wait for Pages to go live (~1 min), then `wrangler deploy`**. In that order the window
shows the reload notice; the reverse order would show the old page an empty board.
Bump the shape tag on both sides together. `account_id` is pinned in
`wrangler.toml` to the account that owns `sc-cascade` and the KV namespaces, so a
`wrangler login` that resolves to another account fails the deploy instead of silently
creating a second worker; if it fails, log in again and pick the right account.

The demo shows the **finished product**: SC finds content work in the company's own
data and ranks it. Two endpoints, both calling Claude on Bedrock (paid from AWS
credits, no Anthropic API spend) with a JSON-schema structured output:

- `POST /v1/cascade` — `{ priority, metrics[], consent }` → the **ranked diagnosis**:
  3 opportunities, ranked by stake × confidence (internally — not shown). Each is the
  usual request vs what SC finds (two symmetric prose quotes; the finding carries the
  counted segment vs its reference, the gap and the cause from the records), the
  compact campaign-brief ticket (title, campaign, For / Target) with the expected
  **lift** on the stated metric inside it (a large number plus its share of the
  required change — the ticket's impact line); plus below-the-line items. Prompt
  `prompts/system-prompt.md`, schema `DIAGNOSIS_SCHEMA`.
- `POST /v1/brief` — the same body plus one `opportunity` from the diagnosis → the
  **full campaign brief** behind its ticket's "Full brief · Open brief ▾" control (one opportunity = one brief = one campaign = one
  measure), generated only when the visitor opens it. Prompt
  `prompts/brief-prompt.md`, schema `BRIEF_SCHEMA`. The opportunity is shape-checked
  against `OPPORTUNITY_SCHEMA` before it reaches the model.

Both **stream** to the page as NDJSON (`start`, `item`, `field`, `done`, `error`):
`src/jsonstream.ts` reports each part of the model's JSON the moment it is complete
(strictly parsed slices, nothing repaired), so finished cards render while the rest is
still generating. Measured 5 Oct 2026, warm: first card ~9 s, all three ~22 s, done
~25 s; a brief's first section ~2 s, done ~22 s. Notable behaviors in `src/index.ts`:

- **CORS allowlist** (`ALLOWED_ORIGINS`) — only the production domains and
  `localhost:8000` may call it. Update this list if origins change.
- **Two-layer abuse protection per IP**: a burst guard via the unsafe
  `RATE_LIMITER` binding (5 req / 60s per route, declared in `wrangler.toml`), plus
  longer-horizon usage caps (`USAGE_CAP`: 10 runs and 30 opened briefs per 30-day
  window) counted in the `USAGE` KV namespace (`runs:<ip>`, `briefs:<ip>`). The KV
  count is best-effort (not atomic), so parallel requests can overshoot a cap slightly. Loopback (wrangler dev) is always exempt
  from both; the optional `EXEMPT_IPS` Worker secret (comma-separated) exempts
  Sebastian's own IPs in production — set it with `npx wrangler secret put
  EXEMPT_IPS`, never write an IP into the repo. Compare is by exact string, so paste
  the address exactly as Cloudflare reports it (the `ip=` line of
  `https://www.cloudflare.com/cdn-cgi/trace`), not a hand-typed IPv6 form.
- **Prospect input is data, never instructions** — it goes only in the user
  turn; the system prompt is the only instruction source.
- **Consented research storage**: when `consent === true`, the input + cascade
  are written to the `RESEARCH` KV namespace (1-year TTL), best-effort via
  `ctx.waitUntil` so it never blocks the response.
- `MODEL` is a plain var in `wrangler.toml` (default
  `global.anthropic.claude-opus-4-6-v1`, a Bedrock global inference profile). **Why Opus
  4.6, not 4.8:** structured outputs on Bedrock exist only on the legacy InvokeModel
  endpoint, and only up to Opus 4.6; the newer Messages-API endpoint (Opus 4.7+) rejects
  `output_config.format` (tested 3 Oct 2026), and free-text JSON there came back malformed
  in 18 of 20 runs. Move to a newer model once that endpoint supports structured outputs
  (or via Claude Platform on AWS). No repair/retry layers: an invalid response is an error.
- **Bedrock auth**: SigV4 via `aws4fetch` (`src/bedrock.ts`) with a dedicated IAM user's
  keys, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` Worker secrets (policy:
  `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on that one
  profile/model). `AWS_REGION` is the source region.
  Bedrock bearer tokens expire within 12 h, so they are not used.

### Schema constraint (important)

Structured outputs require `additionalProperties: false` on every object and do
**not** support `minItems`/`maxItems`. So list lengths (3 opportunities, 2–3 below
the line, 2–3 brief pieces, 2–4 queries, …) are set in the **prompts**, then
defensively capped in one table, `LIST_LIMITS` in `src/index.ts`, which every
streamed event and the final body pass through. If you change them, update all three: prompt, `LIST_LIMITS`, and any UI
assumptions.

## Secrets and gitignored IP (the repo is PUBLIC)

Never commit these — they're gitignored and must stay that way:

- `worker/prompts/system-prompt.md` (diagnosis) and `worker/prompts/brief-prompt.md`
  (brief) — the two prompts (core IP). They live only on Sebastian's machine and are
  **bundled into the Worker at deploy time** as Text modules (the `rules` block in
  `wrangler.toml` + the `import … from "../prompts/*.md"` lines in `src/index.ts`),
  because the diagnosis prompt (~11 kB) exceeds Cloudflare's 5.1 kB Worker-secret
  limit; the brief prompt rides the same way so both change by one `wrangler deploy`. To change it: edit the file and `wrangler deploy` — the
  prompt is inlined into the script bundle (which Cloudflare does not serve
  publicly). There is no separate secret push.
- `worker/.dev.vars` — local `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
  `AWS_REGION` for `wrangler dev` (the prompt is bundled, so it's no longer needed
  here). Wrangler does **not** hot-reload it; restart dev after editing.
- `References/` — strategy/positioning docs. Never publish.

## Current state of the demo

The cascade demo is **live**: the worker is deployed, `index.html` calls it at the
real `sc-cascade.structuralcontent.workers.dev` URL (`API` is defined near the
bottom of the inline script; localhost uses `http://localhost:8787/v1/cascade`),
and a production smoke test returns a real cascade. See the `cascade-demo` memory
for the design decisions already settled (don't relitigate them).

## Analytics

All three deployed pages load **Cloudflare Web Analytics** (cookieless, no consent
banner) via a beacon `<script>` before `</body>`, disclosed in `privacy.html`. The
beacon only reports from the live domain, not `localhost`. To change/remove it,
edit the `data-cf-beacon` token in `index.html`, `impressum.html`, `privacy.html`.
