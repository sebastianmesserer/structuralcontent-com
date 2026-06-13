# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`structuralcontent.com` — the marketing site for Structural Content, plus the
Cloudflare Worker backend that powers its "cascade" sales demo. Two independent
deployables in one repo:

- **The site** (repo root): a static one-page site. `index.html` (inline CSS +
  JS, no build step), `impressum.html`, `Media/`, `favicon.ico`. Served by
  **GitHub Pages** from `main` at path `/`. `CNAME` pins the domain and
  `.nojekyll` disables Jekyll processing.
- **The worker** (`worker/`): a Cloudflare Worker that proxies the cascade demo
  to the Anthropic API, holding the API key and system prompt as Worker secrets.

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
wrangler dev      # local; reads secrets from worker/.dev.vars (gitignored)
wrangler deploy   # production
npm run put-prompt   # push the system prompt as a secret (no code deploy needed)
```

The worker exposes a single endpoint: `POST /v1/cascade`. It validates a
`{ priority, metrics[], consent }` body, calls the Anthropic API with a
JSON-schema structured output, and returns a "cascade" (priority → metrics →
owner functions → content-job tickets). Notable behaviors in `src/index.ts`:

- **CORS allowlist** (`ALLOWED_ORIGINS`) — only the production domains and
  `localhost:8000` may call it. Update this list if origins change.
- **Rate limiting** per IP via an unsafe `ratelimit` binding (5 req / 60s).
- **Prospect input is data, never instructions** — it goes only in the user
  turn; the system prompt is the only instruction source.
- **Consented research storage**: when `consent === true`, the input + cascade
  are written to the `RESEARCH` KV namespace (1-year TTL), best-effort via
  `ctx.waitUntil` so it never blocks the response.
- `MODEL` is a plain var in `wrangler.toml` (default `claude-opus-4-8`; switch to
  `claude-sonnet-4-6` for lower cost/latency, then redeploy).

### Schema constraint (important)

Structured outputs require `additionalProperties: false` on every object and do
**not** support `minItems`/`maxItems`. So depth bounds (1–3 metrics, 1–2 owners,
2–3 jobs) are enforced in the **system prompt**, then defensively re-truncated by
`truncateCascade()` in `src/index.ts`. If you change the depth rules, update all
three: prompt, `truncateCascade`, and any UI assumptions.

## Secrets and gitignored IP (the repo is PUBLIC)

Never commit these — they're gitignored and must stay that way:

- `worker/prompts/system-prompt.md` — the cascade system prompt (core IP). Lives
  only on Sebastian's machine and as the Cloudflare secret `SYSTEM_PROMPT`. Push
  changes with `npm run put-prompt`; they take effect immediately, no deploy.
- `worker/.dev.vars` — local `ANTHROPIC_API_KEY` + `SYSTEM_PROMPT` for
  `wrangler dev`. Wrangler does **not** hot-reload it; restart dev after editing.
  Regenerate the single-line `SYSTEM_PROMPT` value per `worker/prompts/README.md`.
- `References/` — strategy/positioning docs. Never publish.

## Current state of the demo

The cascade worker code is committed on `main`, but `index.html` was reverted to
the pre-demo version (the live page does not yet call the worker). Wiring it back
up requires deploying the worker and replacing the placeholder
`sc-cascade.YOUR-SUBDOMAIN.workers.dev` URL with the real one. See the
`cascade-demo` memory for the full resume path and the design decisions already
settled (don't relitigate them).
