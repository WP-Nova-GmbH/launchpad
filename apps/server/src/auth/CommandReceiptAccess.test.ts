import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentAuthorizationError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { RepositoryAccess } from "./RepositoryAccess.ts";
import {
  authorizeOrchestrationCommand,
  readAuthorizedCommandReceipt,
  replayAuthorizedOrchestrationCommand,
} from "./CommandReceiptAccess.ts";

const actor = { user: { userId: "teammate", displayName: null, imageUrl: null } };
const projectId = ProjectId.make("allowed");
const forbiddenProjectId = ProjectId.make("forbidden");
const threadId = ThreadId.make("thread");
const commandId = CommandId.make("command");
const createdAt = "2026-09-28T00:00:00.000Z";
const enqueue = (project = projectId): OrchestrationCommand => ({
  type: "thread.prompt.enqueue",
  commandId,
  threadId,
  createdAt,
  message: { messageId: MessageId.make("message"), text: "work", attachments: [] },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId: project,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      branch: null,
      worktreePath: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    },
  },
});

const fixture = Effect.gen(function* () {
  const base = yield* RepositoryAccess;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const state = {
    enabled: true,
    revoked: false,
    recreated: false,
    thread: undefined as ProjectionThread | undefined,
  };
  const authorizedProjects: ProjectId[] = [];
  let freshCommands = 0;
  const fail = () =>
    new EnvironmentAuthorizationError({
      message: "Denied",
      requiredScope: AuthOrchestrationReadScope,
    });
  const layer = Layer.mergeAll(
    Layer.succeed(RepositoryAccess, {
      ...base,
      status: Effect.sync(() => ({ enabled: state.enabled, ready: true, revision: 1 })),
      requireMember: () =>
        Effect.suspend(() => (state.revoked ? Effect.fail(fail()) : Effect.void)),
      requirePersistedProject: (_, id) =>
        Effect.suspend(() => {
          authorizedProjects.push(id);
          return id === projectId && !state.revoked ? Effect.void : Effect.fail(fail());
        }),
      requireCommand: () =>
        Effect.sync(() => {
          freshCommands++;
        }),
    }),
    Layer.mock(ProjectionThreadRepository)({
      getById: () => Effect.sync(() => Option.fromNullishOr(state.thread)),
    }),
    Layer.mock(OrchestrationEventStore)({
      hasEventAfter: () => Effect.sync(() => state.recreated),
    }),
  );
  const save = (status: "accepted" | "rejected", scope: ProjectId | null = projectId) =>
    receipts.upsert({
      commandId,
      aggregateKind: "thread",
      aggregateId: threadId,
      projectId: scope,
      acceptedAt: createdAt,
      resultSequence: 10,
      status,
      error: status === "rejected" ? "Rejected before thread creation" : null,
    });
  return { layer, save, state, authorizedProjects, freshCommands: () => freshCommands };
});

const testLayer = OrchestrationCommandReceiptRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);

