// JSON schemas for the two demo calls (structured outputs on Bedrock InvokeModel).
// Constraint notes: structured outputs require additionalProperties:false on every
// object and every field listed in required; minItems/maxItems are unsupported, so
// list lengths (3 opportunities, 2-3 below the line, 2-3 pieces, …) live in the
// prompts and are defensively truncated in index.ts.
//
// Call 1, /v1/cascade → DIAGNOSIS_SCHEMA: the ranked diagnosis, fast and compact.
// Call 2, /v1/brief   → BRIEF_SCHEMA: the full campaign brief for ONE opportunity,
// generated only when the visitor opens it (one opportunity = one brief).

const str = { type: "string" } as const;
const strList = { type: "array", items: str } as const;
const level = { type: "string", enum: ["high", "medium", "low"] } as const; // below-the-line confidence

// One ranked opportunity, as the page shows it: the usual request against what the
// product finds (two symmetric quotes), the campaign-brief ticket that answers it, and
// the lift it brings to the prospect's stated metric. Also the shape /v1/brief
// accepts back as its input.
export const OPPORTUNITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["metric", "usual", "finding", "brief", "lift"],
  properties: {
    metric: str,
    usual: str,
    finding: str,
    brief: {
      type: "object",
      additionalProperties: false,
      required: ["title", "campaign", "audience", "target"],
      properties: { title: str, campaign: str, audience: str, target: str },
    },
    lift: {
      type: "object",
      additionalProperties: false,
      required: ["value", "unit", "context"],
      properties: { value: str, unit: str, context: str },
    },
  },
} as const;

export const DIAGNOSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refusal", "priority", "required_changes", "opportunities", "below_the_line"],
  properties: {
    refusal: { anyOf: [str, { type: "null" }] },
    priority: str,
    required_changes: strList,
    opportunities: { type: "array", items: OPPORTUNITY_SCHEMA },
    below_the_line: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "stake", "confidence"],
        properties: { title: str, stake: str, confidence: level },
      },
    },
  },
} as const;

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "refusal", "title", "for", "target", "problem", "contribution", "target_queries",
    "ai_questions", "pieces", "success_measure", "effort", "dependencies",
  ],
  properties: {
    refusal: { anyOf: [str, { type: "null" }] },
    title: str,
    for: str,
    target: str,
    problem: {
      type: "object",
      additionalProperties: false,
      required: ["current_state", "evidence"],
      properties: {
        current_state: str,
        evidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pointer", "finding"],
            properties: { pointer: str, finding: str },
          },
        },
      },
    },
    contribution: str,
    target_queries: strList,
    ai_questions: strList,
    pieces: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "format", "channel", "headline", "establishes"],
        properties: { title: str, format: str, channel: str, headline: str, establishes: strList },
      },
    },
    success_measure: str,
    effort: {
      type: "object",
      additionalProperties: false,
      required: ["size", "note"],
      properties: { size: { type: "string", enum: ["S", "M", "L"] }, note: str },
    },
    dependencies: strList,
  },
} as const;
