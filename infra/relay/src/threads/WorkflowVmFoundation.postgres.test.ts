import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Deferred, Effect, Fiber, FileSystem, Layer, Redacted } from "effect";
import * as NodeCrypto from "node:crypto";
import { makeThreadPlacementStore } from "./ThreadPlacementStore.ts";
import { makeThreadVmAllocationStore } from "./ThreadVmAllocationStore.ts";
import { makeThreadVmCapacityStore } from "./ThreadVmCapacityStore.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmProvisionWorker } from "./ThreadVmProvisionWorker.ts";
import { makeThreadVmPolicyStore } from "./ThreadVmPolicy.ts";
import { makeThreadDeletionStore } from "./ThreadDeletionStore.ts";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";

const databaseUrl = process.env.LAUNCHPAD_VM_TEST_DATABASE_URL;
const database = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!databaseUrl || !/^\/launchpad_vm_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname))
      return yield* Effect.die("Use a disposable launchpad_vm_test_* database");
    const sql = yield* PgClient.PgClient;
    const fs = yield* FileSystem.FileSystem;
    const root = new URL("../../migrations/postgres/", import.meta.url).pathname;
    for (const name of (yield* fs.readDirectory(root)).toSorted()) {
      const source = yield* fs.readFileString(`${root}/${name}/migration.sql`);
      yield* sql.withTransaction(
        Effect.forEach(source.split("--> statement-breakpoint"), (statement) =>
          sql.unsafe(statement),
        ),
      );
    }
  }),
).pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl ?? "") })),
);

const seed = Effect.fnUntraced(function* (input: {
  hostId: string;
  organizationId?: string;
  personal?: boolean;
  kind?: "create" | "resume";
}) {
  const sql = yield* PgClient.PgClient;
  const organizationId = input.organizationId ?? NodeCrypto.randomUUID();
  const repositoryId = NodeCrypto.randomUUID();
  const threadId = NodeCrypto.randomUUID();
  const workflowJobId = NodeCrypto.randomUUID();
  const allocationId = NodeCrypto.randomUUID();
  const operationId = NodeCrypto.randomUUID();
  const ownerUserId = NodeCrypto.randomUUID();
  const placements = makeThreadPlacementStore(sql);
  const capacity = makeThreadVmCapacityStore(sql);
  yield* capacity.configure(input.hostId, 100);
  if (input.personal) {
    yield* placements.enroll({
      threadId,
      organizationId,
      repositoryId,
      ownerUserId,
      environmentId: NodeCrypto.randomUUID(),
      projectId: NodeCrypto.randomUUID(),
    });
  } else {
    const workflow = {
      workflowId: NodeCrypto.randomUUID(),
      organizationId,
      repositoryId,
      revision: 1,
      archived: false,
      createdAt: "2026",
      updatedAt: "2026",
      definition: {
        name: "VM test",
        target: { kind: "vm", baseBranch: null },
        steps: [
          {
            kind: "agent",
            id: "agent",
            title: "Implement",
            instruction: "Implement",
            modelSelection: null,
          },
        ],
      },
    };
    const record = {
      jobId: workflowJobId,
      workflowId: workflow.workflowId,
      repositoryId,
      runtime: { kind: "vm", threadId },
      origin: { kind: "manual", userId: ownerUserId },
      instruction: "Implement",
      status: "preparing",
      detail: null,
      workflow,
      progress: null,
      createdAt: "2026",
      updatedAt: "2026",
    };
    yield* sql`INSERT INTO relay_workflow_jobs
      (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
      VALUES(${workflowJobId},${repositoryId},${organizationId},${ownerUserId},'preparing',${sql.json(record)},0,'2026','2026')`;
    yield* placements.prepareWorkflow({
      threadId,
      workflowJobId,
      organizationId,
      repositoryId,
      operationId,
    });
  }
  const kind = input.kind ?? "create";
  const computeRef = kind === "resume" ? NodeCrypto.randomUUID() : null;
  yield* sql`INSERT INTO relay_thread_vm_allocations
    (allocation_id,thread_id,organization_id,resource_kind,owner_user_id,template_id,state,compute_ref,runtime_protocol)
    VALUES(${allocationId},${threadId},${organizationId},${input.personal ? "personal" : "organization_workflow"},
      ${input.personal ? ownerUserId : null},'template',${kind === "resume" ? "paused" : "creating"},${computeRef},'native-v1')`;
  if (kind === "resume")
    yield* sql`INSERT INTO relay_thread_vm_capacity(operation_id,allocation_id,host_id,kind,state,compute_ref)
      VALUES(${NodeCrypto.randomUUID()},${allocationId},${input.hostId},'create','released',${computeRef})`;
  yield* capacity.request({ operationId, allocationId, hostId: input.hostId, kind });
  return {
    sql,
    placements,
    capacity,
    organizationId,
    repositoryId,
    threadId,
    workflowJobId,
    allocationId,
    operationId,
    ownerUserId,
    hostId: input.hostId,
  };
});

