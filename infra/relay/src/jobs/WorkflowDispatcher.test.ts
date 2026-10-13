import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  WorkflowInvalidError,
  WorkflowConflictError,
  type RepositoryWorkflow,
  type WorkflowControlResult,
  type WorkflowControl,
} from "@t3tools/contracts/workflows";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  EnvironmentConnector,
  EnvironmentMintRequestTimedOut,
} from "../environments/EnvironmentConnector.ts";
import { Machines, type MachineRecord } from "../machines/Machines.ts";
import { OrganizationProjectCatalog } from "../projects/OrganizationProjectCatalog.ts";
import { Organizations } from "../tenancy/Organizations.ts";
import { Repositories, RepositoryPersistenceError } from "../tenancy/Repositories.ts";
import { Workflows, type WorkflowJobRecord } from "./Workflows.ts";
import { refreshWorkflowJob, validateWorkflowTarget } from "./WorkflowDispatcher.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const workflow: RepositoryWorkflow = {
  workflowId: "flow-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  revision: 1,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  definition: {
    name: "Implement",
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
    steps: [
      {
        id: "agent",
        kind: "agent",
        title: "Agent",
        instruction: "Implement",
        modelSelection: null,
      },
      { id: "review", kind: "review", title: "Review", role: "maintainer" },
    ],
  },
};
const machine: MachineRecord = {
  machineId: "machine-1",
  organizationId: "org-1",
  role: "agent_executor",
  label: "Executor",
  computeKind: "docker",
  computeRef: null,
  seedExpiresAt: NOW,
  environmentId: "env-1",
  environmentPublicKey: "key",
  endpointHttpBaseUrl: "https://env.example",
  endpointWsBaseUrl: "wss://env.example",
  endpointProviderKind: "cloudflare_tunnel",
  createdByUserId: "user-1",
  enrolledAt: NOW,
  deprovisionedAt: null,
  createdAt: NOW,
};
const initial: WorkflowJobRecord = {
  jobId: "job-1",
  repositoryId: "repo-1",
  organizationId: "org-1",
  submitterUserId: "user-1",
  repositoryCanonicalKey: null,
  status: "queued",
  revision: 0,
  leaseUntil: null,
  pendingControl: null,
  createdAt: NOW,
  checkedAt: NOW,
  record: {
    jobId: "job-1",
    repositoryId: "repo-1",
    workflowId: "flow-1",
    environmentId: workflow.definition.environmentId,
    instruction: "Fix issue",
    status: "queued",
    detail: null,
    workflow: null,
    progress: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
};
const accepted: WorkflowControlResult = {
  protocol: 5,
  outcome: "accepted",
  detail: null,
  progress: {
    revision: 1,
    status: "running",
    threadId: ThreadId.make("workflow:job-1:agent"),
    detail: null,
    checkpoint: null,
  },
};
const missing: WorkflowControlResult = {
  protocol: 5,
  outcome: "missing",
  detail: null,
  progress: null,
};

const harness = Effect.gen(function* () {
  const row = yield* Ref.make(initial);
  const definition = yield* Ref.make(workflow);
  const target = yield* Ref.make<MachineRecord | null>(machine);
  const mode = yield* Ref.make<
    | "online"
    | "offline"
    | "lost_start"
    | "busy"
    | "missing"
    | "old"
    | "legacy"
    | "protocol2"
    | "protocol3"
    | "cancel_during_approve"
  >("online");
  const permissionOutage = yield* Ref.make(false);
  const role = yield* Ref.make<"maintainer" | "developer" | null>("maintainer");
  const reply = yield* Ref.make<WorkflowControlResult | null>(null);
  const offers = yield* Ref.make<ReadonlyArray<RepositoryWorkflow>>([]);
  const controls = yield* Ref.make<ReadonlyArray<WorkflowControl>>([]);
  const layer = Layer.mergeAll(
    Layer.mock(Organizations)({
      getMembershipForUser: ({ userId }) =>
        Effect.succeed({
          organization: { organizationId: "org-1", name: "Org", createdAt: NOW },
          userId,
          role: "member" as const,
          joinedAt: NOW,
        }),
    }),
    Layer.mock(Workflows)({
      get: () => Ref.get(definition),
      getJob: () => Ref.get(row),
      claim: () =>
        Ref.modify(row, (value) =>
          value.leaseUntil
            ? [null, value]
            : [
                { ...value, leaseUntil: "lease-1" },
                { ...value, leaseUntil: "lease-1" },
              ],
        ),
      updateJob: (
        previous,
        record,
        pendingControl = previous.pendingControl,
        releaseLease = true,
      ) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(row)).revision !== previous.revision)
            return yield* new WorkflowConflictError({ message: "Job changed" });
          return yield* Ref.updateAndGet(row, (value) => ({
            ...value,
            record,
            status: record.status,
            repositoryCanonicalKey: previous.repositoryCanonicalKey,
            pendingControl,
            revision: value.revision + 1,
            leaseUntil: releaseLease ? null : value.leaseUntil,
          }));
        }),
      release: (_id, leaseUntil) =>
        Ref.update(row, (value) =>
          value.leaseUntil === leaseUntil ? { ...value, leaseUntil: null } : value,
        ),
    }),
    Layer.mock(Machines)({ getActiveByEnvironmentId: () => Ref.get(target) }),
    Layer.mock(Repositories)({
      getAccess: () =>
        Ref.get(permissionOutage).pipe(
          Effect.flatMap((offline) =>
            offline
              ? Effect.fail(
                  new RepositoryPersistenceError({
                    operation: "load-access",
                    cause: "Permission store unavailable",
                  }),
                )
              : Ref.get(role),
          ),
        ),
      getById: () =>
        Effect.succeed({
          repositoryId: "repo-1",
          organizationId: "org-1",
          name: "Repo",
          canonicalKeys: ["github.com/acme/repo"],
          createdAt: NOW,
        }),
    }),
    Layer.mock(OrganizationProjectCatalog)({
      listForOrganization: () =>
        Effect.succeed([
          {
            environmentId: "env-1",
            machineId: "machine-1",
            machineLabel: "Executor",
            projectId: "wrong-checkout",
            title: "Wrong",
            repositoryCanonicalKey: "github.com/acme/wrong",
            createdAt: NOW,
            updatedAt: NOW,
            catalogUpdatedAt: NOW,
          },
          {
            environmentId: "env-1",
            machineId: "machine-1",
            machineLabel: "Executor",
            projectId: "project-1",
            title: "Repo",
            repositoryCanonicalKey: "github.com/acme/repo",
            createdAt: NOW,
            updatedAt: NOW,
            catalogUpdatedAt: NOW,
          },
        ]),
    }),
    Layer.mock(EnvironmentConnector)({
      dispatchJob: (input) =>
        Effect.gen(function* () {
          if (input.workflowControl)
            yield* Ref.update(controls, (all) => [...all, input.workflowControl!]);
          const current = yield* Ref.get(mode);
          if (current === "offline")
            return yield* new EnvironmentMintRequestTimedOut({
              environmentId: "env-1",
              operation: "dispatch-job",
              timeoutMs: 5000,
            });
          if (current === "protocol3")
            return {
              accepted: false,
              workflowResult: { ...((yield* Ref.get(reply)) ?? missing), protocol: 3 as const },
            };
          if (current === "protocol2")
            return {
              accepted: false,
              workflowResult: { ...((yield* Ref.get(reply)) ?? missing), protocol: 2 as const },
            };
          if (
            current === "cancel_during_approve" &&
            input.workflowControl?.operation === "approve"
          ) {
            yield* Ref.update(row, (value) => ({
              ...value,
              revision: value.revision + 1,
              status: "cancelling" as const,
              record: { ...value.record, status: "cancelling" as const },
              pendingControl: { userId: "canceller", response: { operation: "cancel" as const } },
            }));
          }
          const override = yield* Ref.get(reply);
          if (override) return { accepted: true, workflowResult: override };
          if (current === "old") return { accepted: true };
          if (current === "legacy")
            return { accepted: false, workflowResult: { ...missing, protocol: 1 as const } };
          if (input.workflowControl?.operation === "start") {
            yield* Ref.update(offers, (all) => [
              ...all,
              input.workflowControl!.operation === "start"
                ? input.workflowControl!.workflow
                : workflow,
            ]);
            if (current === "lost_start")
              return yield* new EnvironmentMintRequestTimedOut({
                environmentId: "env-1",
                operation: "dispatch-job",
                timeoutMs: 5000,
              });
            if (current === "busy")
              return { accepted: false, workflowResult: { ...missing, outcome: "busy" as const } };
            return { accepted: true, workflowResult: accepted };
          }
          if (input.workflowControl?.operation === "cancel")
            return {
              accepted: false,
              workflowResult:
                current === "missing"
                  ? { ...missing, protocol: 1 }
                  : { ...missing, outcome: "cancelled" as const },
            };
          if (input.workflowControl?.operation === "retry_preparation")
            return {
              accepted: true,
              workflowResult: {
                ...accepted,
                progress: {
                  ...accepted.progress!,
                  status: "preparing" as const,
                  revision: input.workflowControl.expectedRevision + 1,
                },
              },
            };
          if (input.workflowControl?.operation === "retry_cancellation")
            return {
              accepted: true,
              workflowResult: {
                ...accepted,
                progress: {
                  ...accepted.progress!,
                  status: "cancelling" as const,
                  revision: input.workflowControl.expectedRevision + 1,
                },
              },
            };
          return {
            accepted: true,
            workflowResult: ((yield* Ref.get(row)).record.progress ?? null) ? accepted : missing,
          };
        }),
    }),
  );
  return {
    row,
    reply,
    definition,
    target,
    mode,
    offers,
    controls,
    role,
    permissionOutage,
    refresh: refreshWorkflowJob("job-1").pipe(Effect.provide(layer)),
    validate: validateWorkflowTarget("org-1", "repo-1", workflow.definition).pipe(
      Effect.provide(layer),
    ),
  };
});

