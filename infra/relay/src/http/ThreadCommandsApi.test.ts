import { CommandId, MessageId, ThreadId, type PortableThreadCommand } from "@t3tools/contracts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, layer } from "@effect/vitest";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeCrypto from "node:crypto";
import { RelayDb } from "../db.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import { makeLocalThreadArtifactObjects } from "../threads/ThreadArtifactLocalObjects.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { makeThreadPlacementStore } from "../threads/ThreadPlacementStore.ts";
import { makeThreadVmCapacityStore } from "../threads/ThreadVmCapacityStore.ts";
import { makeThreadVmMoveDestinationStore } from "../threads/ThreadVmMoveDestinationStore.ts";
import {
  encode,
  nativeCheckpointCatalogTestLayer,
} from "../threads/testUtils/nativeCheckpointCatalog.ts";
import { emptyThreadPromptQueue } from "@t3tools/shared/threadPromptQueue";
import {
  cancelPortableThreadMove,
  getPortableThreadCommandReceipt,
  getPortableThreadMoveCancellation,
  stagePortableThreadCommand,
} from "./ThreadCommandsApi.ts";
import { getPortableThreadPlacement } from "./ThreadHistoryApi.ts";

const at = "2026-11-19T12:00:00.000Z";

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "private VM move cleanup after repository access is revoked",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      for (const state of ["queued", "admitted"] as const) {
        it.effect(`lets only the owner cancel an exact ${state} VM move`, () =>
          Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient;
              const db = yield* PgDrizzle.makeWithDefaults();
              const fs = yield* FileSystem.FileSystem;
              const objects = makeLocalThreadArtifactObjects(
                fs,
                yield* fs.makeTempDirectoryScoped({ prefix: "vm-move-cancel-" }),
              );
              const operationId = NodeCrypto.randomUUID();
              const threadId = ThreadId.make(NodeCrypto.randomUUID());
              const messageId = MessageId.make(NodeCrypto.randomUUID());
              const ownerUserId = `owner-${threadId}`;
              const organizationId = `org-${threadId}`;
              const repositoryId = `repo-${threadId}`;
              const environmentId = `source-${threadId}`;
              yield* sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at)
                VALUES(${organizationId},'Tests',${at},${at})`;
              yield* sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at)
                VALUES(${repositoryId},${organizationId},'Tests',${at},${at})`;
              yield* sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at)
                VALUES(${organizationId},${ownerUserId},'member',${at},${at})`;
              yield* sql`INSERT INTO relay_repository_access(organization_id,repository_id,user_id,role,created_at,updated_at)
                VALUES(${organizationId},${repositoryId},${ownerUserId},'developer',${at},${at})`;
              const placements = makeThreadPlacementStore(sql);
              yield* placements.enroll({
                threadId,
                organizationId,
                repositoryId,
                ownerUserId,
                environmentId,
                projectId: "project",
              });
              const input = { threadId, operationId, sourceGeneration: 1 };
              if (state === "admitted") {
                yield* makeThreadVmCapacityStore(sql).configure("cancel-admitted-host", 1);
                yield* makeThreadVmMoveDestinationStore(sql).enqueue({
                  ...input,
                  actorUserId: ownerUserId,
                  sourceEnvironmentId: environmentId,
                  expectedGeneration: 1,
                  sourceMessageId: messageId,
                  supportsSourceReopenAck: true,
                  hostId: "cancel-admitted-host",
                  templateId: "template",
                  cancelBeforeStart: false,
                });
              }
              const queue = {
                ...emptyThreadPromptQueue(),
                entries: [
                  {
                    kind: "move",
                    state: "blocked",
                    destination: { kind: "vm" },
                    operationId,
                    revision: 3,
                    messageId,
                    acceptedSequence: 1,
                    createdAt: at,
                    updatedAt: at,
                  },
                ],
              };
              yield* sql`INSERT INTO relay_thread_current_queues(thread_id,cursor,queue_json)
                VALUES(${threadId},0,${encode(queue)}::jsonb)`;
              yield* sql`DELETE FROM relay_repository_access
                WHERE repository_id=${repositoryId} AND user_id=${ownerUserId}`;

              const asUser = <A, E, R>(effect: Effect.Effect<A, E, R>, userId = ownerUserId) =>
                effect.pipe(
                  Effect.provideService(RelayClientPrincipal, { userId, token: "test" }),
                  Effect.provideService(RelayDb, db),
                  Effect.provideService(ThreadArtifactObjectStorage, objects),
                  Effect.provideService(UserDirectory, { lookup: () => Effect.succeed(new Map()) }),
                );
              const command: PortableThreadCommand = {
                type: "thread.move.cancel",
                threadId,
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                messageId,
                expectedRevision: 3,
                createdAt: at,
              };
              const ownerCancel = asUser(stagePortableThreadCommand(threadId, command));
              const deny = (error: unknown) =>
                expect(error).toMatchObject({ reason: "thread_not_found" });
              deny(yield* Effect.flip(asUser(getPortableThreadPlacement(threadId))));
              deny(
                yield* Effect.flip(
                  asUser(getPortableThreadCommandReceipt(threadId, command.commandId)),
                ),
              );
              deny(
                yield* Effect.flip(
                  asUser(
                    stagePortableThreadCommand(threadId, {
                      type: "thread.move.enqueue",
                      threadId,
                      commandId: CommandId.make(NodeCrypto.randomUUID()),
                      messageId: MessageId.make(NodeCrypto.randomUUID()),
                      destination: { kind: "vm" },
                      createdAt: at,
                    }),
                  ),
                ),
              );
              deny(
                yield* Effect.flip(
                  asUser(stagePortableThreadCommand(threadId, command), "outsider"),
                ),
              );
              deny(yield* Effect.flip(asUser(cancelPortableThreadMove(input), "outsider")));
              if (state === "queued") {
                expect(
                  yield* Effect.flip(
                    asUser(
                      stagePortableThreadCommand(threadId, { ...command, expectedRevision: 2 }),
                    ),
                  ),
                ).toMatchObject({ reason: "thread_command_conflict" });
                expect(yield* placements.findMove(input)).toBeNull();
              } else {
                deny(
                  yield* Effect.flip(
                    asUser(cancelPortableThreadMove({ ...input, sourceGeneration: 2 })),
                  ),
                );
                expect(yield* asUser(cancelPortableThreadMove(input))).toMatchObject({
                  phase: "aborting",
                });
              }
              const receipt = yield* ownerCancel;
              expect(receipt.receipt?.status).toBe("accepted");
              expect(
                yield* asUser(getPortableThreadCommandReceipt(threadId, command.commandId)),
              ).toEqual(receipt);
              deny(
                yield* Effect.flip(
                  asUser(getPortableThreadCommandReceipt(threadId, command.commandId), "outsider"),
                ),
              );
              expect(yield* ownerCancel).toEqual(receipt);
              expect(yield* asUser(getPortableThreadMoveCancellation(input))).toMatchObject({
                operationId,
                phase: state === "queued" ? "reopening" : "aborting",
              });
              deny(yield* Effect.flip(asUser(getPortableThreadPlacement(threadId))));
            }),
          ),
        );
      }
    });
  },
);