const services = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(NodeEffectCrypto.layer),
  Layer.provideMerge(
    Layer.succeed(RelaySecretBox, {
      seal: () => Effect.die("No workflow VM credentials may be issued in P01"),
      open: () => Effect.die("No workflow VM credentials may be read in P01"),
    }),
  ),
);

describe.skipIf(!databaseUrl)("workflow VM ownership and capacity foundation (Postgres)", () => {
  it.layer(services)((it) => {
    it.effect("keeps preparatory workflow metadata outside personal reads and execution", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        expect(yield* f.placements.get(f.threadId)).toBeNull();
        expect(yield* f.placements.prepareWorkflow(f)).toMatchObject({
          workflowJobId: f.workflowJobId,
        });
        expect(yield* f.placements.getAny(f.threadId)).toMatchObject({
          audience: "repository",
          workflowJobId: f.workflowJobId,
          ownerUserId: null,
          environmentId: null,
          projectId: null,
          generation: 1,
        });
        const allocations = makeThreadVmAllocationStore(f.sql);
        expect(yield* allocations.get(f.allocationId)).toBeNull();
        expect(yield* allocations.getAny(f.allocationId)).toMatchObject({
          resourceKind: "organization_workflow",
          ownerUserId: null,
        });
        const denied = yield* Effect.flip(
          f.placements.admit({
            threadId: f.threadId,
            environmentId: "forged",
            generation: 1,
            workId: "forged",
          }),
        );
        expect(denied._tag).toBe("ThreadPlacementConflict");
        expect(
          yield* Effect.isFailure(f.placements.assignWorkflow({ ...f, environmentId: "forged" })),
        ).toBe(true);
      }),
    );

    it.effect("prepares only the logical thread bound to an active VM job", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        const workflowJobId = NodeCrypto.randomUUID();
        const threadId = NodeCrypto.randomUUID();
        const wrongThreadId = NodeCrypto.randomUUID();
        const input = { ...f, workflowJobId, threadId, operationId: NodeCrypto.randomUUID() };
        yield* f.sql`INSERT INTO relay_workflow_jobs
          (job_id,repository_id,organization_id,submitter_user_id,status,record,revision,created_at,checked_at)
          SELECT ${workflowJobId},repository_id,organization_id,submitter_user_id,'preparing',
            record || jsonb_build_object('jobId',${workflowJobId}::text,
              'runtime',jsonb_build_object('kind','vm','threadId',${threadId}::text)),0,'2026','2026'
          FROM relay_workflow_jobs WHERE job_id=${f.workflowJobId}`;
        expect(yield* f.placements.getAny(threadId)).toBeNull();
        expect(
          yield* Effect.isFailure(
            f.placements.prepareWorkflow({ ...input, threadId: wrongThreadId }),
          ),
        ).toBe(true);
        expect(yield* f.placements.getAny(wrongThreadId)).toBeNull();
        yield* f.sql`UPDATE relay_workflow_jobs SET status='done' WHERE job_id=${workflowJobId}`;
        expect(yield* Effect.isFailure(f.placements.prepareWorkflow(input))).toBe(true);
        expect(yield* f.placements.getAny(threadId)).toBeNull();
        yield* f.sql`UPDATE relay_workflow_jobs SET status='preparing' WHERE job_id=${workflowJobId}`;
        expect(yield* f.placements.prepareWorkflow(input)).toMatchObject({
          threadId,
          workflowJobId,
          environmentId: null,
        });
      }),
    );

    it.effect("assigns only its installed allocation and makes exact assignment idempotent", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        const environmentId = NodeCrypto.randomUUID();
        const credentialId = NodeCrypto.randomUUID();
        yield* f.sql`UPDATE relay_thread_vm_allocations SET state='running',compute_ref=${NodeCrypto.randomUUID()} WHERE allocation_id=${f.allocationId}`;
        yield* f.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation,phase)
          VALUES(${f.allocationId},${f.operationId},1,'created')`;
        yield* f.sql`INSERT INTO relay_environment_credentials(credential_id,environment_id,environment_public_key,credential_hash,created_at,updated_at)
          VALUES(${credentialId},${environmentId},'test-key',${credentialId},'2026','2026')`;
        yield* f.sql`INSERT INTO relay_thread_vm_bindings(environment_id,allocation_id,thread_id,repository_id,generation,environment_public_key,credential_id)
          VALUES(${environmentId},${f.allocationId},${f.threadId},${f.repositoryId},1,'test-key',${credentialId})`;
        yield* f.sql`INSERT INTO relay_thread_vm_enrollments(allocation_id,operation_id,seed_hash,environment_id,environment_public_key,credential_id,sealed_response,expires_at,installed_at)
          VALUES(${f.allocationId},${f.operationId},${credentialId},${environmentId},'test-key',${credentialId},'test-response',clock_timestamp()+interval '1 hour',clock_timestamp())`;
        const input = { ...f, environmentId };
        expect(yield* f.placements.assignWorkflow(input)).toMatchObject({
          environmentId,
          projectId: `vm:${f.threadId}`,
        });
        expect(yield* f.placements.assignWorkflow(input)).toMatchObject({
          environmentId,
          generation: 1,
        });
        expect(yield* f.placements.get(f.threadId)).toBeNull();
        expect(
          yield* Effect.isFailure(
            f.placements.assignWorkflow({ ...input, environmentId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(
            f.placements.assignWorkflow({ ...input, workflowJobId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
      }),
    );

    it.effect("rejects duplicate job placements and tenant or owner mismatches", () =>
      Effect.gen(function* () {
        const f = yield* seed({ hostId: NodeCrypto.randomUUID() });
        expect(
          yield* Effect.isFailure(
            f.placements.prepareWorkflow({ ...f, threadId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(
            f.placements.prepareWorkflow({ ...f, organizationId: NodeCrypto.randomUUID() }),
          ),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(f.sql`INSERT INTO relay_thread_placements
          (thread_id,organization_id,repository_id,audience,owner_user_id,environment_id,project_id)
          VALUES(${NodeCrypto.randomUUID()},${f.organizationId},${f.repositoryId},'private',NULL,'environment','project')`),
        ).toBe(true);
        yield* f.sql`UPDATE relay_thread_vm_capacity SET state='released' WHERE operation_id=${f.operationId}`;
        yield* f.sql`UPDATE relay_thread_vm_allocations SET state='deleted',deleted_at='2026' WHERE allocation_id=${f.allocationId}`;
        const replacementAllocationId = NodeCrypto.randomUUID();
        yield* f.sql`INSERT INTO relay_thread_vm_allocations
          (allocation_id,thread_id,organization_id,resource_kind,owner_user_id,template_id,state)
          VALUES(${replacementAllocationId},${f.threadId},${f.organizationId},'organization_workflow',NULL,'template','creating')`;
        expect(
          yield* makeThreadVmAllocationStore(f.sql).getAny(replacementAllocationId),
        ).toMatchObject({ threadId: f.threadId });
        expect(
          yield* Effect.isFailure(f.sql`INSERT INTO relay_thread_vm_allocations
          (allocation_id,thread_id,organization_id,resource_kind,owner_user_id,template_id,state)
          VALUES(${NodeCrypto.randomUUID()},${NodeCrypto.randomUUID()},${f.organizationId},'organization_workflow',NULL,'template','creating')`),
        ).toBe(true);
        expect(
          yield* Effect.isFailure(f.sql`INSERT INTO relay_thread_placements
          (thread_id,organization_id,repository_id,audience,owner_user_id,workflow_job_id,environment_id,project_id,generation,operation_id)
          VALUES(${NodeCrypto.randomUUID()},${NodeCrypto.randomUUID()},${f.repositoryId},'repository',NULL,${f.workflowJobId},NULL,NULL,1,${NodeCrypto.randomUUID()})`),
        ).toBe(true);
      }),
    );

    it.effect("defaults to personal admission before legacy workers claim work", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const workflow = yield* seed({ hostId });
        const personal = yield* seed({ hostId, personal: true });
        yield* workflow.capacity.configure(hostId, 1);
        yield* workflow.sql`INSERT INTO relay_thread_vm_provisions(allocation_id,operation_id,generation)
          VALUES(${workflow.allocationId},${workflow.operationId},1)`;
        let externalCalls = 0;
        const worker = makeThreadVmProvisionWorker(
          workflow.sql,
          {
            create: () => {
              externalCalls += 1;
              return Effect.die("Unexpected compute");
            },
            findOperation: () => {
              externalCalls += 1;
              return Effect.die("Unexpected compute");
            },
            recoverIngress: () => {
              externalCalls += 1;
              return Effect.die("Unexpected compute");
            },
          },
          "template",
          hostId,
        );
        expect(yield* worker.runOne()).toBe(false);
        expect(externalCalls).toBe(0);
        expect((yield* workflow.capacity.get(workflow.operationId))?.state).toBe("waiting");
        expect((yield* workflow.capacity.get(personal.operationId))?.state).toBe("reserved");
        expect(
          yield* makeThreadVmProvisionStore(workflow.sql).claim(NodeCrypto.randomUUID(), hostId),
        ).toBeNull();
        for (const fixture of [workflow, personal])
          yield* fixture.sql`INSERT INTO relay_thread_deletions
            (thread_id,operation_id,owner_user_id,generation,host_id,phase)
            VALUES(${fixture.threadId},${NodeCrypto.randomUUID()},${fixture.ownerUserId},1,${hostId},'stopping')`;
        expect(yield* makeThreadDeletionStore(workflow.sql).claim(hostId)).toMatchObject({
          threadId: personal.threadId,
        });
        const [untouched] = yield* workflow.sql<{
          claimId: string | null;
        }>`SELECT claim_id AS "claimId" FROM relay_thread_deletions WHERE thread_id=${workflow.threadId}`;
        expect(untouched?.claimId).toBeNull();
      }),
    );

    it.effect(
      "uses default ten, keeps uncertain and warm slots charged, and releases only confirmed capacity",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const organizationId = NodeCrypto.randomUUID();
          const entries = yield* Effect.forEach(Array.from({ length: 11 }), () =>
            seed({ hostId, organizationId }),
          );
          const first = entries[0]!;
          for (let index = 0; index < 10; index++)
            expect(yield* first.capacity.admitNext(hostId, "all")).not.toBeNull();
          expect(yield* first.capacity.admitNext(hostId, "all")).toBeNull();
          yield* first.capacity.beginExecution(first.operationId);
          yield* first.sql`UPDATE relay_workflow_jobs SET status='done' WHERE job_id=${first.workflowJobId}`;
          expect(yield* first.capacity.admitNext(hostId, "all")).toBeNull();
          expect(yield* Effect.isFailure(first.capacity.cancelUnstarted(first.operationId))).toBe(
            true,
          );
          yield* first.capacity.cancelUnstarted(entries[1]!.operationId);
          expect((yield* first.capacity.admitNext(hostId, "all"))?.operationId).toBe(
            entries[10]!.operationId,
          );
        }),
    );

    it.effect("skips organization-blocked head demand without bypassing eligible FIFO", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const blocked = yield* seed({ hostId });
        yield* makeThreadVmPolicyStore(blocked.sql).updateWorkflow({
          organizationId: blocked.organizationId,
          revision: 1,
          maxRunningVms: 0,
        });
        const next = yield* seed({ hostId });
        const last = yield* seed({ hostId, personal: true });
        expect((yield* next.capacity.admitNext(hostId, "all"))?.operationId).toBe(next.operationId);
        expect((yield* last.capacity.admitNext(hostId, "all"))?.operationId).toBe(last.operationId);
        expect((yield* blocked.capacity.get(blocked.operationId))?.state).toBe("waiting");
      }),
    );

    it.effect("serializes cross-host create and resume against one organization allowance", () =>
      Effect.gen(function* () {
        const organizationId = NodeCrypto.randomUUID();
        const create = yield* seed({ hostId: NodeCrypto.randomUUID(), organizationId });
        const resume = yield* seed({
          hostId: NodeCrypto.randomUUID(),
          organizationId,
          kind: "resume",
        });
        yield* makeThreadVmPolicyStore(create.sql).updateWorkflow({
          organizationId,
          revision: 1,
          maxRunningVms: 1,
        });
        const results = yield* Effect.all(
          [
            create.capacity.admitNext(create.hostId, "all"),
            resume.capacity.admitNext(resume.hostId, "all"),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        yield* makeThreadVmPolicyStore(create.sql).updateWorkflow({
          organizationId,
          revision: 2,
          maxRunningVms: 0,
        });
        const admitted = results.find((row) => row !== null)!;
        expect((yield* create.capacity.get(admitted.operationId))?.state).toBe("reserved");
        expect(yield* create.capacity.admitNext(create.hostId, "all")).toBeNull();
        expect(yield* resume.capacity.admitNext(resume.hostId, "all")).toBeNull();
      }),
    );

    it.effect("keeps the host ceiling across organizations and personal resources", () =>
      Effect.gen(function* () {
        const hostId = NodeCrypto.randomUUID();
        const first = yield* seed({ hostId });
        const second = yield* seed({ hostId, personal: true });
        yield* first.capacity.configure(hostId, 1);
        const results = yield* Effect.all(
          Array.from({ length: 6 }, () => first.capacity.admitNext(hostId, "all")),
          { concurrency: "unbounded" },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)?.operationId).toBe(first.operationId);
        expect((yield* second.capacity.get(second.operationId))?.state).toBe("waiting");
      }),
    );

    it.effect(
      "allows private FK requests to progress while admission holds host and organization locks",
      () =>
        Effect.gen(function* () {
          const hostId = NodeCrypto.randomUUID();
          const workflow = yield* seed({ hostId });
          const personal = yield* seed({
            hostId,
            organizationId: workflow.organizationId,
            personal: true,
          });
          const policies = makeThreadVmPolicyStore(workflow.sql);
          yield* policies.updateWorkflow({
            organizationId: workflow.organizationId,
            revision: 1,
            maxRunningVms: 10,
          });
          yield* personal.capacity.cancelUnstarted(personal.operationId);
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const admission = yield* workflow.sql
            .withTransaction(
              Effect.gen(function* () {
                const admitted = yield* workflow.capacity.admitNext(hostId, "all");
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
                return admitted;
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(held);
          const edit = yield* policies
            .updateWorkflow({
              organizationId: workflow.organizationId,
              revision: 2,
              maxRunningVms: 0,
            })
            .pipe(Effect.forkScoped);
          const nextOperationId = NodeCrypto.randomUUID();
          yield* personal.sql.withTransaction(
            Effect.gen(function* () {
              yield* personal.sql`SELECT organization_id FROM relay_thread_vm_policies WHERE organization_id=${workflow.organizationId} FOR SHARE`;
              yield* personal.capacity.request({
                operationId: nextOperationId,
                allocationId: personal.allocationId,
                hostId,
                kind: "create",
              });
            }),
          );
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(admission))?.operationId).toBe(workflow.operationId);
          expect((yield* Fiber.join(edit)).maxRunningVms).toBe(0);
          expect((yield* personal.capacity.get(nextOperationId))?.state).toBe("waiting");
        }),
    );
  });
});