for (const operation of ["retry_preparation", "retry_cancellation"] as const)
  it.effect(`redelivers a pending ${operation} with its original observed revision`, () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.refresh;
      const response = { operation, expectedRevision: 5 };
      const status =
        operation === "retry_preparation" ? ("paused" as const) : ("cancelling" as const);
      yield* Ref.update(h.row, (value) => ({
        ...value,
        status,
        record: {
          ...value.record,
          status,
          progress: {
            ...accepted.progress!,
            status,
            revision: 5,
            retryablePreparation: operation === "retry_preparation",
            retryableCancellation: operation === "retry_cancellation",
          },
        },
        pendingControl: { userId: "maintainer", response },
      }));
      yield* Ref.set(h.mode, "offline");
      yield* h.refresh;
      assert.deepStrictEqual((yield* Ref.get(h.row)).pendingControl?.response, response);
      yield* Ref.set(h.mode, "online");
      yield* h.refresh;
      assert.deepStrictEqual(
        (yield* Ref.get(h.controls)).filter((control) => control.operation === operation),
        [
          {
            organizationId: "org-1",
            repositoryId: "repo-1",
            projectId: workflow.definition.projectId,
            ...response,
          },
          {
            organizationId: "org-1",
            repositoryId: "repo-1",
            projectId: workflow.definition.projectId,
            ...response,
          },
        ],
      );
      assert.isNull((yield* Ref.get(h.row)).pendingControl);
      assert.strictEqual((yield* Ref.get(h.row)).record.progress?.revision, 6);
    }),
  );

