# System prompt — not in this repo

The cascade system prompt (`system-prompt.md` in this directory) encodes the
BJTBD grammar and inference logic. It is **gitignored** — this repo is public —
and lives in two places only:

1. Locally, on Sebastian's machine, at `worker/prompts/system-prompt.md`.
2. In Cloudflare, as the Worker secret `SYSTEM_PROMPT`.

## Deploy / update the prompt

```bash
cd worker
npx wrangler secret put SYSTEM_PROMPT < prompts/system-prompt.md
# or: npm run put-prompt
```

Prompt changes take effect immediately — no code deploy, no commit.

## Local dev

`wrangler dev` reads secrets from `worker/.dev.vars` (also gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
SYSTEM_PROMPT="...single line, \n-escaped..."
```

Generate the single-line value with:

```bash
node -e 'console.log("SYSTEM_PROMPT=" + JSON.stringify(require("fs").readFileSync("prompts/system-prompt.md","utf8")))' >> .dev.vars
```

## Model

`MODEL` is a plain var in `wrangler.toml` — default `claude-opus-4-8` (quality
demo). Switch to `claude-sonnet-4-6` there for lower cost/latency, then
`npx wrangler deploy`.

## Research storage (consented runs)

Runs where the user ticked the consent checkbox are stored (input + cascade,
1-year TTL) in the `RESEARCH` KV namespace. Before the first deploy:

```bash
npx wrangler kv namespace create RESEARCH
# paste the printed id into [[kv_namespaces]] in wrangler.toml
```

Inspect stored runs: `npx wrangler kv key list --binding RESEARCH --remote`.
