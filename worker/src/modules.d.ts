// Text module imports (configured via the `rules` block in wrangler.toml).
// Lets `import SYSTEM_PROMPT from "../prompts/system-prompt.md"` typecheck as a string.
declare module "*.md" {
  const content: string;
  export default content;
}