it.effect("retains offline jobs and negotiates capability before creating an offer", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.mode, "offline");
    assert.strictEqual((yield* h.refresh)?.status, "queued");
    assert.isNull((yield* Ref.get(h.row)).record.workflow);
    yield* Ref.set(h.mode, "old");
    yield* h.refresh;
    assert.strictEqual((yield* Ref.get(h.offers)).length, 0);
    assert.include((yield* Ref.get(h.row)).record.detail!, "Update this environment");
    yield* Ref.set(h.mode, "online");
    assert.strictEqual((yield* h.refresh)?.status, "running");
  }),
);

it.effect("requires the fence-aware protocol before offering a workflow", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.mode, "legacy");
    yield* h.refresh;
    assert.strictEqual((yield* Ref.get(h.offers)).length, 0);
    assert.isNull((yield* Ref.get(h.row)).record.workflow);
    assert.include((yield* Ref.get(h.row)).record.detail!, "Update this environment");
  }),
);

it.effect(
  "pins uncertain offers across relay recovery and adopts edits only after explicit busy refusal",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.mode, "lost_start");
      yield* h.refresh;
      assert.strictEqual((yield* Ref.get(h.row)).record.status, "dispatching");
      yield* Ref.update(h.definition, (value) => ({ ...value, revision: 2 }));
      yield* Ref.set(h.mode, "online");
      yield* h.refresh;
      assert.deepStrictEqual(
        (yield* Ref.get(h.offers)).map((value) => value.revision),
        [1, 1],
      );
      const busy = yield* harness;
      yield* Ref.set(busy.mode, "busy");
      yield* busy.refresh;
      assert.isNull((yield* Ref.get(busy.row)).record.workflow);
      yield* Ref.update(busy.definition, (value) => ({ ...value, revision: 2 }));
      yield* Ref.set(busy.mode, "online");
      yield* busy.refresh;
      assert.deepStrictEqual(
        (yield* Ref.get(busy.offers)).map((value) => value.revision),
        [1, 2],
      );
    }),
);

