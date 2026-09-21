// JSON schema for the cascade response (structured outputs).
// Constraint notes: structured outputs require additionalProperties:false on every
// object and every field listed in required; minItems/maxItems are unsupported,
// so depth bounds (1-3 metrics, 1-2 owners, 1-2 findings) live in the system prompt
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
              required: ["function", "findings"],
              properties: {
                function: { type: "string" },
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["trace", "usual", "problem", "brief"],
                    properties: {
                      trace: {
                        type: "string",
                        description:
                          "'System · short context' — the single system a live installation would most plausibly find this problem in, e.g. 'CRM · paid-search leads', 'Support · onboarding queue', 'ATS · offer stage'.",
                      },
                      usual: {
                        type: "string",
                        description:
                          "The request a team would usually work from today for this problem — generic, in the owning team's own words, at most 12 words, no numbers, e.g. 'We need to improve our employer brand.'",
                      },
                      problem: {
                        type: "string",
                        description:
                          "The problem statement: 1-2 sentences, at most 45 words. Segment + funnel stage, the observed gap versus target or benchmark (with figures), and the cause as the named system records it. Describes a business gap, never missing content.",
                      },
                      brief: {
                        type: "object",
                        additionalProperties: false,
                        required: ["title", "campaign", "audience", "target", "impact"],
                        properties: {
                          title: {
                            type: "string",
                            description: "Imperative campaign name, at most 60 characters.",
                          },
                          campaign: {
                            type: "string",
                            description:
                              "What gets made and where it goes — the concrete package and its placement, at most 14 plain words, e.g. 'Pricing explainer + \"What is included\" guide, placed in the paid-search path'.",
                          },
                          audience: {
                            type: "string",
                            description: "The segment this campaign must move — at most 10 plain words, no channel.",
                          },
                          target: {
                            type: "string",
                            description:
                              "The campaign's own metric move as a delta with a timeframe, e.g. 'Opportunity conversion 5% → 10% by Q1'.",
                          },
                          impact: {
                            type: "string",
                            description:
                              "The business-outcome tie, at most 10 words, e.g. '+300 qualified leads to pipeline', '€30k ARR recovered'.",
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
  },
} as const;
