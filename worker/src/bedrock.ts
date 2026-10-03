// Claude on Amazon Bedrock via the InvokeModel API (bedrock-runtime), signed with SigV4
// using a dedicated IAM user's long-lived keys. Chosen over the newer Messages-API
// ("Mantle") endpoint because only this one supports structured outputs: with
// `output_config.format` the model's JSON is constrained to CASCADE_SCHEMA at decode
// time, so the response shape is guaranteed rather than checked after the fact (on
// Mantle, 18 of 20 free-text runs came back with a dropped brace, 3 Oct 2026).
// Structured outputs on Bedrock cover Opus 4.6 and earlier; the model ID is a global
// inference profile (`global.` prefix), invoked from AWS_REGION.

import { AwsClient } from "aws4fetch";

export interface BedrockEnv {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  MODEL: string;
}

export interface BedrockMessage {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage: unknown;
  requestId: string | null;
}

// Carries the upstream HTTP status so the caller can map throttling to a friendly 429.
export class BedrockError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function bedrockInvoke(env: BedrockEnv, body: Record<string, unknown>): Promise<BedrockMessage> {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: "bedrock",
    region: env.AWS_REGION,
    // aws4fetch re-sends on 429/5xx up to 10 times by default; each re-send is a paid
    // generation that can push the visitor past the page's 180 s abort. Failures
    // surface to the caller as errors instead.
    retries: 0,
  });
  const url = `https://bedrock-runtime.${env.AWS_REGION}.amazonaws.com/model/${encodeURIComponent(env.MODEL)}/invoke`;
  const res = await aws.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", ...body }),
  });
  const requestId = res.headers.get("x-amzn-requestid");
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new BedrockError(res.status, `bedrock ${res.status} (request ${requestId ?? "?"}): ${detail}`);
  }
  const json = (await res.json()) as Omit<BedrockMessage, "requestId">;
  return { ...json, requestId };
}