it.effect("cancels queued work locally and keeps uncertain/offline cancellation pending", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.update(h.row, (value) => ({
      ...value,
      pendingControl: { userId: "maintainer", response: { operation: "cancel" as const } },
    }));
    assert.strictEqual((yield* h.refresh)?.status, "cancelled");
    assert.strictEqual((yield* Ref.get(h.offers)).length, 0);
    const offered = yield* harness;
    yield* Ref.set(offered.mode, "lost_start");
    yield* offered.refresh;
    yield* Ref.update(offered.row, (value) => ({
      ...value,
      status: "cancelling" as const,
      record: { ...value.record, status: "cancelling" as const },
      pendingControl: { userId: "maintainer", response: { operation: "cancel" as const } },
    }));
    yield* Ref.set(offered.mode, "offline");
    assert.strictEqual((yield* offered.refresh)?.status, "cancelling");
    assert.isNotNull((yield* Ref.get(offered.row)).pendingControl);
    yield* Ref.set(offered.mode, "missing");
    assert.strictEqual((yield* offered.refresh)?.status, "cancelling");
    assert.isNotNull((yield* Ref.get(offered.row)).pendingControl);
    yield* Ref.set(offered.mode, "online");
    assert.strictEqual((yield* offered.refresh)?.status, "cancelled");
    assert.strictEqual((yield* offered.refresh)?.status, "cancelled");
  }),
);

it.effect(
  "uses the exact enrolled checkout and refuses other organizations and personal environments",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      assert.strictEqual(yield* h.validate, "github.com/acme/repo");
      yield* Ref.set(h.target, { ...machine, organizationId: "another-org" });
      assert.instanceOf(yield* Effect.flip(h.validate), WorkflowInvalidError);
      yield* Ref.set(h.target, null);
      assert.instanceOf(yield* Effect.flip(h.validate), WorkflowInvalidError);
    }),
);

it.effect("pins protocol 4 with the offer and rejects downgrade completion or approval", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.refresh;
    assert.strictEqual((yield* Ref.get(h.row)).record.requiredProtocol, 5);
    const progress = { ...accepted.progress!, status: "done" as const, revision: 20 };
    yield* Ref.set(h.reply, { ...accepted, progress });
    yield* Ref.set(h.mode, "protocol2");
    const held = yield* h.refresh;
    assert.strictEqual(held?.status, "running");
    assert.include(held!.detail!, "Update this environment");
    assert.strictEqual((yield* Ref.get(h.row)).record.workflow?.revision, 1);
    yield* Ref.update(h.row, (row) => ({
      ...row,
      status: "awaiting_review" as const,
      record: {
        ...row.record,
        status: "awaiting_review" as const,
        progress: {
          ...accepted.progress!,
          status: "awaiting_review" as const,
          revision: 5,
          checkpoint: {
            checkpointId: "saved",
            turnId: "turn",
            checkpointRef: "ref",
            checkpointTurnCount: 1,
          },
        },
      },
      pendingControl: {
        userId: "maintainer",
        response: {
          operation: "approve" as const,
          expectedRevision: 5,
          checkpointId: "saved",
        },
      },
    }));
    yield* h.refresh;
    assert.strictEqual(
      (yield* Ref.get(h.controls)).filter((control) => control.operation === "approve").length,
      0,
    );
    assert.isNotNull((yield* Ref.get(h.row)).pendingControl);
  }),
);
it.effect(
  "acknowledges pending approval, follows later progress and loses CAS to cancellation",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.refresh;
      const pending = {
        ...accepted.progress!,
        status: "awaiting_review" as const,
        revision: 6,
        approvalPending: true,
        checkpoint: {
          checkpointId: "saved",
          turnId: "turn",
          checkpointRef: "ref",
          checkpointTurnCount: 1,
        },
      };
      yield* Ref.update(h.row, (row) => ({
        ...row,
        status: "awaiting_review" as const,
        record: {
          ...row.record,
          status: "awaiting_review" as const,
          progress: { ...pending, revision: 5, approvalPending: false },
        },
        pendingControl: {
          userId: "maintainer",
          response: {
            operation: "approve" as const,
            expectedRevision: 5,
            checkpointId: "saved",
          },
        },
      }));
      yield* Ref.set(h.reply, { ...accepted, progress: pending });
      assert.isTrue((yield* h.refresh)?.progress?.approvalPending);
      assert.isNull((yield* Ref.get(h.row)).pendingControl);
      yield* Ref.set(h.reply, {
        ...accepted,
        progress: {
          ...pending,
          revision: 7,
          approvalPending: false,
          retryableApproval: true,
        },
      });
      assert.isTrue((yield* h.refresh)?.progress?.retryableApproval);
      yield* Ref.update(h.row, (row) => ({
        ...row,
        pendingControl: {
          userId: "maintainer",
          response: {
            operation: "approve" as const,
            expectedRevision: 7,
            checkpointId: "saved",
          },
        },
      }));
      yield* Ref.set(h.reply, {
        ...accepted,
        progress: { ...pending, revision: 9, status: "done", approvalPending: false },
      });
      yield* Ref.set(h.mode, "cancel_during_approve");
      const cancelled = yield* h.refresh;
      assert.strictEqual(cancelled?.status, "cancelling");
      assert.strictEqual((yield* Ref.get(h.row)).pendingControl?.response.operation, "cancel");
    }),
);

