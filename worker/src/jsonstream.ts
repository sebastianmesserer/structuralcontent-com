// Incremental reader for ONE JSON object arriving in text pieces (the model's
// structured output, streamed). It reports each part of the object the moment that
// part is complete, so the page can render a finished card while the rest is still
// being generated:
//
//   { type: "item",  key, index, value }  — element `index` of the root's array `key`
//   { type: "field", key, value }         — the root's field `key`, once complete
//
// It only tracks where values start and end (strings, escapes, nesting). Every value
// it reports is the exact slice of the text, parsed with strict JSON.parse — nothing
// is guessed or repaired. The caller still parses the whole text strictly at the end.

export type JsonEvent =
  | { type: "item"; key: string; index: number; value: unknown }
  | { type: "field"; key: string; value: unknown };

export class JsonEvents {
  private buf = "";
  private pos = 0;
  private stack: string[] = []; // open containers: "{" or "["
  private inString = false;
  private escaped = false;
  private expectKey = false; // inside the root object, before a key
  private keyStart = -1;
  private key: string | null = null;
  private valueStart = -1; // start of the current root field's value
  private itemStart = -1; // start of the current element of a root-level array
  private itemIndex = 0;

  push(text: string): JsonEvent[] {
    this.buf += text;
    const out: JsonEvent[] = [];
    for (; this.pos < this.buf.length; this.pos++) {
      const c = this.buf[this.pos];
      const depth = this.stack.length;

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') {
          this.inString = false;
          if (depth === 1 && this.keyStart >= 0) {
            this.key = JSON.parse(this.buf.slice(this.keyStart, this.pos + 1));
            this.keyStart = -1;
          }
        }
        continue;
      }

      if (c === '"') {
        this.inString = true;
        if (depth === 1 && this.expectKey) {
          this.keyStart = this.pos;
          this.expectKey = false;
        } else this.markStart();
      } else if (c === "{" || c === "[") {
        this.markStart();
        this.stack.push(c);
        if (this.stack.length === 1) this.expectKey = true;
        if (this.stack.length === 2 && c === "[") this.itemIndex = 0;
      } else if (c === "}" || c === "]") {
        if (depth === 2 && this.stack[1] === "[") this.closeItem(out);
        if (depth === 1) this.closeField(out);
        this.stack.pop();
      } else if (c === ",") {
        if (depth === 2 && this.stack[1] === "[") this.closeItem(out);
        if (depth === 1) {
          this.closeField(out);
          this.expectKey = true;
        }
      } else if (c !== ":" && !/\s/.test(c)) {
        this.markStart(); // a number, true, false or null
      }
    }
    return out;
  }

  // A value begins at the current position: note it if it is a root field's value or
  // an element of a root-level array.
  private markStart(): void {
    const depth = this.stack.length;
    if (depth === 1 && this.valueStart < 0) this.valueStart = this.pos;
    if (depth === 2 && this.stack[1] === "[" && this.itemStart < 0) this.itemStart = this.pos;
  }

  private closeItem(out: JsonEvent[]): void {
    if (this.itemStart < 0 || this.key === null) return;
    const value = JSON.parse(this.buf.slice(this.itemStart, this.pos));
    out.push({ type: "item", key: this.key, index: this.itemIndex++, value });
    this.itemStart = -1;
  }

  private closeField(out: JsonEvent[]): void {
    if (this.valueStart < 0 || this.key === null) return;
    // An array or object value ends at the bracket just before this delimiter.
    const value = JSON.parse(this.buf.slice(this.valueStart, this.pos));
    out.push({ type: "field", key: this.key, value });
    this.valueStart = -1;
    this.key = null;
  }
}
