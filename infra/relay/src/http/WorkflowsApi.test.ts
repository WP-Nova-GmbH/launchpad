import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import type { RespondToWorkflowJob } from "@t3tools/contracts/workflows";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Workflows, type WorkflowJobRecord } from "../jobs/Workflows.ts";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import { Machines } from "../machines/Machines.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { Organizations } from "../tenancy/Organizations.ts";
import { Repositories } from "../tenancy/Repositories.ts";
import {
  authorizeWorkflowRepository,
  respondToWorkflowJob,
  refreshWorkflowJobForClient,
} from "./WorkflowsApi.ts";

it.effect(
  "allows shared job reads/run while checking the responder's current maintainer role",
  () =>
    Effect.gen(function* () {
      const role = yield* Ref.make<"developer" | "maintainer" | null>("developer");
      const membership = {
        organization: { organizationId: "org-1", name: "Org", createdAt: "2026-10-08T00:00:00Z" },
        userId: "user-1",
        role: "member" as const,
        joinedAt: "2026-10-08T00:00:00Z",
      };
      const services = Layer.mergeAll(
        Layer.mock(Organizations)({ getMembershipForUser: () => Effect.succeed(membership) }),
        Layer.mock(Repositories)({
          getById: () =>
            Effect.succeed({
              repositoryId: "repo-1",
              organizationId: "org-1",
              name: "Repo",
              canonicalKeys: [],
              createdAt: "2026-10-08T00:00:00Z",
            }),
          getAccess: () => Ref.get(role),
        }),
      );
      const authorize = (maintain = false) =>
        authorizeWorkflowRepository("repo-1", maintain).pipe(
          Effect.provide(services),
          Effect.provideService(RelayClientPrincipal, { userId: "user-1", token: "token" }),
        );
      assert.strictEqual((yield* authorize()).userId, "user-1");
      assert.strictEqual((yield* Effect.flip(authorize(true)))._tag, "RelayTenancyForbiddenError");
      yield* Ref.set(role, "maintainer");
      assert.strictEqual((yield* authorize(true)).userId, "user-1");
      yield* Ref.set(role, null);
      assert.strictEqual((yield* Effect.flip(authorize()))._tag, "RelayTenancyNotFoundError");
      assert.strictEqual((yield* Effect.flip(authorize(true)))._tag, "RelayTenancyForbiddenError");
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

for (const operation of ["retry_preparation", "retry_cancellation"] as const) {
  it.effect(
    `saves only a current ${operation} and retains its revision until acknowledgement`,
    () =>
      Effect.gen(function* () {
        const now = "2026-10-08T12:00:00.000Z";
        const status =
          operation === "retry_preparation" ? ("paused" as const) : ("cancelling" as const);
        const initial: WorkflowJobRecord = {
          jobId: "job-1",
          organizationId: "org-1",
          repositoryId: "repo-1",
          submitterUserId: "submitter",
          repositoryCanonicalKey: "github.com/acme/repo",
          status,
          revision: 10,
          leaseUntil: null,
          pendingControl: null,
          createdAt: now,
          checkedAt: now,
          record: {
            jobId: "job-1",
            repositoryId: "repo-1",
            workflowId: "workflow-1",
            environmentId: EnvironmentId.make("env-1"),
            instruction: "Fix issue",
            status,
            detail: "Setup failed",
            workflow: null,
            progress: {
              revision: 5,
              status,
              threadId: ThreadId.make("workflow:job-1:agent"),
              detail: "Setup failed",
              checkpoint: null,
              retryablePreparation: true,
              retryableCancellation: true,
            },
            createdAt: now,
            updatedAt: now,
          },
        };
        const row = yield* Ref.make(initial);
        const writes = yield* Ref.make(0);
        const services = Layer.mergeAll(
          Layer.mock(EnvironmentConnector)({}),
          Layer.mock(Machines)({}),
          Layer.mock(OrganizationProjectCatalog)({}),
          Layer.mock(Organizations)({
            getMembershipForUser: () =>
              Effect.succeed({
                organization: { organizationId: "org-1", name: "Org", createdAt: now },
                userId: "maintainer",
                role: "member" as const,
                joinedAt: now,
              }),
          }),
          Layer.mock(Repositories)({
            getById: () =>
              Effect.succeed({
                repositoryId: "repo-1",
                organizationId: "org-1",
                name: "Repo",
                canonicalKeys: [],
                createdAt: now,
              }),
            getAccess: () => Effect.succeed("maintainer" as const),
          }),
          Layer.mock(Workflows)({
            getJob: () => Ref.get(row),
            claim: () => Effect.succeed(null),
            updateJob: (previous, record, pendingControl) =>
              Effect.gen(function* () {
                yield* Ref.update(writes, (count) => count + 1);
                return yield* Ref.setAndGet(row, {
                  ...previous,
                  record,
                  status: record.status,
                  revision: previous.revision + 1,
                  pendingControl: pendingControl ?? null,
                });
              }),
          }),
        );
        const retry = (expectedRevision: number) =>
          respondToWorkflowJob(
            { repositoryId: "repo-1", jobId: "job-1" },
            { operation, expectedRevision },
          ).pipe(
            Effect.provide(services),
            Effect.provideService(RelayClientPrincipal, { userId: "maintainer", token: "token" }),
          );
        assert.strictEqual((yield* Effect.flip(retry(4)))._tag, "WorkflowConflictError");
        assert.strictEqual(yield* Ref.get(writes), 0);
        yield* Ref.update(row, (value) => ({
          ...value,
          record: {
            ...value.record,
            progress: {
              ...value.record.progress!,
              retryablePreparation: false,
              retryableCancellation: false,
            },
          },
        }));
        assert.strictEqual((yield* Effect.flip(retry(5)))._tag, "WorkflowConflictError");
        assert.strictEqual(yield* Ref.get(writes), 0);
        yield* Ref.set(row, initial);
        assert.strictEqual((yield* retry(5)).progress?.revision, 5);
        assert.deepStrictEqual((yield* Ref.get(row)).pendingControl, {
          userId: "maintainer",
          response: { operation, expectedRevision: 5 },
        });
        assert.strictEqual((yield* Effect.flip(retry(5)))._tag, "WorkflowConflictError");
        assert.strictEqual(yield* Ref.get(writes), 1);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
}

it.effect(
  "maintainer cancellation supersedes an unacknowledged approval; retries use the current review",
  () =>
    Effect.gen(function* () {
      const now = "2026-10-09T00:00:00Z";
      const role = yield* Ref.make<"maintainer" | "developer">("maintainer");
      const initial: WorkflowJobRecord = {
        jobId: "job",
        repositoryId: "repo",
        organizationId: "org",
        submitterUserId: "submitter",
        repositoryCanonicalKey: "github.com/acme/repo",
        status: "awaiting_review",
        revision: 10,
        leaseUntil: "in-flight-approval",
        createdAt: now,
        checkedAt: now,
        pendingControl: {
          userId: "first-maintainer",
          response: {
            operation: "approve",
            checkpointId: "saved",
            expectedRevision: 5,
          },
        },
        record: {
          jobId: "job",
          repositoryId: "repo",
          workflowId: "flow",
          environmentId: EnvironmentId.make("env"),
          requiredProtocol: 3,
          instruction: "work",
          workflow: null,
          status: "awaiting_review",
          detail: null,
          createdAt: now,
          updatedAt: now,
          progress: {
            revision: 5,
            status: "awaiting_review",
            threadId: ThreadId.make("workflow:job:agent"),
            detail: null,
            approvalPending: false,
            checkpoint: {
              checkpointId: "saved",
              turnId: "turn",
              checkpointRef: "ref",
              checkpointTurnCount: 1,
            },
          },
        },
      };
      const row = yield* Ref.make(initial);
      const services = Layer.mergeAll(
        Layer.mock(EnvironmentConnector, {}),
        Layer.mock(Machines, {}),
        Layer.mock(OrganizationProjectCatalog, {}),
        Layer.mock(Organizations, {
          getMembershipForUser: () =>
            Effect.succeed({
              organization: { organizationId: "org", name: "Org", createdAt: now },
              userId: "maintainer",
              role: "member",
              joinedAt: now,
            }),
        }),
        Layer.mock(Repositories, {
          getById: () =>
            Effect.succeed({
              repositoryId: "repo",
              organizationId: "org",
              name: "Repo",
              canonicalKeys: [],
              createdAt: now,
            }),
          getAccess: () => Ref.get(role),
        }),
        Layer.mock(Workflows, {
          getJob: () => Ref.get(row),
          claim: () => Effect.succeed(null),
          updateJob: (previous, record, pendingControl) =>
            Ref.setAndGet(row, {
              ...previous,
              record,
              status: record.status,
              revision: previous.revision + 1,
              pendingControl: pendingControl ?? null,
            }),
        }),
      );
      const respond = (payload: Parameters<typeof respondToWorkflowJob>[1]) =>
        respondToWorkflowJob({ repositoryId: "repo", jobId: "job" }, payload).pipe(
          Effect.provide(services),
          Effect.provideService(RelayClientPrincipal, {
            userId: "maintainer",
            token: "token",
          }),
        );
      yield* Ref.set(role, "developer");
      assert.strictEqual(
        (yield* Effect.flip(respond({ operation: "cancel" })))._tag,
        "RelayTenancyForbiddenError",
      );
      yield* Ref.set(role, "maintainer");
      yield* respond({ operation: "cancel" });
      assert.strictEqual((yield* Ref.get(row)).status, "cancelling");
      assert.strictEqual((yield* Ref.get(row)).pendingControl?.response.operation, "cancel");
      assert.isFalse((yield* Ref.get(row)).record.progress?.approvalPending);
      yield* Ref.set(row, {
        ...initial,
        pendingControl: null,
        record: {
          ...initial.record,
          progress: { ...initial.record.progress!, revision: 7, approvalPending: true },
        },
      });
      assert.strictEqual(
        (yield* Effect.flip(
          respond({
            operation: "approve",
            checkpointId: "saved",
            expectedRevision: 7,
          }),
        ))._tag,
        "WorkflowConflictError",
      );
      yield* Ref.update(row, (value) => ({
        ...value,
        record: {
          ...value.record,
          progress: { ...value.record.progress!, approvalPending: false, retryableApproval: true },
        },
      }));
      assert.strictEqual(
        (yield* Effect.flip(
          respond({
            operation: "approve",
            checkpointId: "saved",
            expectedRevision: 5,
          }),
        ))._tag,
        "WorkflowConflictError",
      );
      yield* respond({ operation: "approve", checkpointId: "saved", expectedRevision: 7 });
      assert.deepStrictEqual((yield* Ref.get(row)).pendingControl, {
        userId: "maintainer",
        response: { operation: "approve", checkpointId: "saved", expectedRevision: 7 },
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

for (const checkpointRole of ["member", "maintainer"] as const)
  it.effect(
    `Input honors the frozen ${checkpointRole} checkpoint role and current repository access`,
    () =>
      Effect.gen(function* () {
        const now = "2026-10-12T12:00:00Z";
        const initial: WorkflowJobRecord = {
          jobId: "job",
          repositoryId: "repo",
          organizationId: "org",
          submitterUserId: "user",
          repositoryCanonicalKey: "github.com/acme/repo",
          status: "awaiting_input",
          revision: 1,
          leaseUntil: null,
          pendingControl: null,
          createdAt: now,
          checkedAt: now,
          record: {
            jobId: "job",
            repositoryId: "repo",
            workflowId: "flow",
            environmentId: EnvironmentId.make("env"),
            instruction: "Task",
            status: "awaiting_input",
            detail: null,
            workflow: null,
            createdAt: now,
            updatedAt: now,
            progress: {
              revision: 2,
              status: "awaiting_input",
              threadId: ThreadId.make("workflow:job:agent"),
              detail: null,
              checkpoint: {
                kind: "input",
                checkpointId: "cp",
                stepId: "input",
                generation: 0,
                role: checkpointRole,
                question: "What next?",
              },
            },
          },
        };
        const row = yield* Ref.make(initial);
        const access = yield* Ref.make<"developer" | "maintainer" | null>("developer");
        const services = Layer.mergeAll(
          Layer.mock(Organizations)({
            getMembershipForUser: () =>
              Effect.succeed({
                organization: { organizationId: "org", name: "Org", createdAt: now },
                userId: "user",
                role: "member" as const,
                joinedAt: now,
              }),
          }),
          Layer.mock(Repositories)({
            getById: () =>
              Effect.succeed({
                repositoryId: "repo",
                organizationId: "org",
                name: "Repo",
                canonicalKeys: [],
                createdAt: now,
              }),
            getAccess: () => Ref.get(access),
          }),
          Layer.mock(Machines)({}),
          Layer.mock(OrganizationProjectCatalog)({}),
          Layer.mock(EnvironmentConnector)({}),
          Layer.mock(Workflows)({
            getJob: () => Ref.get(row),
            claim: () => Effect.succeed(null),
            updateJob: (previous, record, pendingControl) =>
              Ref.setAndGet(row, { ...previous, record, pendingControl: pendingControl ?? null }),
          }),
        );
        const respond = (expectedRevision = 2) =>
          respondToWorkflowJob(
            { repositoryId: "repo", jobId: "job" },
            { operation: "input", checkpointId: "cp", expectedRevision, text: "Keep this answer" },
          ).pipe(
            Effect.provide(services),
            Effect.provideService(RelayClientPrincipal, { userId: "user", token: "token" }),
          );
        if (checkpointRole === "maintainer") {
          assert.strictEqual((yield* Effect.flip(respond()))._tag, "RelayTenancyForbiddenError");
          yield* Ref.set(access, "maintainer");
        }
        assert.strictEqual((yield* Effect.flip(respond(1)))._tag, "WorkflowConflictError");
        yield* respond();
        assert.deepStrictEqual((yield* Ref.get(row)).pendingControl, {
          userId: "user",
          response: {
            operation: "input",
            checkpointId: "cp",
            expectedRevision: 2,
            text: "Keep this answer",
          },
        });
        assert.strictEqual((yield* Ref.get(row)).record.requiredProtocol, 5);
        yield* Ref.set(access, null);
        assert.strictEqual((yield* Effect.flip(respond()))._tag, "RelayTenancyNotFoundError");
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

const manualApiHarness = Effect.gen(function* () {
  const now = "2026-10-13T00:00:00Z";
  const role = yield* Ref.make<"maintainer" | "developer">("maintainer");
  const row = yield* Ref.make<WorkflowJobRecord>({
    jobId: "manual-job",
    repositoryId: "repo",
    organizationId: "org",
    submitterUserId: "author",
    repositoryCanonicalKey: "github.com/acme/repo",
    status: "awaiting_input",
    revision: 0,
    leaseUntil: null,
    pendingControl: null,
    createdAt: now,
    checkedAt: now,
    record: {
      jobId: "manual-job",
      repositoryId: "repo",
      workflowId: "flow",
      environmentId: EnvironmentId.make("env"),
      requiredProtocol: 6,
      instruction: "work",
      workflow: null,
      status: "awaiting_input",
      detail: null,
      createdAt: now,
      updatedAt: now,
      progress: {
        revision: 5,
        status: "awaiting_input",
        threadId: ThreadId.make("thread"),
        detail: null,
        manualPauseSupported: true,
        checkpoint: {
          checkpointId: "input",
          kind: "input",
          question: "What?",
          role: "member",
          stepId: "input",
          generation: 0,
        },
      },
    },
  });
  const writes = yield* Ref.make(0);
  const services = Layer.mergeAll(
    Layer.mock(EnvironmentConnector)({}),
    Layer.mock(Machines)({}),
    Layer.mock(OrganizationProjectCatalog)({}),
    Layer.mock(Organizations)({
      getMembershipForUser: () =>
        Effect.succeed({
          organization: { organizationId: "org", name: "Org", createdAt: now },
          userId: "maintainer",
          role: "member" as const,
          joinedAt: now,
        }),
    }),
    Layer.mock(Repositories)({
      getById: () =>
        Effect.succeed({
          repositoryId: "repo",
          organizationId: "org",
          name: "Repo",
          canonicalKeys: [],
          createdAt: now,
        }),
      getAccess: () => Ref.get(role),
    }),
    Layer.mock(Workflows)({
      getJob: () => Ref.get(row),
      claim: () => Effect.succeed(null),
      updateJob: (previous, record, pendingControl) =>
        Effect.gen(function* () {
          yield* Ref.update(writes, (n) => n + 1);
          return yield* Ref.setAndGet(row, {
            ...previous,
            record,
            status: record.status,
            revision: previous.revision + 1,
            pendingControl: pendingControl ?? null,
          });
        }),
    }),
  );
  return {
    row,
    role,
    writes,
    refresh: () => refreshWorkflowJobForClient("manual-job").pipe(Effect.provide(services)),
    respond: (payload: typeof RespondToWorkflowJob.Type) =>
      respondToWorkflowJob({ repositoryId: "repo", jobId: "manual-job" }, payload).pipe(
        Effect.provide(services),
        Effect.provideService(RelayClientPrincipal, { userId: "maintainer", token: "token" }),
      ),
  };
});

it.effect(
  "manual API requests bind the original revision, retry HTTP idempotently and let Cancel supersede them",
  () =>
    Effect.gen(function* () {
      const h = yield* manualApiHarness;
      const pause = { operation: "pause" as const, controlId: "pause", expectedRevision: 5 };
      const saved = yield* h.respond(pause);
      assert.deepStrictEqual(saved.pendingManualControl, pause);
      assert.strictEqual(saved.requiredProtocol, 6);
      assert.strictEqual(saved.status, "awaiting_input");
      yield* h.respond(pause);
      assert.strictEqual(yield* Ref.get(h.writes), 1);
      assert.strictEqual(
        (yield* Effect.flip(h.respond({ ...pause, expectedRevision: 6 })))._tag,
        "WorkflowConflictError",
      );
      yield* Ref.set(h.role, "developer");
      assert.strictEqual((yield* Effect.flip(h.respond(pause)))._tag, "RelayTenancyForbiddenError");
      yield* Ref.set(h.role, "maintainer");
      const cancelled = yield* h.respond({ operation: "cancel" });
      assert.strictEqual(cancelled.status, "cancelling");
      assert.isNull(cancelled.pendingManualControl);
      assert.strictEqual((yield* Ref.get(h.row)).pendingControl?.response.operation, "cancel");
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "manual API eligibility rejects unsupported and unaccepted jobs and blocks member checkpoints under a hold",
  () =>
    Effect.gen(function* () {
      const h = yield* manualApiHarness;
      const pause = { operation: "pause" as const, controlId: "pause", expectedRevision: 5 };
      const initial = yield* Ref.get(h.row);
      yield* Ref.update(h.row, (row) => ({ ...row, record: { ...row.record, progress: null } }));
      assert.strictEqual((yield* Effect.flip(h.respond(pause)))._tag, "WorkflowInvalidError");
      yield* Ref.set(h.row, {
        ...initial,
        record: {
          ...initial.record,
          progress: { ...initial.record.progress!, manualPauseSupported: false },
        },
      });
      assert.strictEqual((yield* Effect.flip(h.respond(pause)))._tag, "WorkflowInvalidError");
      yield* Ref.set(h.row, {
        ...initial,
        status: "paused",
        record: {
          ...initial.record,
          status: "paused",
          progress: {
            ...initial.record.progress!,
            status: "paused",
            underlyingStatus: "awaiting_input",
            manualPause: { state: "paused" },
          },
        },
      });
      yield* Ref.set(h.role, "developer");
      assert.strictEqual(
        (yield* Effect.flip(
          h.respond({
            operation: "input",
            checkpointId: "input",
            expectedRevision: 5,
            text: "answer",
          }),
        ))._tag,
        "WorkflowConflictError",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          h.respond({ operation: "resume", controlId: "resume", expectedRevision: 5 }),
        ))._tag,
        "RelayTenancyForbiddenError",
      );
      assert.strictEqual(yield* Ref.get(h.writes), 0);
      yield* Ref.set(h.role, "maintainer");
      const resumed = yield* h.respond({
        operation: "resume",
        controlId: "resume",
        expectedRevision: 5,
      });
      assert.strictEqual(resumed.pendingManualControl?.operation, "resume");
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("later checkpoint input cannot lower a manual control protocol pin", () =>
  Effect.gen(function* () {
    const h = yield* manualApiHarness;
    const reply = yield* h.respond({
      operation: "input",
      checkpointId: "input",
      expectedRevision: 5,
      text: "answer",
    });
    assert.strictEqual(reply.requiredProtocol, 6);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

for (const operation of ["pause", "input"] as const)
  it.effect(`preserves publishing protocol through ${operation}`, () =>
    Effect.gen(function* () {
      const h = yield* manualApiHarness;
      yield* Ref.update(h.row, (row) => ({
        ...row,
        record: { ...row.record, requiredProtocol: 7 as const },
      }));
      const payload =
        operation === "pause"
          ? { operation, controlId: "hold", expectedRevision: 5 }
          : { operation, checkpointId: "input", expectedRevision: 5, text: "answer" };
      assert.equal((yield* h.respond(payload)).requiredProtocol, 7);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
const automaticOrigin = {
  kind: "automation",
  organizationId: "org",
  repositoryId: "repo",
  workflowId: "flow",
  source: {
    provider: "linear",
    applicationId: "native-app",
    workspaceId: "workspace",
    connectionId: "connection",
    grantId: "grant",
  },
  occurrenceId: "event",
} as const;

for (const operation of ["pause", "resume", "input", "request_changes"] as const)
  it.effect(
    `saves automatic ${operation} with its protocol, actor and pending response intact`,
    () =>
      Effect.gen(function* () {
        const h = yield* manualApiHarness;
        const origin = automaticOrigin;
        const status =
          operation === "resume"
            ? "paused"
            : operation === "request_changes"
              ? "awaiting_review"
              : "awaiting_input";
        yield* Ref.update(
          h.row,
          (row) =>
            ({
              ...row,
              status,
              submitterUserId: null,
              record: {
                ...row.record,
                status,
                origin,
                requiredProtocol: 8,
                progress: {
                  ...row.record.progress!,
                  status,
                  ...(operation === "resume"
                    ? {
                        manualPause: { state: "paused" as const },
                        underlyingStatus: "awaiting_input" as const,
                      }
                    : {}),
                  ...(operation === "request_changes"
                    ? {
                        checkpoint: {
                          kind: "review" as const,
                          role: "member" as const,
                          checkpointId: "review",
                          turnId: "turn",
                          checkpointRef: "ref",
                          checkpointTurnCount: 1,
                        },
                      }
                    : {}),
                },
              },
            }) satisfies WorkflowJobRecord,
        );
        const payload =
          operation === "pause" || operation === "resume"
            ? { operation, controlId: "control", expectedRevision: 5 }
            : {
                operation,
                checkpointId: operation === "input" ? "input" : "review",
                expectedRevision: 5,
                text: "Keep this response",
              };
        const saved = yield* h.respond(payload);
        assert.strictEqual(saved.requiredProtocol, 8);
        assert.deepStrictEqual(saved.origin, origin);
        const row = yield* Ref.get(h.row);
        assert.isNull(row.submitterUserId);
        assert.deepStrictEqual(row.pendingControl, { userId: "maintainer", response: payload });
        assert.strictEqual(yield* Ref.get(h.writes), 1);
        if (payload.operation === "pause" || payload.operation === "resume") {
          assert.deepStrictEqual(saved.pendingManualControl, payload);
          yield* h.respond(payload);
          assert.strictEqual(yield* Ref.get(h.writes), 1);
        }
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

for (const operation of ["approve", "input", "request_changes"] as const)
  it.effect(`exposes a durable pending ${operation} on every read until acknowledgement`, () =>
    Effect.gen(function* () {
      const h = yield* manualApiHarness;
      const status = operation === "input" ? "awaiting_input" : "awaiting_review";
      const checkpointId = operation === "input" ? "input" : "review";
      yield* Ref.update(
        h.row,
        (row) =>
          ({
            ...row,
            submitterUserId: null,
            status,
            record: {
              ...row.record,
              origin: automaticOrigin,
              requiredProtocol: 8,
              status,
              progress: {
                ...row.record.progress!,
                status,
                ...(operation === "input"
                  ? {}
                  : {
                      checkpoint: {
                        kind: "review" as const,
                        role: "member" as const,
                        checkpointId,
                        turnId: "turn",
                        checkpointRef: "ref",
                        checkpointTurnCount: 1,
                      },
                    }),
              },
            },
          }) satisfies WorkflowJobRecord,
      );
      const payload =
        operation === "approve"
          ? { operation, checkpointId, expectedRevision: 5 }
          : { operation, checkpointId, expectedRevision: 5, text: "Keep this response" };
      const pending = yield* h.respond(payload);
      assert.isTrue(pending.responsePending);
      assert.isTrue((yield* h.refresh())!.responsePending);
      assert.isUndefined((yield* Ref.get(h.row)).record.responsePending);
      assert.strictEqual((yield* Ref.get(h.row)).pendingControl?.response.operation, operation);
      yield* Ref.update(
        h.row,
        (row) =>
          ({
            ...row,
            pendingControl: null,
            status: "running",
            record: {
              ...row.record,
              status: "running",
              progress: {
                ...row.record.progress!,
                revision: 6,
                status: "running",
                checkpoint: null,
              },
            },
          }) satisfies WorkflowJobRecord,
      );
      assert.isFalse((yield* h.refresh())!.responsePending);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

it.effect(
  "Cancel supersedes a pending response and terminal reads clear the pending indicator",
  () =>
    Effect.gen(function* () {
      const h = yield* manualApiHarness;
      yield* h.respond({
        operation: "input",
        checkpointId: "input",
        expectedRevision: 5,
        text: "Answer",
      });
      const cancelled = yield* h.respond({ operation: "cancel" });
      assert.strictEqual(cancelled.status, "cancelling");
      assert.isTrue(cancelled.responsePending);
      assert.strictEqual((yield* Ref.get(h.row)).pendingControl?.response.operation, "cancel");
      yield* Ref.update(
        h.row,
        (row) =>
          ({
            ...row,
            status: "cancelled",
            record: { ...row.record, status: "cancelled" },
          }) satisfies WorkflowJobRecord,
      );
      assert.isFalse((yield* h.refresh())!.responsePending);
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "binds publishing retries to current action/revision and preserves pending/replayed receipts",
  () =>
    Effect.gen(function* () {
      const h = yield* manualApiHarness;
      const action = {
        actionId: "publish",
        stepId: "push",
        generation: 1,
        operation: "push" as const,
        state: "uncertain" as const,
        retryable: true,
        detail: "Lost reply",
        commitSha: "sha",
        pullRequestUrl: null,
      };
      yield* Ref.update(h.row, (row) => ({
        ...row,
        status: "paused" as const,
        record: {
          ...row.record,
          status: "paused" as const,
          requiredProtocol: 7 as const,
          progress: {
            ...row.record.progress!,
            status: "paused" as const,
            stepId: "push",
            generation: 1,
            checkpoint: null,
            actions: [action],
          },
        },
      }));
      const payload = {
        operation: "retry_action" as const,
        actionId: "publish",
        expectedRevision: 5,
      };
      assert.equal((yield* h.respond(payload)).requiredProtocol, 7);
      assert.equal(yield* Ref.get(h.writes), 1);
      yield* h.respond(payload);
      assert.equal(yield* Ref.get(h.writes), 1);
      yield* Ref.update(h.row, (row) => ({
        ...row,
        pendingControl: null,
        record: {
          ...row.record,
          progress: {
            ...row.record.progress!,
            revision: 7,
            actions: [{ ...action, state: "running" as const, retryable: false, retryRevision: 5 }],
          },
        },
      }));
      yield* h.respond(payload);
      assert.equal(yield* Ref.get(h.writes), 1);
      assert.equal(
        (yield* h.respond({ ...payload, expectedRevision: 4 }).pipe(Effect.flip))._tag,
        "WorkflowConflictError",
      );
      yield* Ref.set(h.role, "developer");
      assert.equal(
        (yield* h.respond(payload).pipe(Effect.flip))._tag,
        "RelayTenancyForbiddenError",
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
);
