# System prompt — not in this repo

The cascade system prompt (`system-prompt.md` in this directory) encodes the
inference logic that turns a priority and its metrics into problem statements and
campaign briefs. It is **gitignored** — this repo is public — and lives only on
Sebastian's machine at `worker/prompts/system-prompt.md`.

## How it reaches production

The prompt is **bundled into the Worker at deploy time** as a Text module: the
`rules` block in `wrangler.toml` plus `import SYSTEM_PROMPT from
"../prompts/system-prompt.md"` in `src/index.ts`. At ~10 kB it exceeds Cloudflare's
5.1 kB Worker-secret limit, so it cannot be a secret. Cloudflare does not serve the
script bundle publicly.

To change it: edit the file, then

```bash
cd worker
npx wrangler deploy
```

There is no separate secret push. `wrangler deploy` fails if the file is missing.

## Local dev

`wrangler dev` bundles the prompt the same way. `worker/.dev.vars` (also gitignored)
only needs the API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Wrangler does not hot-reload `.dev.vars`; restart `wrangler dev` after editing it.

## Model

`MODEL` is a plain var in `wrangler.toml` — default `claude-opus-4-8` (quality
demo). Switch to `claude-sonnet-4-6` there for lower cost/latency, then
`npx wrangler deploy`.

## Research storage (consented runs)

Runs where the user ticked the consent checkbox are stored (input + cascade,
1-year TTL) in the `RESEARCH` KV namespace. Inspect stored runs:
`npx wrangler kv key list --binding RESEARCH --remote`.
