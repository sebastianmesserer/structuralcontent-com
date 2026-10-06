// Claude on Amazon Bedrock via the InvokeModel API (bedrock-runtime, streamed), signed with SigV4
// using a dedicated IAM user's long-lived keys. Chosen over the newer Messages-API
// ("Mantle") endpoint because only this one supports structured outputs: with
// `output_config.format` the model's JSON is constrained to the route's schema at decode
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

// One event of the Messages API stream (message_start, content_block_delta, …), as
// Bedrock relays it inside each event-stream chunk.
export type StreamEvent = { type: string; [key: string]: any };

// Carries the upstream HTTP status so the caller can map throttling to a friendly 429.
export class BedrockError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Streams one model call (InvokeModelWithResponseStream). Throws BedrockError before
// the first event if Bedrock refuses the request; afterwards yields the Messages API
// events in order. Streaming exists so the page can show each finished card as soon
// as it is generated, instead of waiting ~30 s for the whole answer.
export async function bedrockStream(
  env: BedrockEnv,
  body: Record<string, unknown>,
): Promise<{ requestId: string | null; events: AsyncGenerator<StreamEvent> }> {
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
  const url =
    `https://bedrock-runtime.${env.AWS_REGION}.amazonaws.com/model/` +
    `${encodeURIComponent(env.MODEL)}/invoke-with-response-stream`;
  const res = await aws.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/vnd.amazon.eventstream",
      "x-amzn-bedrock-accept": "application/json",
    },
    body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", ...body }),
  });
  const requestId = res.headers.get("x-amzn-requestid");
  if (!res.ok || !res.body) {
    const detail = (await res.text()).slice(0, 300);
    throw new BedrockError(res.status, `bedrock ${res.status} (request ${requestId ?? "?"}): ${detail}`);
  }
  return { requestId, events: decodeEvents(res.body) };
}

// AWS event-stream framing: [total len u32][headers len u32][prelude crc u32]
// [headers][payload][message crc u32]. TLS already guarantees integrity, so the CRCs
// are not re-checked. A chunk's payload is {"bytes": base64(Messages API event JSON)};
// an exception message's payload carries the error.
async function* decodeEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  const text = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
      for (;;) {
        if (buf.length < 12) break;
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const total = view.getUint32(0);
        if (buf.length < total) break;
        const headersLen = view.getUint32(4);
        const headers = parseHeaders(buf.subarray(12, 12 + headersLen));
        const payload = text.decode(buf.subarray(12 + headersLen, total - 4));
        buf = buf.subarray(total);
        if (headers[":message-type"] === "exception" || headers[":message-type"] === "error") {
          const kind = headers[":exception-type"] ?? headers[":error-code"] ?? "exception";
          const status = /throttl/i.test(kind) ? 429 : /unavailable|overload/i.test(kind) ? 503 : 502;
          throw new BedrockError(status, `bedrock stream ${kind}: ${payload.slice(0, 300)}`);
        }
        if (headers[":event-type"] !== "chunk") continue;
        const bytes = JSON.parse(payload).bytes as string;
        yield JSON.parse(text.decode(Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))));
      }
      if (done) {
        // A partial frame left over means the upstream stream was cut mid-message.
        if (buf.length) throw new BedrockError(502, `bedrock stream truncated (${buf.length} bytes left)`);
        return;
      }
    }
  } finally {
    // Runs on normal end, error, or the caller's return() after a client abort.
    reader.cancel().catch(() => {});
  }
}

// Event-stream header block: [name len u8][name][type u8][value]. Only string values
// (type 7) are read; other types are skipped by their fixed or prefixed length.
function parseHeaders(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  const out: Record<string, string> = {};
  let i = 0;
  while (i < bytes.length) {
    const nameLen = view.getUint8(i);
    const name = text.decode(bytes.subarray(i + 1, i + 1 + nameLen));
    i += 1 + nameLen;
    const type = view.getUint8(i);
    i += 1;
    const fixed: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
    if (type === 6 || type === 7) {
      const len = view.getUint16(i);
      if (type === 7) out[name] = text.decode(bytes.subarray(i + 2, i + 2 + len));
      i += 2 + len;
    } else {
      i += fixed[type] ?? 0;
    }
  }
  return out;
}