it.effect(
  "an active V3 offer upgrades before progress and preserves its pending control on downgrade",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.refresh;
      yield* Ref.update(h.row, (row) => ({
        ...row,
        record: { ...row.record, requiredProtocol: 3 as const },
        pendingControl: { userId: "maintainer", response: { operation: "cancel" as const } },
      }));
      const before = yield* Ref.get(h.row);
      yield* Ref.set(h.reply, {
        ...accepted,
        progress: { ...accepted.progress!, revision: 20, status: "done" },
      });
      yield* Ref.set(h.mode, "protocol3");
      const held = yield* h.refresh;
      const after = yield* Ref.get(h.row);
      assert.strictEqual(held?.requiredProtocol, 4);
      assert.strictEqual(held?.status, "running");
      assert.deepStrictEqual(after.pendingControl, before.pendingControl);
      assert.deepStrictEqual(after.record.workflow, before.record.workflow);
      assert.include(held!.detail!, "Update this environment");
    }),
);

it.effect("rechecks saved checkpoint roles before delivering after reconnect", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.refresh;
    const checkpoint = {
      kind: "input" as const,
      checkpointId: "input-1",
      stepId: "brief",
      generation: 0,
      question: "What next?",
      role: "member" as const,
    };
    const saveResponse = (role: "member" | "maintainer") =>
      Ref.update(h.row, (row) => ({
        ...row,
        pendingControl: {
          userId: "responder",
          response: {
            operation: "input" as const,
            checkpointId: "input-1",
            expectedRevision: 3,
            text: "Answer",
          },
        },
        record: {
          ...row.record,
          status: "awaiting_input" as const,
          progress: {
            ...accepted.progress!,
            revision: 3,
            status: "awaiting_input" as const,
            checkpoint: { ...checkpoint, role },
          },
        },
      }));
    yield* saveResponse("maintainer");
    yield* Ref.set(h.permissionOutage, true);
    yield* h.refresh;
    assert.isNotNull((yield* Ref.get(h.row)).pendingControl);
    yield* Ref.set(h.permissionOutage, false);
    yield* Ref.set(h.role, "developer");
    yield* saveResponse("maintainer");
    const blocked = yield* h.refresh;
    assert.include(blocked!.detail!, "no longer has permission");
    assert.isNull((yield* Ref.get(h.row)).pendingControl);
    assert.lengthOf(
      (yield* Ref.get(h.controls)).filter((control) => control.operation === "input"),
      0,
    );
    yield* saveResponse("member");
    yield* h.refresh;
    assert.lengthOf(
      (yield* Ref.get(h.controls)).filter((control) => control.operation === "input"),
      1,
    );
  }),
);
