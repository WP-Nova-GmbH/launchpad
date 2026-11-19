import * as NodeCrypto from "node:crypto";
import { ThreadId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { WorkflowRecoveryManifest } from "@t3tools/contracts/workflows";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { describe, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { nativeCheckpointCatalogTestLayer } from "../threads/testUtils/nativeCheckpointCatalog.ts";
import {
  attachmentCheckpointCatalogFixture,
  laterAttachmentCheckpoint,
} from "../threads/testUtils/attachmentCheckpointCatalog.ts";
import { makeWorkflowResults } from "./WorkflowResults.ts";
import {
  listSavedWorkflowResults,
  readSavedWorkflowResult,
  getSavedWorkflowHistory,
  getSavedWorkflowAttachment,
} from "../http/WorkflowResultsApi.ts";
import { releaseThreadNativeCheckpointOperation } from "../threads/ThreadNativeCheckpointStore.ts";
import * as Stream from "effect/Stream";

const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(WorkflowRecoveryManifest));
const fixture = Effect.fnUntraced(function* () {
  const f = yield* attachmentCheckpointCatalogFixture;
  yield* f.upload(f.attachments);
  yield* f.publishAttachments;
  const jobId = NodeCrypto.randomUUID();
  const userId = NodeCrypto.randomUUID();
  yield* f.sql`INSERT INTO relay_organizations(organization_id,name,created_at,updated_at) VALUES('org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_repositories(repository_id,organization_id,name,created_at,updated_at) VALUES('repo','org','Tests','now','now') ON CONFLICT DO NOTHING`;
  yield* f.sql`INSERT INTO relay_organization_members(organization_id,user_id,role,created_at,updated_at) VALUES('org',${userId},'member','now','now')`;
  yield* f.sql`INSERT INTO relay_repository_access(repository_id,organization_id,user_id,role,created_at,updated_at) VALUES('repo','org',${userId},'developer','now','now')`;
  const record = {
    jobId,
    workflowId: "workflow",
    repositoryId: "repo",
    origin: { kind: "manual", userId },
    instruction: "test",
    status: "done",
    runtime: { kind: "vm", threadId: f.threadId },
    progress: null,
    createdAt: "now",
    updatedAt: "now",
  };
  yield* f.sql`INSERT INTO relay_workflow_jobs(job_id,organization_id,repository_id,submitter_user_id,status,record,revision,created_at,checked_at) VALUES(${jobId},'org','repo',${userId},'done',${f.sql.json(record)},0,'now','now')`;
  yield* f.sql`UPDATE relay_thread_placements SET audience='repository',owner_user_id=NULL,workflow_job_id=${jobId} WHERE thread_id=${f.threadId}`;
  const store = makeWorkflowResults(f.sql, f.objects);
  const binding = {
    jobId,
    organizationId: "org",
    repositoryId: "repo",
    threadId: ThreadId.make(f.threadId),
    environmentId: EnvironmentId.make(f.sourceEnvironmentId),
    generation: 1,
    projectId: ProjectId.make("project"),
    allocationId: "allocation",
    operationId: "provision",
  };
  const makePublication = Effect.fnUntraced(function* (
    revision: number,
    withResult = true,
    outcome: "completed" | "failed" | "cancelled" = "completed",
  ) {
    const publicationId = NodeCrypto.randomUUID();
    const upload = Effect.fnUntraced(function* (
      text: string,
      kind: "history" | "workspace" | "manifest",
    ) {
      const bytes = new TextEncoder().encode(text);
      const artifact = {
        artifactId: NodeCrypto.randomUUID(),
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
      };
      yield* f.transfer.upload({
        ...artifact,
        threadId: f.threadId,
        operationId: publicationId,
        kind,
        retentionDays: 1,
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      });
      return artifact;
    });
    yield* store.reserve({
      threadId: f.threadId,
      environmentId: f.sourceEnvironmentId,
      generation: 1,
      publicationId,
      nativeCheckpointOperationId: f.native.header.operationId,
    });
    const patch = yield* upload(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new  \n",
      "workspace",
    );
    const manifest: WorkflowRecoveryManifest = {
      format: "workflow-recovery-v1",
      publicationId,
      binding,
      revision,
      state: yield* upload('{"cursor":1}', "history"),
      sourceSequence: f.sourceSequence,
      nativeCheckpointOperationId: f.native.header.operationId,
      result: withResult
        ? {
            resultId: NodeCrypto.randomUUID(),
            stepId: "agent",
            turnId: f.native.header.turnId,
            turnCount: 1,
            outcome,
            createdAt: "2026-11-10T10:00:00Z",
            checkpointRef: "checkpoint",
            baselineCommitId: "a".repeat(40),
            commitId: "b".repeat(40),
            treeId: "c".repeat(40),
            patch,
          }
        : null,
    };
    const object = yield* upload(yield* encodeManifest(manifest), "manifest");
    return {
      manifest,
      object,
      input: { threadId: f.threadId, publicationId, manifestArtifactId: object.artifactId },
    };
  });
  const db = yield* PgDrizzle.makeWithDefaults();
  const asUser = <A, E, R>(effect: Effect.Effect<A, E, R>, actor: string = userId) =>
    effect.pipe(
      Effect.provideService(RelayDb, db),
      Effect.provideService(ThreadArtifactObjectStorage, f.objects),
      Effect.provideService(RelayClientPrincipal, { userId: actor, token: "test" }),
    );
  return {
    ...f,
    store,
    makePublication,
    jobId,
    userId,
    asUser,
    scope: { repositoryId: "repo", jobId },
  };
});

describe.skipIf(!process.env.LAUNCHPAD_VM_TEST_DATABASE_URL)(
  "saved workflow results (Postgres)",
  () => {
    layer(nativeCheckpointCatalogTestLayer)((it) => {
      it.effect("atomically publishes, reconciles a lost reply and reads with no VM or owner", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const p = yield* f.makePublication(1);
            const receipt = yield* f.store.publish(p.input, () => Effect.void);
            expect(yield* f.store.publish(p.input, () => Effect.void)).toEqual(receipt);
            const resultId = p.manifest.result!.resultId;
            expect(yield* f.asUser(listSavedWorkflowResults(f.scope))).toMatchObject({
              results: [{ resultId }],
            });
            const saved = yield* f.asUser(readSavedWorkflowResult({ ...f.scope, resultId }));
            expect(saved.patch).toContain("+new  \n");
            expect(
              (yield* f.asUser(
                getSavedWorkflowHistory({ ...f.scope, resultId, after: 0, limit: 200 }),
              )).entries.length,
            ).toBeGreaterThan(0);
            const stream = yield* f.asUser(
              getSavedWorkflowAttachment({ ...f.scope, resultId, attachmentId: f.attachment.id }),
            );
            expect(Buffer.concat(Array.from(yield* Stream.runCollect(stream))).toString()).toBe(
              "notes",
            );
            expect(
              (yield* Effect.result(
                f.asUser(readSavedWorkflowResult({ ...f.scope, resultId }), "outsider"),
              ))._tag,
            ).toBe("Failure");
            yield* f.sql`DELETE FROM relay_repository_access WHERE user_id=${f.userId}`;
            expect(
              (yield* Effect.result(f.asUser(readSavedWorkflowResult({ ...f.scope, resultId }))))
                ._tag,
            ).toBe("Failure");
          }),
        ),
      );
      for (const outcome of ["failed", "cancelled"] as const)
        it.effect(
          `retains a labelled ${outcome} partial diff and conversation without compute`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fixture();
                const p = yield* f.makePublication(1, true, outcome);
                yield* f.store.publish(p.input, () => Effect.void);
                const saved = yield* f.asUser(
                  readSavedWorkflowResult({ ...f.scope, resultId: p.manifest.result!.resultId }),
                );
                expect(saved.result.outcome).toBe(outcome);
                expect(saved.patch).toContain("+new  \n");
                expect(
                  (yield* f.asUser(
                    getSavedWorkflowHistory({
                      ...f.scope,
                      resultId: saved.result.resultId,
                      after: 0,
                      limit: 200,
                    }),
                  )).entries.length,
                ).toBeGreaterThan(0);
                expect(
                  yield* f.sql`SELECT 1 FROM relay_thread_vm_allocations WHERE thread_id=${f.threadId}`,
                ).toHaveLength(0);
              }),
            ),
        );
      it.effect(
        "rejects stale revisions, mismatched content and a publication denied at commit",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const first = yield* f.makePublication(2);
              yield* f.store.publish(first.input, () => Effect.void);
              const stale = yield* f.makePublication(1, false);
              expect(
                (yield* Effect.result(f.store.publish(stale.input, () => Effect.void)))._tag,
              ).toBe("Failure");
              const rejected = yield* f.makePublication(3, false);
              expect(
                (yield* Effect.result(
                  f.store.publish(rejected.input, () => Effect.fail("writer revoked")),
                ))._tag,
              ).toBe("Failure");
              expect(
                yield* f.sql`SELECT 1 FROM relay_workflow_recovery_records WHERE publication_id=${rejected.manifest.publicationId}`,
              ).toHaveLength(0);
              const [head] = yield* f.sql<{
                revision: number;
              }>`SELECT revision FROM relay_workflow_recovery_heads WHERE job_id=${f.jobId}`;
              expect(head?.revision).toBe(2);
            }),
          ),
      );
      it.effect("pages all saved versions in stable descending revision order", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            const p = yield* f.makePublication(1);
            yield* f.store.publish(p.input, () => Effect.void);
            for (let revision = 2; revision <= 52; revision++) {
              const result = {
                ...p.manifest.result!,
                resultId: NodeCrypto.randomUUID(),
                turnId: `turn-${revision}`,
              };
              yield* f.sql`INSERT INTO relay_workflow_saved_results(result_id,job_id,thread_id,turn_id,revision,result,native_checkpoint_operation_id)
              VALUES(${result.resultId},${f.jobId},${f.threadId},${result.turnId},${revision},${f.sql.json(result)},${f.native.header.operationId})`;
            }
            const first = yield* f.asUser(listSavedWorkflowResults(f.scope));
            expect(first.results).toHaveLength(50);
            expect(first.nextCursor).toBe(3);
            expect(first.results[0]?.turnId).toBe("turn-52");
            const last = yield* f.asUser(
              listSavedWorkflowResults({ ...f.scope, before: first.nextCursor! }),
            );
            expect(last.results).toHaveLength(2);
            expect(last.nextCursor).toBeNull();
            expect(new Set([...first.results, ...last.results].map((r) => r.resultId)).size).toBe(
              52,
            );
          }),
        ),
      );
      it.effect(
        "protects the referenced catalog point through rotation, then retires provider bytes without losing old results",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture();
              const p = yield* f.makePublication(1);
              yield* f.store.publish(p.input, () => Effect.void);
              for (let n = 1; n <= 3; n++) {
                const point = yield* laterAttachmentCheckpoint(f, n);
                yield* f.upload(point.attachments);
                yield* f.attachmentStore.publish({
                  threadId: f.threadId,
                  operationId: point.attachments.header.operationId,
                  manifestArtifactId: point.attachments.artifactId,
                  nativeCheckpointOperationId: point.native.header.operationId,
                });
              }
              expect(yield* f.storeNative.get(f.native.header.operationId)).not.toBeNull();
              yield* releaseThreadNativeCheckpointOperation(f.sql, {
                threadId: f.threadId,
                operationId: p.manifest.publicationId,
              });
              expect(yield* f.storeNative.get(f.native.header.operationId)).toBeNull();
              const resultId = p.manifest.result!.resultId;
              expect(
                (yield* f.asUser(readSavedWorkflowResult({ ...f.scope, resultId }))).patch,
              ).toContain("+new  \n");
              const stream = yield* f.asUser(
                getSavedWorkflowAttachment({ ...f.scope, resultId, attachmentId: f.attachment.id }),
              );
              expect(Buffer.concat(Array.from(yield* Stream.runCollect(stream))).toString()).toBe(
                "notes",
              );
            }),
          ),
      );
    });
  },
);
