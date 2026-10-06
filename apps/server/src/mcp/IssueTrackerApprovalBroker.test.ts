import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  cancelIssueWritesForSession,
  registerIssueWrite,
  releaseIssueWrite,
  resolveIssueWrite,
} from "./IssueTrackerApprovalBroker.ts";

const thread = ThreadId.make("issue-write-thread");
const environment = EnvironmentId.make("issue-write-environment");
const registration = (operationId: string) =>
  registerIssueWrite(operationId, thread, "session-1", "user-1", environment, "grant-1");

const verification = (decision: () => "accept" | "decline" | null, status = 200) =>
  Layer.mergeAll(
    Layer.mock(ServerSecretStore, {
      get: () =>
        Effect.succeed(
          Option.some(
            new TextEncoder().encode(
              JSON.stringify({
                authorization: "turn-token",
                relayUrl: "https://relay.test",
                claims: {
                  ownerUserId: "user-1",
                  environmentId: environment,
                  threadId: thread,
                  commandId: "command-1",
                  commandDigest: "a".repeat(64),
                  expiresAt: 4102444800000,
                  connections: { jira: "version-1" },
                },
              }),
            ),
          ),
        ),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ decision: decision() }, { status })),
        ),
      ),
    ),
  );

describe("issue tracker chat approval", () => {
  it.effect("resolves a paired session's response only after the relay verifies its owner", () =>
    Effect.gen(function* () {
      let relayDecision: "accept" | "decline" | null = null;
      const pending = (yield* registration("operation-1"))!;
      return yield* Effect.gen(function* () {
        expect(
          yield* resolveIssueWrite(pending.requestId, ThreadId.make("other"), undefined, "accept"),
        ).toBe(false);
        expect(yield* resolveIssueWrite(pending.requestId, thread, "user-2", "accept")).toBe(false);
        expect(
          yield* resolveIssueWrite(pending.requestId, thread, undefined, "acceptForSession"),
        ).toBe(false);
        expect(yield* resolveIssueWrite(pending.requestId, thread, undefined, "accept")).toBe(
          false,
        );
        relayDecision = "decline";
        expect(yield* resolveIssueWrite(pending.requestId, thread, undefined, "accept")).toBe(
          false,
        );
        relayDecision = "accept";
        expect(yield* resolveIssueWrite(pending.requestId, thread, undefined, "accept")).toBe(true);
        expect(yield* Deferred.await(pending.deferred)).toEqual({
          decision: "accept",
          actorUserId: "user-1",
        });
      }).pipe(
        Effect.provide(verification(() => relayDecision)),
        Effect.ensuring(releaseIssueWrite(pending.requestId, pending.deferred)),
      );
    }),
  );

  it.effect("rejects duplicate registrations without releasing the first waiter", () =>
    Effect.gen(function* () {
      const concurrent = yield* Effect.all(
        [registration("operation-2"), registration("operation-2")],
        { concurrency: 2 },
      );
      expect(concurrent.filter((entry) => entry !== null)).toHaveLength(1);
      const pending = concurrent.find((entry) => entry !== null)!;
      return yield* Effect.gen(function* () {
        const unrelated = (yield* registration("another-operation"))!;
        yield* releaseIssueWrite(pending.requestId, unrelated.deferred);
        yield* releaseIssueWrite(unrelated.requestId, unrelated.deferred);
        expect(yield* resolveIssueWrite(pending.requestId, thread, undefined, "decline")).toBe(
          true,
        );
        expect(yield* Deferred.await(pending.deferred)).toMatchObject({ decision: "decline" });
      }).pipe(
        Effect.provide(verification(() => "decline")),
        Effect.ensuring(releaseIssueWrite(pending.requestId, pending.deferred)),
      );
    }),
  );

  it.effect("keeps a pending approval retryable when relay verification is unavailable", () =>
    Effect.gen(function* () {
      const pending = (yield* registration("operation-4"))!;
      return yield* Effect.gen(function* () {
        expect(
          yield* resolveIssueWrite(pending.requestId, thread, undefined, "accept").pipe(
            Effect.provide(verification(() => "accept", 503)),
          ),
        ).toBe(false);
        expect(
          yield* resolveIssueWrite(pending.requestId, thread, undefined, "accept").pipe(
            Effect.provide(verification(() => "accept")),
          ),
        ).toBe(true);
        expect(yield* Deferred.await(pending.deferred)).toMatchObject({ decision: "accept" });
      }).pipe(Effect.ensuring(releaseIssueWrite(pending.requestId, pending.deferred)));
    }),
  );

  it.effect("cancels a pending write when its provider session ends", () =>
    Effect.gen(function* () {
      const pending = (yield* registration("operation-3"))!;
      cancelIssueWritesForSession(thread, "another-session");
      cancelIssueWritesForSession(thread, "session-1");
      expect(yield* Deferred.await(pending.deferred)).toEqual({
        decision: "cancel",
        actorUserId: null,
      });
      expect(yield* resolveIssueWrite(pending.requestId, thread, undefined, "accept")).toBe(false);
    }),
  );
});
