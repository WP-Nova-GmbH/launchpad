import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { RelayClientPrincipal } from "@t3tools/contracts/relay";
import { WORKFLOW_PROTOCOL, type WorkflowControlResult } from "@t3tools/contracts/workflows";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { EnvironmentConnector } from "../environments/EnvironmentConnector.ts";
import {
  respondToWorkflowJob,
  runRepositoryWorkflow,
  saveRepositoryWorkflow,
} from "../http/WorkflowsApi.ts";
import { layer as machines } from "../machines/Machines.ts";
import { layer as catalog } from "../projects/OrganizationProjectCatalog.ts";
import { layer as organizations } from "../tenancy/Organizations.ts";
import { layer as repositories } from "../tenancy/Repositories.ts";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { configured, save, seed, trigger } from "../workflowEvents/test-fixture.ts";
import { databaseUrl, withDatabase } from "../workflowSources/test-fixture.ts";
import { Workflows, layer as workflows } from "./Workflows.ts";

if (!databaseUrl)
  throw new Error("Manual workflow dispatch tests require WORKFLOW_SOURCES_TEST_DATABASE_URL.");

describe("initial manual workflow offer (PostgreSQL)", () => {
  for (const delayedOperation of ["status", "start"] as const)
    it.live(`reconciles a VM edit while the Machine ${delayedOperation} request is in flight`, () =>
      withDatabase(
        configured(
          Effect.gen(function* () {
            yield* seed;
            const original = yield* save("flow", trigger, false);
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const operations = yield* Ref.make<string[]>([]);
            const connector = Layer.mock(EnvironmentConnector)({
              dispatchJob: (input) =>
                Effect.gen(function* () {
                  const control = input.workflowControl;
                  expect(input.environmentId).toBe("environment");
                  expect(control?.projectId).toBe("project");
                  yield* Ref.update(operations, (seen) => [...seen, control!.operation]);
                  if (control?.operation === delayedOperation) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  if (control?.operation === "start") expect(control.workflow).toEqual(original);
                  const workflowResult: WorkflowControlResult = {
                    protocol: WORKFLOW_PROTOCOL,
                    outcome:
                      control?.operation === "start"
                        ? "accepted"
                        : control?.operation === "cancel"
                          ? "cancelled"
                          : "missing",
                    detail: null,
                    progress:
                      control?.operation === "start"
                        ? {
                            revision: 1,
                            status: "running",
                            threadId: ThreadId.make("thread"),
                            detail: null,
                            checkpoint: null,
                          }
                        : null,
                  };
                  return { accepted: true, workflowResult };
                }),
            });
            const store = yield* Workflows;
            const run = yield* runRepositoryWorkflow("repo", {
              workflowId: original.workflowId,
              instruction: "Test",
            }).pipe(Effect.provide(connector), Effect.forkChild);
            yield* Deferred.await(entered);
            const [pending] = yield* store.listJobs("repo");
            expect(pending?.record.runtime).toEqual(
              delayedOperation === "status" ? null : original.definition.target,
            );
            yield* saveRepositoryWorkflow("repo", {
              workflowId: original.workflowId,
              expectedRevision: original.revision,
              definition: { ...original.definition, target: { kind: "vm", baseBranch: null } },
              archived: false,
            }).pipe(Effect.provide(connector));
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(run);
            if (delayedOperation === "status") {
              expect(result).toMatchObject({
                status: "queued",
                workflow: null,
                runtime: null,
                detail: "Running VM workflows is not available yet.",
              });
            } else {
              expect(result).toMatchObject({
                status: "running",
                workflow: original,
                runtime: original.definition.target,
              });
            }
            const cancelled = yield* respondToWorkflowJob(
              { repositoryId: "repo", jobId: result.jobId },
              { operation: "cancel" },
            ).pipe(Effect.provide(connector));
            expect(cancelled.status).toBe("cancelled");
            expect(yield* Ref.get(operations)).toEqual(
              delayedOperation === "status" ? ["status"] : ["status", "start", "cancel"],
            );
          }).pipe(
            Effect.provide([machines, repositories, organizations, catalog, workflows]),
            Effect.provideService(ThreadVmRuntimeConfiguration, { settings: undefined }),
            Effect.provideService(RelayClientPrincipal, { userId: "maintainer", token: "fixture" }),
          ),
        ),
      ),
    );
});
