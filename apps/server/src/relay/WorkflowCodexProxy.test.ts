import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  TurnId,
  type ThreadPromptHandoff,
  type ThreadPromptQueue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { openWorkflowCodexProxy } from "./WorkflowCodexProxy.ts";
import { canContinueWorkflowVmInference } from "./WorkflowVmAttempts.ts";

it("keeps the exact admitted attempt eligible through uncertain delivery until finalization", () => {
  const handoff: ThreadPromptHandoff = {
    attemptId: CommandId.make("agent-attempt"),
    messageId: MessageId.make("prompt"),
    revision: 1,
    controlRevision: 0,
    mode: "next-turn",
  };
  const queue: ThreadPromptQueue = {
    enabled: true,
    revision: 0,
    entries: [],
    handoff,
    awaitingTurnId: null,
    finalizedTurnId: null,
    pauseReason: null,
    admissions: [],
  };
  assert.isTrue(canContinueWorkflowVmInference(queue, handoff));
  const turnId = TurnId.make("native-turn");
  const admitted: ThreadPromptQueue = {
    ...queue,
    handoff: null,
    awaitingTurnId: turnId,
    admissions: [
      {
        attemptId: handoff.attemptId,
        messageId: handoff.messageId,
        turnId,
        evidence: "provider-ack",
      },
    ],
  };
  assert.isTrue(canContinueWorkflowVmInference(admitted, handoff));
  assert.isFalse(
    canContinueWorkflowVmInference({ ...admitted, enabled: false, revision: 1 }, handoff),
  );
  const uncertain: ThreadPromptQueue = {
    ...admitted,
    enabled: false,
    revision: 1,
    pauseReason: {
      code: "delivery-unknown",
      detail: "Acknowledgment lost",
      resumeOnConfirmedAttemptId: handoff.attemptId,
    },
  };
  assert.isTrue(canContinueWorkflowVmInference(uncertain, handoff));
  assert.isFalse(
    canContinueWorkflowVmInference(uncertain, { ...handoff, attemptId: CommandId.make("next") }),
  );
  assert.isFalse(
    canContinueWorkflowVmInference({ ...uncertain, finalizedTurnId: turnId }, handoff),
  );
});

it.live("streams the permitted model through the fixed upstream and revokes a copied permit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let authorized = true;
      let peerAllowed = true;
      let authorizationChecks = 0;
      let forwarded = 0;
      let inFlight: AbortSignal | null | undefined;
      const proxy = yield* openWorkflowCodexProxy(
        async () => {
          authorizationChecks++;
          return authorized ? "organization-token" : undefined;
        },
        async (url, init) => {
          forwarded++;
          assert.equal(url, "https://api.openai.com/v1/responses");
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer organization-token",
          );
          assert.isNull(new Headers(init?.headers).get("cookie"));
          assert.equal(init?.redirect, "manual");
          if (forwarded === 2) {
            inFlight = init?.signal;
            return new Response(
              new ReadableStream({
                start: (controller) =>
                  controller.enqueue(new TextEncoder().encode("data: pending\n\n")),
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response("data: streamed\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        },
      );
      const send = (path = "/responses", model = "gpt-6-astra", permit = proxy.permit) =>
        Effect.promise(() =>
          // @effect-diagnostics-next-line globalFetchInEffect:off - Exercise the native loopback listener directly.
          fetch(proxy.baseUrl + path, {
            method: "POST",
            headers: { authorization: `Bearer ${permit}`, cookie: "guest-cookie" },
            body: `{"model":"${model}","stream":true}`,
          }),
        );
      assert.equal((yield* send()).status, 401);
      proxy.activate();
      assert.equal((yield* send()).status, 401);
      proxy.bindPeer(async (listenerPort, clientPort) => {
        assert.equal(listenerPort, Number(new URL(proxy.baseUrl).port));
        assert.isAbove(clientPort, 0);
        return peerAllowed;
      });
      proxy.activate();
      assert.equal((yield* send("/models")).status, 404);
      assert.equal((yield* send("/responses", "unapproved-model")).status, 400);
      assert.equal((yield* send("/responses", "gpt-6-astra", "another-attempt")).status, 401);
      peerAllowed = false;
      assert.equal((yield* send()).status, 401);
      assert.equal(authorizationChecks, 0);
      peerAllowed = true;
      const response = yield* send();
      assert.equal(response.status, 200);
      assert.equal(yield* Effect.promise(() => response.text()), "data: streamed\n\n");
      authorized = false;
      assert.equal((yield* send()).status, 401);
      authorized = true;
      const pending = yield* send();
      const reader = pending.body!.getReader();
      assert.isFalse((yield* Effect.promise(() => reader.read())).done);
      proxy.revoke();
      assert.isTrue(inFlight?.aborted);
      proxy.activate();
      assert.equal((yield* send()).status, 401);
      assert.equal(forwarded, 2);
    }),
  ),
);
