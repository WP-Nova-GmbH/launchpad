import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
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
import { authorizeWorkflowRepository, respondToWorkflowJob } from "./WorkflowsApi.ts";

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
