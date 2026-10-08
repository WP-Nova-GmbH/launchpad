import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import { ClientOrchestrationCommand, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { RpcSession } from "../rpc/session.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { PrimaryConnectionTarget, AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { FetchHttpClient } from "effect/unstable/http";
import { AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayClient } from "./managedRelay.ts";
import { managedRelaySessionAtom } from "./managedRelayState.ts";
import {
  authorizeIssueTrackerTurn,
  decideIssueTrackerWrite,
  IssueTrackerClientRegistry,
} from "./issueTrackerTurn.ts";

const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
  runtimeMode: "full-access",
  interactionMode: "default",
  type: "thread.prompt.enqueue",
  threadId: "thread",
  commandId: "command",
  createdAt: "2026-10-02T00:00:00.000Z",
  message: { messageId: "message", text: "Read WP-218", attachments: [] },
});
const environment = EnvironmentId.make("local-environment");
const dependencies = Layer.mergeAll(
  Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
      digest: (algorithm, bytes) =>
        Effect.promise(
          async () => new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes))),
        ),
    }),
  ),
  Layer.effect(
    EnvironmentSupervisor,
    Effect.gen(function* () {
      return {
        target: new PrimaryConnectionTarget({
          environmentId: environment,
          label: "Local",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      };
    }),
  ),
  Layer.mock(ManagedRelayClient, { relayUrl: "https://relay.test" }),
);

describe("personal prompt authorization", () => {
  it.effect("requests the queued entry's runtime mode when editing its prompt", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      registry.set(managedRelaySessionAtom, {
        accountId: "alice",
        readClerkToken: () => Effect.succeed("alice-token"),
      });
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ authorization: "edit-grant" });
      };
      const edit = yield* decodeClientCommand({
        type: "thread.prompt.edit",
        threadId: "thread",
        commandId: "edit-command",
        createdAt: "2026-10-02T00:00:00.000Z",
        messageId: "message",
        expectedRevision: 1,
        expectedRuntimeMode: "full-access",
        message: { text: "Edited prompt", attachments: [] },
      });
      const authorized = yield* authorizeIssueTrackerTurn(edit, "alice").pipe(
        Effect.provideService(IssueTrackerClientRegistry, registry),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.ensuring(Effect.sync(() => registry.dispose())),
      );
      expect(requests).toHaveLength(1);
      expect(yield* Effect.promise(() => requests[0]!.json())).toMatchObject({
        runtimeMode: "full-access",
      });
      expect(authorized).toMatchObject({ issueTrackerAuthorization: "edit-grant" });
    }).pipe(Effect.provide(dependencies)),
  );
  it.effect("uses the signed-in user's relay session to approve an issue write", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      registry.set(managedRelaySessionAtom, {
        accountId: "alice",
        readClerkToken: () => Effect.succeed("alice-token"),
      });
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          operationId: "operation-1",
          state: "ready",
          service: "jira",
          action: "add_comment",
          field: null,
          identifier: "LP-42",
          issueUrl: "https://example.atlassian.net/browse/LP-42",
          body: "Exact comment",
          executionAccount: "Alice",
          resultResourceId: null,
          resultUrl: null,
        });
      };
      yield* decideIssueTrackerWrite("issue-write:operation-1", "accept").pipe(
        Effect.provideService(IssueTrackerClientRegistry, registry),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.ensuring(Effect.sync(() => registry.dispose())),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://relay.test/v1/user/issue-trackers/writes/decision");
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer alice-token");
      expect(yield* Effect.promise(() => requests[0]!.json())).toEqual({
        operationId: "operation-1",
        decision: "approve",
      });
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect("requires a personal session for issue write decisions", () =>
    Effect.gen(function* () {
      const outcome = yield* decideIssueTrackerWrite("issue-write:operation-1", "accept").pipe(
        Effect.result,
      );
      expect(outcome._tag).toBe("Failure");
      expect(yield* decideIssueTrackerWrite("provider-request", "accept")).toBeUndefined();
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect.each([
    { owner: "alice", account: "bob" },
    { owner: "alice", account: null },
    { owner: null, account: "bob" },
  ])("rejects queued authorization after an account transition: %j", ({ owner, account }) =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      let requests = 0;
      registry.set(
        managedRelaySessionAtom,
        account
          ? {
              accountId: account,
              readClerkToken: () =>
                Effect.sync(() => {
                  requests++;
                  return "wrong-account-token";
                }),
            }
          : null,
      );
      const outcome = yield* authorizeIssueTrackerTurn(command, owner).pipe(
        Effect.provideService(IssueTrackerClientRegistry, registry),
        Effect.result,
        Effect.ensuring(Effect.sync(() => registry.dispose())),
      );
      expect(outcome._tag).toBe("Failure");
      expect(requests).toBe(0);
    }).pipe(Effect.provide(dependencies)),
  );
  it.effect("anonymous prompts carry no implicit personal credentials", () =>
    Effect.gen(function* () {
      expect(yield* authorizeIssueTrackerTurn(command)).toEqual(command);
    }).pipe(Effect.provide(dependencies)),
  );

  it.effect.each([false, true])(
    "binds the current account to a local prompt and rejects account switches: %s",
    (switchAccount) =>
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        registry.set(managedRelaySessionAtom, {
          accountId: "alice",
          readClerkToken: () => Effect.succeed("alice-token"),
        });
        const calls: Request[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          calls.push(request);
          if (switchAccount)
            registry.set(managedRelaySessionAtom, {
              accountId: "bob",
              readClerkToken: () => Effect.succeed("bob-token"),
            });
          return Response.json({ authorization: "alice-grant" });
        };
        const outcome = yield* authorizeIssueTrackerTurn(command, "alice").pipe(
          Effect.provideService(IssueTrackerClientRegistry, registry),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.result,
          Effect.ensuring(Effect.sync(() => registry.dispose())),
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.headers.get("authorization")).toBe("Bearer alice-token");
        const payload = yield* Effect.promise(() => calls[0]!.json());
        expect(payload).toMatchObject({
          environmentId: environment,
          threadId: "thread",
          commandId: "command",
          commandDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        if (switchAccount) expect(outcome._tag).toBe("Failure");
        else
          expect(outcome).toMatchObject({
            _tag: "Success",
            success: { issueTrackerAuthorization: "alice-grant" },
          });
      }).pipe(Effect.provide(dependencies)),
  );
});
