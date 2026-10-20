import * as NodeCrypto from "node:crypto";
import { describe, expect, layer } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  OrchestrationEvent,
  PortableThreadCommand,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { decidePromptQueueCommand } from "../../../../apps/server/src/orchestration/promptQueueDecider.ts";
import {
  createEmptyReadModel,
  projectEvent,
} from "../../../../apps/server/src/orchestration/projector.ts";
import {
  attachmentCheckpointCatalogFixture,
  laterAttachmentCheckpoint,
} from "./testUtils/attachmentCheckpointCatalog.ts";
import { nativeCheckpointCatalogTestLayer } from "./testUtils/nativeCheckpointCatalog.ts";
import { makeThreadVmRecoveryHistory } from "./ThreadVmRecoveryHistory.ts";

const decode = Schema.decodeUnknownSync(OrchestrationEvent),
  at = "2026-10-15T00:00:00.000Z";
const decodeCommand = Schema.decodeUnknownSync(PortableThreadCommand);
const fixture = Effect.gen(function* () {
  const f = yield* attachmentCheckpointCatalogFixture;
  yield* f.upload(f.attachments);
  yield* f.publishAttachments;
  yield* f.sql`INSERT INTO relay_thread_local_enrollments(thread_id,operation_id,phase,source_sequence,receipt_count) VALUES(${f.threadId},${NodeCrypto.randomUUID()},'active',${f.sourceSequence},0)`;
  const history = makeThreadVmRecoveryHistory(f.sql, f.objects),
    operationId = NodeCrypto.randomUUID();
  const input = {
    threadId: f.threadId,
    sourceEnvironmentId: f.sourceEnvironmentId,
    generation: 1,
    nativeCheckpointOperationId: f.native.header.operationId,
  };
  const append = Effect.fnUntraced(function* (
    type: string,
    payload: unknown,
    commandId: string | null = null,
  ) {
    const [head] = yield* f.sql<{
      sequence: number;
    }>`SELECT MAX(source_sequence)::float8 AS sequence FROM relay_thread_history WHERE thread_id=${f.threadId} AND environment_id=${f.sourceEnvironmentId}`;
    const sequence = (head?.sequence ?? 0) + 1;
    const event = decode({
      type,
      payload,
      eventId: NodeCrypto.randomUUID(),
      sequence,
      aggregateKind: "thread",
      aggregateId: f.threadId,
      occurredAt: at,
      commandId,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });
    yield* f.journal.append({ ...f.owner, event });
    yield* f.journal.confirmThrough({ ...f.owner, sourceSequence: sequence });
    return event;
  });
  const select = Effect.fnUntraced(function* () {
    const selected = yield* history.inspect(input);
    yield* f.storeNative.pinCompleteForOperation({ ...f.recovery, operationId });
    yield* f.sql`UPDATE relay_thread_placements SET operation_id=${operationId} WHERE thread_id=${f.threadId}`;
    return { ...input, operationId, ...selected };
  });
  return { ...f, sourceHistory: f.history, history, input, operationId, append, select };
});
const idlePauseFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const readySession = {
    threadId: f.threadId,
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: at,
  };
  const ready = decode({
    ...f.sourceHistory[0],
    type: "thread.session-set",
    eventId: NodeCrypto.randomUUID(),
    sequence: f.sourceSequence + 1,
    payload: {
      threadId: f.threadId,
      session: readySession,
    },
  });
  const point = yield* laterAttachmentCheckpoint({ ...f, history: [...f.sourceHistory, ready] }, 0);
  yield* f.upload(point.attachments);
  yield* f.attachmentStore.publish({
    threadId: f.threadId,
    operationId: point.attachments.header.operationId,
    manifestArtifactId: point.attachments.artifactId,
    nativeCheckpointOperationId: point.native.header.operationId,
  });
  const input = { ...f.input, nativeCheckpointOperationId: point.native.header.operationId };
  const apply = Effect.fnUntraced(function* (
    command: Extract<
      OrchestrationCommand,
      { type: "thread.queue.pause" | "thread.prompt.enqueue" }
    >,
  ) {
    const rows = yield* f.sql<{
      event: unknown;
    }>`SELECT event_json AS event FROM relay_thread_history WHERE thread_id=${f.threadId} ORDER BY cursor`;
    let state = createEmptyReadModel(at);
    for (const row of rows) state = yield* projectEvent(state, decode(row.event));
    yield* f.journal.stage({
      threadId: f.threadId,
      actor: { userId: "user", displayName: null, imageUrl: null },
      command,
    });
    const planned = yield* decidePromptQueueCommand(state.threads[0]!, command, false);
    let sequence = 0;
    for (const event of planned)
      sequence = (yield* f.append(event.type, event.payload, event.commandId)).sequence;
    yield* f.journal.acknowledge({
      ...f.owner,
      commandId: command.commandId,
      receipt: { status: "accepted", sequence },
      commandReceipt: {
        commandId: command.commandId,
        aggregateKind: "thread",
        aggregateId: command.threadId,
        projectId: ProjectId.make("project"),
        acceptedAt: at,
        resultSequence: sequence,
        status: "accepted",
        error: null,
      },
    });
    return command.commandId;
  });
  const pause = () =>
    apply({
      type: "thread.queue.pause",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: ThreadId.make(f.threadId),
      createdAt: at,
    });
  const session = (status: string, activeTurnId: string | null = null) =>
    f.append("thread.session-set", {
      threadId: f.threadId,
      session: { ...readySession, status, activeTurnId },
    });
  return { ...f, input, point, apply, pause, session };
});
describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "independent backup conversation history",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect(
        "retains an idle queue pause, runtime rehydration and telemetry with accepted P",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* idlePauseFixture;
              expect(f.point.native.header.captureOperationId ?? null).toBeNull();
              yield* f.pause();
              yield* f.session("starting");
              yield* f.session("ready");
              yield* f.append("thread.activity-appended", {
                threadId: f.threadId,
                activity: {
                  id: "idle-context",
                  kind: "context-window.updated",
                  tone: "info",
                  summary: "Context window updated",
                  payload: { usedTokens: 42 },
                  turnId: null,
                  createdAt: at,
                },
              });
              const commandId = CommandId.make(NodeCrypto.randomUUID());
              yield* f.apply({
                type: "thread.prompt.enqueue",
                commandId,
                threadId: ThreadId.make(f.threadId),
                message: {
                  messageId: MessageId.make("P"),
                  text: "keep pending",
                  attachments: [f.attachment],
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: at,
              });
              const selection = yield* f.history.inspect(f.input);
              expect(selection.native.sourceSequence).toBe(f.point.sourceSequence);
              expect(selection.throughCommandPosition).toBe(2);
              const [ack] = yield* f.sql<{
                status: string;
              }>`SELECT receipt_json->>'status' AS status FROM relay_thread_commands WHERE command_id=${commandId}`;
              expect(ack?.status).toBe("accepted");
              expect(selection.throughRelayCursor).toBeGreaterThan(selection.nativeRelayCursor);
              const rows = yield* f.sql<{
                event: unknown;
              }>`SELECT event_json AS event FROM relay_thread_history WHERE thread_id=${f.threadId} ORDER BY cursor`;
              let replay = createEmptyReadModel(at);
              for (const row of rows) replay = yield* projectEvent(replay, decode(row.event));
              const queue = replay.threads[0]!.promptQueue!;
              expect(queue.enabled).toBe(false);
              expect(queue.entries).toMatchObject([{ messageId: "P", state: "pending" }]);
            }),
          ),
      );
      for (const status of ["starting", "running", "ready"] as const) {
        it.effect(`refuses an unfinished or active ${status} session after idle pause`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* idlePauseFixture;
              yield* f.pause();
              yield* f.session(status, status === "starting" ? null : "active-turn");
              yield* Effect.flip(f.history.inspect(f.input));
            }),
          ),
        );
      }
      for (const kind of ["unpaired", "turn-specific"] as const) {
        it.effect(`refuses a ${kind} interrupt after the native point`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* idlePauseFixture;
              if (kind === "unpaired") {
                yield* f.append(
                  "thread.turn-interrupt-requested",
                  { threadId: f.threadId, createdAt: at },
                  NodeCrypto.randomUUID(),
                );
              } else {
                const commandId = yield* f.pause();
                yield* f.sql`UPDATE relay_thread_history SET event_json=jsonb_set(event_json,'{payload,turnId}','"uncheckpointed-turn"'::jsonb) WHERE thread_id=${f.threadId} AND event_json->>'commandId'=${commandId} AND event_json->>'type'='thread.turn-interrupt-requested'`;
              }
              yield* Effect.flip(f.history.inspect(f.input));
            }),
          ),
        );
      }
      for (const field of ["admission", "awaitingTurnId", "handoff", "preparation"] as const) {
        it.effect(`refuses idle pause with an earlier unresolved ${field}`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* idlePauseFixture;
              const attemptId = NodeCrypto.randomUUID();
              const change = {
                threadId: f.threadId,
                updatedAt: at,
                ...(field === "admission"
                  ? {
                      admission: {
                        attemptId,
                        messageId: "Q",
                        turnId: "active",
                        evidence: "local-command",
                      },
                    }
                  : field === "handoff"
                    ? {
                        handoff: {
                          attemptId,
                          messageId: "Q",
                          revision: 0,
                          controlRevision: 0,
                          mode: "next-turn",
                        },
                      }
                    : field === "awaitingTurnId"
                      ? { awaitingTurnId: "active" }
                      : {
                          preparation: {
                            originalCommandId: attemptId,
                            attemptId,
                            revision: 1,
                            state: "running",
                            settled: false,
                            recipe: null,
                          },
                        }),
              };
              // This work predates the retained native boundary; a later pause
              // must not disguise it merely because the session has no turn id.
              yield* f.sql`UPDATE relay_thread_history SET event_json=jsonb_set(event_json,'{payload}',${f.sql.json(change)}) || '{"type":"thread.prompt-queue-changed"}'::jsonb WHERE thread_id=${f.threadId} AND cursor=2`;
              yield* f.pause();
              yield* Effect.flip(f.history.inspect(f.input));
            }),
          ),
        );
      }
      it.effect("refuses uncheckpointed provider work after the otherwise idle pause", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* idlePauseFixture;
            yield* f.pause();
            yield* f.append("thread.activity-appended", {
              threadId: f.threadId,
              activity: {
                id: "compaction",
                kind: "context-compaction",
                tone: "info",
                summary: "Compacted",
                payload: { state: "completed" },
                turnId: null,
                createdAt: at,
              },
            });
            yield* Effect.flip(f.history.inspect(f.input));
          }),
        ),
      );
      it.effect(
        "does not substitute a later same-environment scan for the original enrollment scan",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              yield* f.append("thread.prompt-queue-changed", {
                threadId: f.threadId,
                control: {
                  enabled: false,
                  revision: 1,
                  pauseReason: { code: "stopped", detail: "paused" },
                },
                updatedAt: at,
              });
              yield* f.sql`UPDATE relay_thread_local_enrollments SET source_sequence=${f.sourceSequence + 1} WHERE thread_id=${f.threadId}`;
              yield* f.sql`UPDATE relay_thread_history_watermarks SET source_sequence=${f.sourceSequence} WHERE thread_id=${f.threadId} AND generation=1`;
              yield* f.sql`INSERT INTO relay_thread_history_watermarks(thread_id,environment_id,generation,source_sequence) VALUES(${f.threadId},${f.sourceEnvironmentId},3,${f.sourceSequence + 1})`;
              yield* Effect.flip(f.history.inspect(f.input));
            }),
          ),
      );
      it.effect(
        "keeps a genuinely pending relay prompt but rejects an applied command with a lost receipt",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture,
                commandId = NodeCrypto.randomUUID();
              yield* f.journal.stage({
                threadId: f.threadId,
                actor: { userId: "user", displayName: null, imageUrl: null },
                command: decodeCommand({
                  type: "thread.prompt.enqueue",
                  commandId,
                  threadId: f.threadId,
                  message: { messageId: "P", text: "pending", attachments: [f.attachment] },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdAt: at,
                }),
              });
              expect((yield* f.history.inspect(f.input)).throughCommandPosition).toBeGreaterThan(0);
              yield* f.append(
                "thread.prompt-queue-changed",
                {
                  threadId: f.threadId,
                  entry: {
                    messageId: "P",
                    text: "pending",
                    attachments: [f.attachment],
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    revision: 0,
                    acceptedSequence: f.sourceSequence + 1,
                    createdAt: at,
                    state: "pending",
                  },
                  updatedAt: at,
                },
                commandId,
              );
              yield* Effect.flip(f.history.inspect(f.input));
              const [row] =
                yield* f.sql`SELECT receipt_json FROM relay_thread_commands WHERE command_id=${commandId}`;
              expect(row?.receipt_json).toBeNull();
            }),
          ),
      );
      it.effect(
        "refuses a new pending relay attachment absent from the independent checkpoint",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              yield* f.journal.stage({
                threadId: f.threadId,
                actor: { userId: "user", displayName: null, imageUrl: null },
                command: decodeCommand({
                  type: "thread.prompt.enqueue",
                  commandId: NodeCrypto.randomUUID(),
                  threadId: f.threadId,
                  message: {
                    messageId: "P",
                    text: "new file",
                    attachments: [{ ...f.attachment, id: "not-retained-txt" }],
                  },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdAt: at,
                }),
              });
              yield* Effect.flip(f.history.inspect(f.input));
            }),
          ),
      );
      it.effect("accepts source-authenticated no-op and rejected receipt witnesses", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            const accepted = {
              commandId: NodeCrypto.randomUUID(),
              aggregateKind: "thread",
              aggregateId: f.threadId,
              projectId: "project",
              acceptedAt: at,
              resultSequence: f.sourceSequence,
              status: "accepted",
              error: null,
            };
            const rejected = {
              ...accepted,
              commandId: NodeCrypto.randomUUID(),
              resultSequence: 0,
              status: "rejected",
              error: "kept rejection",
            };
            for (const receipt of [accepted, rejected])
              yield* f.sql`INSERT INTO relay_thread_local_receipts(command_id,thread_id,receipt_json) VALUES(${receipt.commandId},${f.threadId},${f.sql.json(receipt)})`;
            yield* f.sql`UPDATE relay_thread_local_enrollments SET receipt_count=(SELECT count(*)::int FROM relay_thread_local_receipts WHERE thread_id=${f.threadId}) WHERE thread_id=${f.threadId}`;
            const selected = yield* f.select(),
              h = yield* f.history.retain(selected);
            yield* f.history.verify({ ...selected, independentHistory: h });
            expect(yield* f.history.retain(selected)).toEqual(h);
          }),
        ),
      );
      it.effect(
        "admits only the exact completed predecessor import and rejects cross-environment receipt sequence collisions",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture,
                move = NodeCrypto.randomUUID(),
                destination = "next-environment";
              yield* f.sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase,source_cursor,manifest_sha256) VALUES(${move},${f.threadId},'user',${f.sourceEnvironmentId},1,${destination},'next-project','completed',${f.sourceSequence},${"0".repeat(64)})`;
              yield* f.sql`INSERT INTO relay_thread_move_checkpoints(operation_id,thread_id,manifest_artifact_id,native_checkpoint_operation_id,artifact_count) VALUES(${move},${f.threadId},${f.native.artifactId},${f.native.header.operationId},1)`;
              yield* f.sql`UPDATE relay_thread_placements SET environment_id=${destination},generation=2 WHERE thread_id=${f.threadId}`;
              const arrival = decode({
                type: "thread.placement-imported",
                eventId: `thread-transfer:${move}`,
                sequence: 3,
                aggregateKind: "thread",
                aggregateId: f.threadId,
                occurredAt: at,
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  threadId: f.threadId,
                  projectId: "next-project",
                  branch: "main",
                  worktreePath: null,
                  updatedAt: at,
                },
              });
              const owner = { threadId: f.threadId, environmentId: destination, generation: 2 };
              yield* f.journal.append({ ...owner, event: arrival });
              yield* f.journal.confirmThrough({ ...owner, sourceSequence: 3 });
              const input = { ...f.input, sourceEnvironmentId: destination, generation: 2 };
              expect((yield* f.history.inspect(input)).native.generation).toBe(1);
              const receipt = {
                commandId: NodeCrypto.randomUUID(),
                aggregateKind: "thread",
                aggregateId: f.threadId,
                projectId: "project",
                acceptedAt: at,
                resultSequence: 3,
                status: "accepted",
                error: null,
              };
              yield* f.sql`INSERT INTO relay_thread_local_receipts(command_id,thread_id,receipt_json) VALUES(${receipt.commandId},${f.threadId},${f.sql.json(receipt)})`;
              yield* f.sql`UPDATE relay_thread_local_enrollments SET receipt_count=(SELECT count(*)::int FROM relay_thread_local_receipts WHERE thread_id=${f.threadId}) WHERE thread_id=${f.threadId}`;
              yield* Effect.flip(f.history.inspect(input));
            }),
          ),
      );
      it.effect(
        "retains idle ready history but refuses ready-with-active-turn and pending provider admission",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              const ready = decode({
                ...f.sourceHistory[0],
                type: "thread.session-set",
                eventId: NodeCrypto.randomUUID(),
                sequence: f.sourceSequence,
                payload: {
                  threadId: f.threadId,
                  session: {
                    threadId: f.threadId,
                    status: "ready",
                    providerName: "codex",
                    runtimeMode: "full-access",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: at,
                  },
                },
              });
              yield* f.sql`UPDATE relay_thread_history SET event_json=${f.sql.json(ready)} WHERE thread_id=${f.threadId} AND source_sequence=${f.sourceSequence}`;
              yield* f.history.inspect(f.input);
              yield* f.sql`UPDATE relay_thread_history SET event_json=${f.sql.json({ ...ready, payload: { ...ready.payload, session: { threadId: f.threadId, status: "ready", providerName: "codex", runtimeMode: "full-access", activeTurnId: "unfinished", lastError: null, updatedAt: at } } })} WHERE thread_id=${f.threadId} AND source_sequence=${f.sourceSequence}`;
              yield* Effect.flip(f.history.inspect(f.input));
            }),
          ),
      );
      it.effect(
        "retains an ordinary native point plus queue-only tail independently of disk, with retry and exact pins",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              expect(f.native.header.captureOperationId ?? null).toBeNull();
              yield* f.append("thread.prompt-queue-changed", {
                threadId: f.threadId,
                entry: {
                  messageId: "P",
                  text: "keep pending",
                  attachments: [f.attachment],
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  revision: 0,
                  acceptedSequence: f.sourceSequence + 1,
                  createdAt: at,
                  state: "pending",
                },
                updatedAt: at,
              });
              const selection = yield* f.select(),
                descriptor = yield* f.history.retain(selection);
              expect(descriptor.nativeBoundary.sourceSequence).toBe(f.sourceSequence);
              expect(descriptor.throughRelayCursor).toBe(3);
              expect(yield* f.history.retain(selection)).toEqual(descriptor);
              expect(
                yield* f.history.verify({ ...selection, independentHistory: descriptor }),
              ).toEqual(descriptor);
              expect(
                yield* f.history.ownsArtifact({
                  ...selection,
                  artifactId: descriptor.manifestArtifactId,
                }),
              ).toBe(true);
              const parts = yield* Stream.runCollect(
                yield* f.history.openForOperation({
                  ...selection,
                  artifactId: descriptor.manifestArtifactId,
                }),
              );
              expect(parts.length).toBeGreaterThan(0);
              const [chunk] = yield* f.sql<{
                id: string;
              }>`SELECT artifact_id AS id FROM relay_thread_artifacts WHERE operation_id=${f.operationId} AND kind='history' ORDER BY artifact_id LIMIT 1`;
              yield* f.sql`DELETE FROM relay_thread_artifact_pins WHERE artifact_id=${chunk!.id} AND operation_id=${`recovery-history:${f.operationId}`}`;
              yield* Effect.flip(
                f.history.verify({ ...selection, independentHistory: descriptor }),
              );
              yield* f.sql`INSERT INTO relay_thread_artifact_pins(artifact_id,operation_id) VALUES(${chunk!.id},${`recovery-history:${f.operationId}`})`;
              const objectPath = `${f.root}/objects/${chunk!.id}`,
                before = yield* f.fs.readFile(objectPath);
              yield* f.fs.writeFileString(objectPath, "corrupted immutable chunk");
              yield* Effect.flip(
                f.history.openForOperation({ ...selection, artifactId: chunk!.id }),
              );
              yield* f.fs.writeFile(objectPath, before);
              yield* Effect.flip(
                f.history.openForOperation({
                  ...selection,
                  operationId: NodeCrypto.randomUUID(),
                  artifactId: descriptor.manifestArtifactId,
                }),
              );
              yield* f.sql`DELETE FROM relay_thread_artifact_pins WHERE artifact_id=${descriptor.manifestArtifactId} AND operation_id=${`recovery-history:${f.operationId}`}`;
              yield* Effect.flip(
                f.history.verify({ ...selection, independentHistory: descriptor }),
              );
              yield* f.history.release(selection);
              expect(yield* f.storeNative.getForOperation(selection)).not.toBeNull();
            }),
          ),
      );
      it.effect("rejects uncheckpointed provider output without retiring native or chat", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.append("thread.message-sent", {
              threadId: f.threadId,
              messageId: "new-output",
              role: "assistant",
              text: "not in native checkpoint",
              streaming: false,
              createdAt: at,
              updatedAt: at,
            });
            yield* Effect.flip(f.history.inspect(f.input));
            expect(yield* f.storeNative.get(f.input.nativeCheckpointOperationId)).not.toBeNull();
            expect(
              yield* f.attachmentStore.get(f.input.nativeCheckpointOperationId),
            ).not.toBeNull();
          }),
        ),
      );
      it.effect("rejects an uncovered attachment in an accepted pending queue entry", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.append("thread.prompt-queue-changed", {
              threadId: f.threadId,
              entry: {
                messageId: "P",
                text: "new attachment",
                attachments: [{ ...f.attachment, id: "uncovered-txt" }],
                runtimeMode: "full-access",
                interactionMode: "default",
                revision: 0,
                acceptedSequence: f.sourceSequence + 1,
                createdAt: at,
                state: "pending",
              },
              updatedAt: at,
            });
            yield* Effect.flip(f.history.inspect(f.input));
          }),
        ),
      );
      it.effect("rejects mirror gaps and absent native-boundary scan proof", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            yield* f.sql`UPDATE relay_thread_history_watermarks SET source_sequence=0 WHERE thread_id=${f.threadId}`;
            yield* Effect.flip(f.history.inspect(f.input));
            yield* f.sql`UPDATE relay_thread_history_watermarks SET source_sequence=${f.sourceSequence} WHERE thread_id=${f.threadId}`;
            yield* f.sql`DELETE FROM relay_thread_history WHERE thread_id=${f.threadId} AND cursor=1`;
            yield* Effect.flip(f.history.inspect(f.input));
          }),
        ),
      );
      it.effect(
        "does not adopt a predecessor native point without its exact completed import",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture;
              yield* Effect.flip(
                f.history.inspect({ ...f.input, generation: 2, sourceEnvironmentId: "unrelated" }),
              );
            }),
          ),
      );
      it.effect("follows two exact completed imports and refuses ambiguous lineage", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture;
            let source = f.sourceEnvironmentId;
            for (let generation = 1; generation <= 2; generation++) {
              const operationId = NodeCrypto.randomUUID(),
                destination = `destination-${generation}`;
              yield* f.sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase,source_cursor,manifest_sha256) VALUES(${operationId},${f.threadId},'user',${source},${generation},${destination},'next-project','completed',${f.sourceSequence},${"0".repeat(64)})`;
              yield* f.sql`INSERT INTO relay_thread_move_checkpoints(operation_id,thread_id,manifest_artifact_id,native_checkpoint_operation_id,artifact_count) VALUES(${operationId},${f.threadId},${f.native.artifactId},${f.native.header.operationId},1)`;
              yield* f.sql`UPDATE relay_thread_placements SET environment_id=${destination},generation=${generation + 1} WHERE thread_id=${f.threadId}`;
              const event = decode({
                ...f.sourceHistory[0],
                type: "thread.placement-imported",
                eventId: `thread-transfer:${operationId}`,
                sequence: 1,
                payload: {
                  threadId: f.threadId,
                  projectId: "next-project",
                  branch: "main",
                  worktreePath: null,
                  updatedAt: at,
                },
              });
              const owner = {
                threadId: f.threadId,
                environmentId: destination,
                generation: generation + 1,
              };
              yield* f.journal.append({ ...owner, event });
              yield* f.journal.confirmThrough({ ...owner, sourceSequence: 1 });
              source = destination;
            }
            const input = { ...f.input, sourceEnvironmentId: source, generation: 3 };
            expect((yield* f.history.inspect(input)).native.generation).toBe(1);
            const duplicate = NodeCrypto.randomUUID();
            yield* f.sql`INSERT INTO relay_thread_moves(operation_id,thread_id,actor_user_id,source_environment_id,expected_generation,destination_environment_id,destination_project_id,phase,source_cursor,manifest_sha256) VALUES(${duplicate},${f.threadId},'user',${f.sourceEnvironmentId},1,${f.sourceEnvironmentId},'next-project','completed',${f.sourceSequence},${"0".repeat(64)})`;
            yield* f.sql`INSERT INTO relay_thread_move_checkpoints(operation_id,thread_id,manifest_artifact_id,native_checkpoint_operation_id,artifact_count) VALUES(${duplicate},${f.threadId},${f.native.artifactId},${f.native.header.operationId},1)`;
            yield* Effect.flip(f.history.inspect(input));
          }),
        ),
      );
      it.effect(
        "checks accepted receipt source witness and preserves original receipt identity on retry",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture,
                commandId = NodeCrypto.randomUUID();
              const event = yield* f.append(
                "thread.prompt-queue-changed",
                {
                  threadId: f.threadId,
                  control: {
                    enabled: false,
                    revision: 1,
                    pauseReason: { code: "stopped", detail: "paused" },
                  },
                  updatedAt: at,
                },
                commandId,
              );
              const receipt = {
                commandId,
                aggregateKind: "thread",
                aggregateId: f.threadId,
                projectId: "project",
                acceptedAt: at,
                resultSequence: event.sequence,
                status: "accepted",
                error: null,
              };
              yield* f.sql`INSERT INTO relay_thread_local_receipts(command_id,thread_id,receipt_json) VALUES(${commandId},${f.threadId},${f.sql.json(receipt)})`;
              yield* f.sql`UPDATE relay_thread_local_enrollments SET receipt_count=(SELECT count(*)::int FROM relay_thread_local_receipts WHERE thread_id=${f.threadId}) WHERE thread_id=${f.threadId}`;
              const selection = yield* f.select(),
                h = yield* f.history.retain(selection);
              yield* f.history.verify({ ...selection, independentHistory: h });
              yield* f.sql`UPDATE relay_thread_local_receipts SET receipt_json=${f.sql.json({ ...receipt, resultSequence: event.sequence + 1 })} WHERE command_id=${commandId}`;
              yield* Effect.flip(f.history.inspect(f.input));
            }),
          ),
      );
    });
  },
);
