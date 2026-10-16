import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest, HttpServerResponse, HttpRouter } from "effect/unstable/http";
import { configuration } from "../workflowEvents/Fence.ts";
import { admit } from "../workflowEvents/Admission.ts";
import {
  WEBHOOK_PATH,
  MAX_BODY_BYTES,
  WebhookError,
  normalize,
  verify,
} from "../workflowEvents/Linear.ts";

const isWebhookError = Schema.is(WebhookError);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export const receiveWorkflowEvent = Effect.gen(function* () {
  const config = yield* configuration;
  if (!config) return yield* new WebhookError({ status: 503, code: "not_configured" });
  const request = yield* HttpServerRequest.HttpServerRequest;
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  yield* request.stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
          return yield* new WebhookError({ status: 413, code: "body_too_large" });
        chunks.push(chunk);
      }),
    ),
    Effect.mapError((e) =>
      isWebhookError(e) ? e : new WebhookError({ status: 400, code: "invalid_body" }),
    ),
  );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (
    !(yield* verify(
      bytes,
      request.headers["linear-signature"],
      Redacted.value(config.signingSecret),
    ))
  )
    return yield* new WebhookError({ status: 401, code: "invalid_signature" });
  const value = yield* decodeJson(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(() => new WebhookError({ status: 400, code: "invalid_json" })),
  );
  yield* admit(yield* normalize(value, config.applicationId));
  return HttpServerResponse.empty({ status: 200 });
}).pipe(Effect.catch((e) => Effect.succeed(HttpServerResponse.text(e.code, { status: e.status }))));
export const workflowEventsRoute = HttpRouter.add("POST", WEBHOOK_PATH, receiveWorkflowEvent);
