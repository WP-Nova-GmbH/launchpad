import {
  CommandId,
  MessageId,
  type ServerConfig,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ApprovalRequestId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/unstable/http";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { IssueTrackerClientRegistry } from "../relay/issueTrackerTurn.ts";
import { ManagedRelayClient } from "../relay/managedRelay.ts";
import { managedRelaySessionAtom } from "../relay/managedRelayState.ts";
import {
  archiveThread,
  startThreadTurn,
  createProject,
  revertThreadCheckpoint,
  reorderActiveThread,
  respondToThreadApproval,
  settleThread,
  stopThreadSession,
  unsettleThread,
} from "./commands.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (
  dispatched: ClientOrchestrationCommand[],
  sharedPromptQueue = false,
) {
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: { capabilities: { sharedPromptQueue } },
    } as ServerConfig),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("environment commands", () => {
  it.effect(
    "approves an issue write with the personal relay before notifying the environment",
    () =>
      Effect.gen(function* () {
        const dispatched: ClientOrchestrationCommand[] = [];
        const supervisor = yield* makeSupervisor(dispatched);
        const registry = AtomRegistry.make();
        registry.set(managedRelaySessionAtom, {
          accountId: "alice",
          readClerkToken: () => Effect.succeed("alice-token"),
        });
        const order: string[] = [];
        const fetch: typeof globalThis.fetch = async () => {
          order.push("relay");
          expect(dispatched).toHaveLength(0);
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
        yield* respondToThreadApproval({
          threadId: ThreadId.make("thread-1"),
          requestId: ApprovalRequestId.make("issue-write:operation-1"),
          decision: "accept",
        }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(IssueTrackerClientRegistry, registry),
          Effect.provideService(ManagedRelayClient, {
            relayUrl: "https://relay.test",
          } as ManagedRelayClient["Service"]),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.ensuring(Effect.sync(() => registry.dispose())),
        );
        expect(order).toEqual(["relay"]);
        expect(dispatched).toMatchObject([{ type: "thread.approval.respond", decision: "accept" }]);
      }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("does not release an issue write when personal approval fails", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      const registry = AtomRegistry.make();
      registry.set(managedRelaySessionAtom, {
        accountId: "alice",
        readClerkToken: () => Effect.succeed("alice-token"),
      });
      const outcome = yield* respondToThreadApproval({
        threadId: ThreadId.make("thread-1"),
        requestId: ApprovalRequestId.make("issue-write:operation-1"),
        decision: "accept",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(IssueTrackerClientRegistry, registry),
        Effect.provideService(ManagedRelayClient, {
          relayUrl: "https://relay.test",
        } as ManagedRelayClient["Service"]),
        Effect.provideService(FetchHttpClient.Fetch, async () =>
          Response.json({ code: "forbidden" }, { status: 403 }),
        ),
        Effect.result,
        Effect.ensuring(Effect.sync(() => registry.dispose())),
      );
      expect(outcome._tag).toBe("Failure");
      expect(dispatched).toHaveLength(0);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  for (const shared of [false, true]) {
    it.effect(
      `uses ${shared ? "shared acceptance" : "legacy turn start"} without changing captured settings`,
      () =>
        Effect.gen(function* () {
          const dispatched: ClientOrchestrationCommand[] = [];
          const supervisor = yield* makeSupervisor(dispatched, shared);
          const input = {
            commandId: CommandId.make("stable-command"),
            threadId: ThreadId.make("thread"),
            message: {
              messageId: MessageId.make("stable-message"),
              role: "user" as const,
              text: "Do work",
              attachments: [],
            },
            runtimeMode: "full-access" as const,
            interactionMode: "plan" as const,
            createdAt: "2026-09-28T00:00:00Z",
          };
          yield* startThreadTurn(input).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          expect(dispatched).toEqual([
            { ...input, type: shared ? "thread.prompt.enqueue" : "thread.turn.start" },
          ]);
        }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
    );
  }

  it.effect("adds generated command metadata", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      const result = yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createdAt: "2026-06-06T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 1 });
      expect(dispatched).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createdAt: "2026-06-06T00:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("uses a distinct command when keeping workspace changes", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      for (const restoreFiles of [undefined, true, false]) {
        yield* revertThreadCheckpoint({
          commandId: CommandId.make("rewind-command"),
          threadId: ThreadId.make("thread-1"),
          turnCount: 0,
          ...(restoreFiles !== undefined ? { restoreFiles } : {}),
          createdAt: "2026-06-06T00:01:00.000Z",
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      }
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.checkpoint.revert",
        "thread.checkpoint.revert",
        "thread.conversation.revert",
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves caller metadata for idempotent queued commands", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* stopThreadSession({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-06-06T00:01:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.session.stop",
          commandId: "queued-command",
          threadId: "thread-1",
          createdAt: "2026-06-06T00:01:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("does not add timestamps to commands without createdAt", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* archiveThread({
        commandId: CommandId.make("archive-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.archive",
          commandId: "archive-command",
          threadId: "thread-1",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("dispatches settle and unsettle commands without timestamps", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* settleThread({
        commandId: CommandId.make("settle-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* unsettleThread({
        commandId: CommandId.make("unsettle-command"),
        threadId: ThreadId.make("thread-1"),
        reason: "user",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.settle",
          commandId: "settle-command",
          threadId: "thread-1",
        },
        {
          type: "thread.unsettle",
          commandId: "unsettle-command",
          threadId: "thread-1",
          reason: "user",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("sends an active order key without changing activity timestamps", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      yield* reorderActiveThread({
        commandId: CommandId.make("reorder-command"),
        threadId: ThreadId.make("thread-1"),
        orderKey: "mf",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(dispatched).toEqual([
        {
          type: "thread.active.reorder",
          commandId: "reorder-command",
          threadId: "thread-1",
          orderKey: "mf",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