describe("command receipt scope", () => {
  it.effect(
    "reads rejected/accepted outcomes without a thread and rejects forged scope and revoked access",
    () =>
      Effect.gen(function* () {
        const { layer, save, state, authorizedProjects } = yield* fixture;
        yield* Effect.gen(function* () {
          expect(
            Option.isNone(
              yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }),
            ),
          ).toBe(true);
          for (const status of ["rejected", "accepted"] as const) {
            yield* save(status);
            expect(
              Option.getOrNull(
                yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }),
              )?.status,
            ).toBe(status);
            expect(
              yield* readAuthorizedCommandReceipt(actor, {
                commandId,
                threadId,
                projectId: forbiddenProjectId,
              }).pipe(Effect.isFailure),
            ).toBe(true);
          }
          expect(
            Option.isNone(
              yield* readAuthorizedCommandReceipt(actor, {
                commandId,
                threadId: ThreadId.make("unrelated"),
                projectId,
              }),
            ),
          ).toBe(true);
          expect(authorizedProjects.every((id) => id === projectId)).toBe(true);
          state.revoked = true;
          expect(
            yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }).pipe(
              Effect.isFailure,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "checks persisted scope before replay and never authorizes a hidden receipt with caller scope",
    () =>
      Effect.gen(function* () {
        const { layer, save, freshCommands } = yield* fixture;
        yield* Effect.gen(function* () {
          yield* save("accepted", forbiddenProjectId);
          expect(
            yield* authorizeOrchestrationCommand(actor, enqueue()).pipe(Effect.isFailure),
          ).toBe(true);
          expect(
            yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }).pipe(
              Effect.isFailure,
            ),
          ).toBe(true);
          for (const status of ["rejected", "accepted"] as const) {
            yield* save(status);
            yield* authorizeOrchestrationCommand(actor, enqueue());
            if (status === "accepted") {
              expect(
                Option.getOrNull(yield* replayAuthorizedOrchestrationCommand(actor, enqueue())),
              ).toEqual({ sequence: 10 });
            } else {
              expect(
                yield* replayAuthorizedOrchestrationCommand(actor, enqueue()).pipe(Effect.flip),
              ).toMatchObject({ _tag: "OrchestrationCommandPreviouslyRejectedError" });
            }
            expect(
              yield* authorizeOrchestrationCommand(actor, enqueue(forbiddenProjectId)).pipe(
                Effect.isFailure,
              ),
            ).toBe(true);
          }
          expect(freshCommands()).toBe(0);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses legacy rows including deleted threads only while their incarnation still proves the receipt scope",
    () =>
      Effect.gen(function* () {
        const { layer, save, state } = yield* fixture;
        yield* Effect.gen(function* () {
          yield* save("accepted", null);
          expect(
            Option.isNone(
              yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }),
            ),
          ).toBe(true);
          state.thread = { threadId, projectId, deletedAt: createdAt } as ProjectionThread;
          expect(
            Option.isSome(
              yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }),
            ),
          ).toBe(true);
          yield* authorizeOrchestrationCommand(actor, enqueue());
          state.recreated = true;
          state.thread = { threadId, projectId, deletedAt: null } as ProjectionThread;
          expect(
            Option.isNone(
              yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }),
            ),
          ).toBe(true);
          expect(
            yield* authorizeOrchestrationCommand(actor, enqueue()).pipe(Effect.isFailure),
          ).toBe(true);
          // New receipts carry historical scope, independent of today's thread incarnation.
          yield* save("accepted", forbiddenProjectId);
          expect(
            yield* readAuthorizedCommandReceipt(actor, { commandId, threadId, projectId }).pipe(
              Effect.isFailure,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "checks the actual existing target before a fresh bootstrap and leaves new threads to normal authorization",
    () =>
      Effect.gen(function* () {
        const { layer, state, freshCommands } = yield* fixture;
        yield* Effect.gen(function* () {
          state.thread = {
            threadId,
            projectId: forbiddenProjectId,
            deletedAt: null,
          } as ProjectionThread;
          expect(
            yield* authorizeOrchestrationCommand(actor, enqueue()).pipe(Effect.isFailure),
          ).toBe(true);
          expect(freshCommands()).toBe(0);
          state.thread = undefined;
          yield* authorizeOrchestrationCommand(actor, enqueue());
          expect(freshCommands()).toBe(1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "preserves personal receipt replay without requiring an organization or surviving thread",
    () =>
      Effect.gen(function* () {
        const { layer, save, state, freshCommands } = yield* fixture;
        state.enabled = false;
        yield* Effect.gen(function* () {
          yield* save("accepted", null);
          expect(
            Option.isSome(yield* readAuthorizedCommandReceipt(actor, { commandId, threadId })),
          ).toBe(true);
          yield* authorizeOrchestrationCommand(actor, enqueue());
          expect(freshCommands()).toBe(1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(testLayer)),
  );
});
