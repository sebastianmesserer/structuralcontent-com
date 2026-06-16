// JSON schema for the cascade response (structured outputs).
// Constraint notes: structured outputs require additionalProperties:false on every
// object and every field listed in required; minItems/maxItems are unsupported,
// so depth bounds (1-3 metrics, 1-2 owners, 2-3 jobs) live in the system prompt
// and are defensively truncated in index.ts.

export const CASCADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refusal", "priority", "metrics"],
  properties: {
    refusal: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "One polite sentence when the input is not a usable business priority/metric; null otherwise.",
    },
    priority: {
      type: "string",
      description: "The strategic priority, restated cleanly in client-facing language.",
    },
    metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "required_change", "owners"],
        properties: {
          metric: { type: "string" },
          required_change: {
            type: "string",
            description:
              "Client-facing restatement: direction + metric + status-quo-to-target delta + deadline.",
          },
          owners: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["function", "jobs"],
              properties: {
                function: { type: "string" },
                jobs: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["trace", "job", "ticket"],
                    properties: {
                      trace: {
                        type: "string",
                        description:
                          "'System · short context' — the single system a live installation would most plausibly find this job in, e.g. 'CRM · Q3 renewal pipeline', 'Slack · #customer-success', 'Asana · hiring board'.",
                      },
                      job: { type: "string" },
                      ticket: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                          "title",
                          "summary",
                          "draft",
                          "audience",
                          "moves",
                          "routed_to",
                          "measure",
                          "deadline",
                        ],
                        properties: {
                          title: { type: "string" },
                          summary: {
                            type: "string",
                            description:
                              "What the content actually is — the concrete artifact, one line of at most 14 plain words.",
                          },
                          draft: {
                            type: "string",
                            description:
                              "An AI-generated first-draft (v1) of the content itself, ready for the content team to edit. For text formats: the actual usable copy (~60-90 words). For rich-media formats (video, podcast): a tight outline/script ending in a generic handoff line, e.g. '→ Hand off to your video-generation tool.' Line breaks allowed.",
                          },
                          audience: {
                            type: "string",
                            description: "Who this content must move — at most 8 plain words, no channel.",
                          },
                          moves: {
                            type: "string",
                            description:
                              "The required audience change as 'current state → required end-state', plain client-facing words.",
                          },
                          routed_to: { type: "string" },
                          measure: { type: "string" },
                          deadline: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
