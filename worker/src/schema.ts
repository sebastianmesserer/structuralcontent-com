// JSON schema for the cascade response (structured outputs).
// Constraint notes: structured outputs require additionalProperties:false on every
// object and every field listed in required; minItems/maxItems are unsupported,
// so depth bounds (1-3 metrics, 1-2 owners, 1-2 findings, 2-3 messaging lines and
// 2-4 pieces per brief) live in the system prompt and are defensively truncated in
// index.ts.

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
                          "The request the owning team would usually send the content team for this problem today, written as they would paste it into Slack or a ticket: 20-35 words, first person plural, the outcome wanted in vague terms plus one or two deliverables they already have in mind and a timing hook. Never a segment, funnel stage, figure, cause from a system, or target. E.g. 'We need to strengthen our employer brand for Lisbon. Can we get a careers-page refresh and a few LinkedIn posts about the team before the Q4 push?'",
                      },
                      problem: {
                        type: "string",
                        description:
                          "The problem statement: 1-2 sentences, at most 45 words. Segment + funnel stage, the observed gap versus target or benchmark (with figures), and the cause as the named system records it. Describes a business gap, never missing content.",
                      },
                      brief: {
                        type: "object",
                        additionalProperties: false,
                        required: ["title", "campaign", "audience", "target", "impact", "detail"],
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
                          detail: {
                            type: "object",
                            additionalProperties: false,
                            required: ["objective", "audience_moment", "messaging", "pieces", "effort"],
                            description: "The expanded brief — a spec the content team executes, never drafted copy.",
                            properties: {
                              objective: {
                                type: "string",
                                description:
                                  "What the audience can do or believes once the campaign has landed — an outcome, never an activity; at most 25 words.",
                              },
                              audience_moment: {
                                type: "string",
                                description:
                                  "The reader's situation at the moment the first piece reaches them: what they hold, fear, compare, have already seen. Same segment and stage as the problem statement, no new figures; at most 30 words.",
                              },
                              messaging: {
                                type: "array",
                                description:
                                  "2-3 entries, at most 12 words each: what the campaign must establish in the reader's mind. Requirement-level, never the copy itself.",
                                items: { type: "string" },
                              },
                              pieces: {
                                type: "array",
                                description:
                                  "2-4 entries enumerating exactly the package named in `campaign`, in the order the audience meets them.",
                                items: {
                                  type: "object",
                                  additionalProperties: false,
                                  required: ["name", "where", "when"],
                                  properties: {
                                    name: { type: "string", description: "The piece, at most 6 words." },
                                    where: { type: "string", description: "Format and placement/channel, at most 8 words, e.g. 'PDF in the offer email'." },
                                    when: { type: "string", description: "Timing relative to the audience moment or a date, at most 6 words, e.g. 'day 0, with the offer'." },
                                  },
                                },
                              },
                              effort: {
                                type: "object",
                                additionalProperties: false,
                                required: ["size", "note"],
                                properties: {
                                  size: { type: "string", enum: ["S", "M", "L"], description: "Honest effort class for the whole campaign." },
                                  note: { type: "string", description: "The dependency that sets the size, at most 12 words, or an empty string." },
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
      },
    },
  },
} as const;
