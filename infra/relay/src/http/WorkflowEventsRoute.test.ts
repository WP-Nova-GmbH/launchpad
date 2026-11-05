import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import * as Store from "../workflowSources/Store.ts";
import { RelayDb } from "../db.ts";
import { RelayConfiguration, workflowWebhookConfiguration } from "../Config.ts";
import { config } from "../workflowSources/test-fixture.ts";
import { receiveWorkflowEvent, workflowEventsRoute } from "./WorkflowEventsRoute.ts";
import { configured, issue, clock, sign, webhookConfig } from "../workflowEvents/test-fixture.ts";
import { WEBHOOK_PATH, MAX_BODY_BYTES } from "../workflowEvents/Linear.ts";
// These inputs must not reach SQL. Any database method on this mock throws.
const noDatabase = Layer.succeed(RelayDb, {} as unknown as RelayDb["Service"]);
const invoke = (request: Request) =>
  receiveWorkflowEvent.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
    Effect.provide([noDatabase, NodeCrypto.layer]),
  );
const request = (body: string, signature?: string) =>
  new Request("https://relay.test" + WEBHOOK_PATH, {
    method: "POST",
    body,
    headers: signature ? { "linear-signature": signature } : {},
  });
describe("Linear workflow HTTP receiver", () => {
  it.effect("leaves intake unavailable for missing or partial event configuration", () =>
    Effect.gen(function* () {
      expect(
        (yield* invoke(request("{}")).pipe(Effect.provideService(RelayConfiguration, config)))
          .status,
      ).toBe(503);
      expect(workflowWebhookConfiguration("app", undefined, "v1")).toBeUndefined();
      expect(
        workflowWebhookConfiguration("app", webhookConfig.linearWorkflowWebhook.signingSecret, " "),
      ).toBeUndefined();
      expect(
        workflowWebhookConfiguration("app", webhookConfig.linearWorkflowWebhook.signingSecret, "v1")
          ?.admissionEnabled,
      ).toBe(false);
    }),
  );
  it.effect.each([undefined, "abc", "z".repeat(64), "0".repeat(64)])(
    "rejects malformed/mismatched signature %# before SQL",
    (signature) =>
      configured(
        Effect.gen(function* () {
          expect((yield* invoke(request("{}", signature))).status).toBe(401);
        }),
      ),
  );
  it.effect("verifies exact raw bytes before JSON and rejects invalid envelopes", () =>
    configured(
      Effect.gen(function* () {
        const text = Store.json(issue(yield* clock));
        const signature = yield* sign(text);
        expect((yield* invoke(request(text + " ", signature))).status).toBe(401);
        expect((yield* invoke(request("not json", yield* sign("not json")))).status).toBe(400);
        expect((yield* invoke(request("{}", yield* sign("{}")))).status).toBe(400);
      }),
    ),
  );
  it.effect("bounds streamed bytes even with absent or lying Content-Length", () =>
    configured(
      Effect.gen(function* () {
        for (const declared of [undefined, "1"]) {
          let pulls = 0;
          let cancelled = false;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
            },
            cancel() {
              cancelled = true;
            },
          });
          const init: RequestInit & { duplex: string } = {
            method: "POST",
            body,
            duplex: "half",
            headers: declared ? { "content-length": declared } : {},
          };
          expect(
            (yield* invoke(new Request("https://relay.test" + WEBHOOK_PATH, init))).status,
          ).toBe(413);
          expect(pulls).toBeLessThan(5);
          expect(cancelled).toBe(true);
        }
      }),
    ),
  );
  it.effect("uses the exported public router without client authentication", () =>
    configured(
      Effect.gen(function* () {
        const route = workflowEventsRoute.pipe(
          HttpRouter.provideRequest(
            Layer.merge(noDatabase, Layer.succeed(RelayConfiguration, webhookConfig)),
          ),
        );
        const handler = yield* HttpRouter.toHttpEffect(route);
        const text = Store.json(issue((yield* clock) + 1, { type: "Comment", data: undefined }));
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request(text, yield* sign(text))),
          ),
        );
        expect(response.status).toBe(200);
      }).pipe(Effect.scoped),
    ),
  );
});
