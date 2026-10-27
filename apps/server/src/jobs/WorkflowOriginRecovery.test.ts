import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { make as makeRunner } from "./RepositoryWorkflowRunner.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { HttpServerRequest } from "effect/unstable/http";
import { type WorkflowOrigin } from "@t3tools/contracts";
import { WorkflowControlResult } from "@t3tools/contracts/workflows";
import {
  RelayEnvironmentDispatchJobResponse,
  RelayEnvironmentDispatchJobResponseProofPayload,
} from "@t3tools/contracts/relay";
import {
  signRelayJwt,
  verifyRelayJwt,
  RELAY_DISPATCH_JOB_REQUEST_TYP,
  RELAY_DISPATCH_JOB_RESPONSE_TYP,
} from "@t3tools/shared/relayJwt";
import { cloudDispatchJobHandler } from "../cloud/http.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../cloud/config.ts";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { WorkflowActions } from "./WorkflowActions.ts";
import {
  harness as publishingHarness,
  id as publishingId,
} from "./WorkflowActions.test-fixture.ts";
import { WorkflowRunStore } from "./WorkflowRunStore.ts";
import {
  harness,
  workflowAccess,
  test,
  workflow,
  request,
  control,
  retryRequest,
} from "./RepositoryWorkflowRunner.test-fixture.ts";
import type { WorkflowRequest } from "./RepositoryWorkflowRunner.ts";

const origin: WorkflowOrigin = {
  kind: "automation",
  organizationId: "org-1",
  repositoryId: "repo-1",
  workflowId: workflow.workflowId,
  source: {
    provider: "linear",
    applicationId: "app",
    workspaceId: "workspace",
    connectionId: "connection",
    grantId: "grant",
  },
  occurrenceId: "event",
};
const automated = (input: WorkflowRequest): WorkflowRequest => {
  const { userId: _, ...rest } = input;
  return { ...rest, origin };
};
const legacyResult = WorkflowControlResult.mapFields((fields) => ({
  ...fields,
  protocol: Schema.Literals([1, 2, 3, 4, 5, 6, 7]),
}));
const decodeLegacyResponse = Schema.decodeUnknownSync(
  RelayEnvironmentDispatchJobResponse.mapFields((fields) => ({
    ...fields,
    workflowResult: Schema.optional(legacyResult),
  })),
);
const decodeLegacyProof = Schema.decodeUnknownSync(
  RelayEnvironmentDispatchJobResponseProofPayload.mapFields((fields) => ({
    ...fields,
    workflowResult: Schema.optional(legacyResult),
  })),
);
const issuer = "https://relay.example.test";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const signedHarness = (publishing = false) =>
  Effect.gen(function* () {
    const h = yield* harness;
    const auth = yield* workflowAccess(h);
    const relay = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const environment = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const bytes = (s: string) => new TextEncoder().encode(s);
    yield* auth.secrets.set(CLOUD_MINT_PUBLIC_KEY, bytes(relay.publicKey));
    yield* auth.secrets.set(RELAY_ISSUER_SECRET, bytes(issuer));
    yield* auth.secrets.set("cloud-link-ed25519-key-pair", bytes(encodeJson(environment)));
    const createRunner = h.newRunner.pipe(
      Effect.provideService(RepositoryAccess, auth.access),
      Effect.provideService(WorkflowActions, {
        available: Effect.succeed(publishing),
        execute: () => Effect.void,
        recover: () => Effect.succeed(true),
      }),
    );
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const runner = yield* createRunner.pipe(Effect.provideService(Scope.Scope, scope));
    const dependencies = {
      secrets: auth.secrets,
      environment: {
        getEnvironmentId: Effect.succeed(workflow.definition.environmentId),
        getDescriptor: Effect.die("unused"),
      },
      jobRunner: { run: () => Effect.die("personal dispatch forbidden") },
      snapshotQuery: auth.query,
      repositoryIdentity: auth.identities,
      workflowRunner: runner,
    };
    let count = 0;
    const invoke = (proof: string) =>
      cloudDispatchJobHandler(dependencies, { proof }, true).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://env.example/api/t3-connect/workflow-job", { method: "POST" }),
          ),
        ),
      );
    const send = (input: WorkflowRequest) =>
      Effect.gen(function* () {
        const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
        const requestId = `review-fix-${++count}`;
        const proof = yield* signRelayJwt({
          privateKey: relay.privateKey,
          typ: RELAY_DISPATCH_JOB_REQUEST_TYP,
          payload: {
            iss: issuer,
            aud: `t3-env:${workflow.definition.environmentId}`,
            sub:
              input.origin?.kind === "automation"
                ? `workflow:${input.jobId}`
                : (input.requestedBy ?? input.userId!),
            jti: requestId,
            iat: now,
            exp: now + 120,
            environmentId: workflow.definition.environmentId,
            jobId: input.jobId,
            repositoryCanonicalKey: input.repositoryCanonicalKey,
            baseBranch: "HEAD",
            instruction: input.instruction,
            workflowControl: input.control,
            ...(input.origin ? { workflowOrigin: input.origin } : {}),
            ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
          },
        });
        const response = yield* invoke(proof);
        const signed = yield* verifyRelayJwt({
          publicKey: environment.publicKey,
          token: response.proof,
          typ: RELAY_DISPATCH_JOB_RESPONSE_TYP,
          issuer: `t3-env:${workflow.definition.environmentId}`,
          audience: issuer,
          nowEpochSeconds: now,
        });
        assert.isNotNull(signed);
        assert.deepEqual(signed?.workflowResult, response.workflowResult);
        assert.equal(signed?.requestId, requestId);
        assert.equal(signed?.jobId, input.jobId);
        return { proof, response, signed };
      });
    return {
      h,
      auth,
      runner,
      send,
      invoke,
      restart: Effect.gen(function* () {
        yield* Scope.close(scope, Exit.void);
        dependencies.workflowRunner = yield* createRunner;
      }),
    };
  });
it.effect.each([false, true])(
  "real signed legacy responses decode on an older relay with publishing=%s",
  (publishing) =>
    test(
      Effect.gen(function* () {
        const f = yield* signedHarness(publishing);
        for (const input of [control("status"), request()]) {
          const { response, signed } = yield* f.send(input);
          assert.equal(decodeLegacyResponse(response).workflowResult?.protocol, publishing ? 7 : 6);
          assert.equal(decodeLegacyProof(signed).workflowResult?.protocol, publishing ? 7 : 6);
        }
        yield* f.h.complete;
        const review = yield* f.send({ ...control("status"), userId: "bob" });
        assert.equal(
          decodeLegacyProof(review.signed).workflowResult?.progress?.status,
          "awaiting_review",
        );
        const modern = yield* f.send({
          ...control("status"),
          origin: { kind: "manual", userId: "user-1" },
        });
        assert.equal(modern.response.workflowResult?.protocol, 8);
      }),
    ),
);
it.effect("real signed cancellation persists before acceptance with revoked policy", () =>
  test(
    Effect.gen(function* () {
      const f = yield* signedHarness();
      yield* f.auth.access.apply({ ...f.auth.policy, revision: 2, repositories: [] }, true);
      assert.isTrue(
        yield* f.auth.access
          .requireWorkflowProject({
            ...control("status").control,
            repositoryCanonicalKey: request().repositoryCanonicalKey,
          })
          .pipe(Effect.isFailure),
      );
      const missingHuman = yield* f.send(automated(control("cancel")));
      assert.equal(missingHuman.response.workflowResult?.outcome, "conflict");
      const cancel = yield* f.send({ ...automated(control("cancel")), requestedBy: "bob" });
      assert.equal(cancel.response.workflowResult?.outcome, "cancelled");
      assert.equal(cancel.response.workflowResult?.protocol, 8);
      assert.isTrue(yield* f.invoke(cancel.proof).pipe(Effect.isFailure));
      const restarted = yield* f.h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, f.auth.access),
      );
      assert.equal((yield* restarted.handle(automated(request()))).outcome, "cancelled");
      const saved = yield* (yield* WorkflowRunStore).getCancellation("job-1");
      assert.deepEqual(saved?.origin, origin);
      assert.lengthOf(yield* f.h.starts, 0);
    }),
  ),
);
it.effect("recovery observes completion while the real repository policy is unready", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const auth = yield* workflowAccess(h);
      const scope = yield* Scope.make();
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, auth.access),
        Effect.provideService(Scope.Scope, scope),
      );
      yield* runner.handle(automated(request()));
      yield* h.complete;
      yield* Scope.close(scope, Exit.void);
      const unready = yield* auth.construct;
      assert.isFalse((yield* unready.status).ready);
      const restarted = yield* h.newRunner.pipe(Effect.provideService(RepositoryAccess, unready));
      const result = yield* restarted.handle(automated(control("status")));
      assert.equal(result.progress?.status, "awaiting_review");
      assert.isFalse(yield* (yield* WorkflowRunStore).isExecuting());
    }),
  ),
);
it.effect("policy revocation wins the fence before a recovered preparation retry", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const auth = yield* workflowAccess(h);
      const scope = yield* Scope.make();
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, auth.access),
        Effect.provideService(Scope.Scope, scope),
      );
      yield* runner.handle(automated(request()));
      yield* h.failPreparation;
      const paused = (yield* runner.handle(automated(control("status")))).progress!;
      yield* Ref.set(h.retryMode, "before_retry");
      assert.isTrue(
        yield* runner
          .handle({ ...automated(retryRequest(paused.revision)), requestedBy: "bob" })
          .pipe(Effect.isFailure),
      );
      yield* Scope.close(scope, Exit.void);
      yield* Ref.set(h.retryMode, "normal");
      const closing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const attempted = yield* Deferred.make<void>();
      const unregister = yield* auth.access.registerConnection(
        Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const applying = yield* Effect.forkChild(
        auth.access.apply({ ...auth.policy, revision: 2, repositories: [] }, true),
      );
      yield* Deferred.await(closing);
      const access = {
        ...auth.access,
        withFence: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Deferred.succeed(attempted, undefined).pipe(
            Effect.andThen(auth.access.withFence(effect)),
          ),
      };
      const restarted = yield* h.newRunner.pipe(Effect.provideService(RepositoryAccess, access));
      const status = yield* Effect.forkChild(restarted.handle(automated(control("status"))));
      yield* Deferred.await(attempted);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(applying);
      unregister();
      yield* Fiber.join(status);
      const retries = () =>
        Ref.get(h.commands).pipe(
          Effect.map((commands) =>
            commands.filter((command) => command.type === "thread.preparation.retry"),
          ),
        );
      assert.lengthOf(yield* retries(), 0);
      yield* auth.access.apply({ ...auth.policy, revision: 3 }, true);
      yield* restarted.handle(automated(control("status")));
      yield* restarted.handle(automated(control("status")));
      assert.lengthOf(yield* retries(), 1);
    }),
  ),
);
it.effect.each(["cancel-first", "accept-first"] as const)(
  "automation acceptance/cancellation is atomic: %s",
  (order) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const auth = yield* workflowAccess(h);
        const runner = yield* h.newRunner.pipe(
          Effect.provideService(RepositoryAccess, auth.access),
        );
        yield* runner.handle(automated(request()));
        const store = yield* WorkflowRunStore;
        const seed = (yield* store.get("job-1"))!;
        const binding = {
          jobId: "raced",
          origin,
          organizationId: "org-1",
          repositoryId: "repo-1",
          projectId: workflow.definition.projectId,
          repositoryCanonicalKey: request().repositoryCanonicalKey,
          createdAt: seed.createdAt,
        };
        const accept = store.tryAccept({
          ...seed,
          jobId: "raced",
          executionReserved: false,
          progress: {
            ...seed.progress,
            threadId: (seed.progress.threadId + "-raced") as typeof seed.progress.threadId,
          },
        });
        const done = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          (order === "cancel-first"
            ? store.cancelBeforeAcceptance(binding).pipe(Effect.asVoid)
            : accept.pipe(Effect.asVoid)
          ).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
        );
        const second = yield* Effect.forkChild(
          Deferred.await(done).pipe(
            Effect.andThen(
              order === "cancel-first"
                ? accept.pipe(Effect.asVoid)
                : store.cancelBeforeAcceptance(binding).pipe(Effect.asVoid),
            ),
          ),
        );
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.equal((yield* store.get("raced")) !== null, order === "accept-first");
        assert.equal((yield* store.getCancellation("raced")) !== null, order === "cancel-first");
        assert.deepEqual(
          order === "cancel-first"
            ? (yield* store.getCancellation("raced"))?.origin
            : (yield* store.get("raced"))?.origin,
          origin,
        );
      }),
    ),
);

it.effect("revocation before native arm prevents automatic command delivery", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const auth = yield* workflowAccess(h);
      const publishing = yield* publishingHarness("none", {
        jobId: "job",
        base: "base",
        tree: "prepared",
        remoteName: "upstream",
        access: auth.access,
        onHead: () => Effect.void,
        beforeArm: auth.access
          .apply({ ...auth.policy, revision: 2, repositories: [] }, true)
          .pipe(Effect.asVoid),
      });
      yield* publishing.io.update((run) => ({
        ...run,
        origin: { ...origin, workflowId: run.workflow.workflowId },
        userId: null,
        workflow: {
          ...run.workflow,
          organizationId: "org-1",
          repositoryId: "repo-1",
          definition: { ...run.workflow.definition, projectId: workflow.definition.projectId },
        },
      }));
      assert.isTrue(
        yield* publishing.actions.execute(publishingId, publishing.io).pipe(Effect.isFailure),
      );
      assert.equal(publishing.commandDeliveries(), 0);
      assert.deepEqual(publishing.counts(), { commits: 0, pushes: 0 });
    }),
  ),
);

it.effect("a saved retry receipt reconciles after access removal without redelivery", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const auth = yield* workflowAccess(h);
      const scope = yield* Scope.make();
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, auth.access),
        Effect.provideService(Scope.Scope, scope),
      );
      yield* runner.handle(automated(request()));
      yield* h.failPreparation;
      const paused = (yield* runner.handle(automated(control("status")))).progress!;
      yield* Ref.set(h.retryMode, "after_retry");
      assert.isTrue(
        yield* runner
          .handle({ ...automated(retryRequest(paused.revision)), requestedBy: "bob" })
          .pipe(Effect.isFailure),
      );
      yield* Scope.close(scope, Exit.void);
      yield* h.complete;
      yield* auth.access.apply({ ...auth.policy, revision: 2, repositories: [] }, true);
      const restarted = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, auth.access),
      );
      const result = yield* restarted.handle(automated(control("status")));
      const store = yield* WorkflowRunStore;
      assert.equal(result.progress?.status, "awaiting_review");
      assert.isFalse(yield* store.isExecuting());
      assert.isNull((yield* store.get("job-1"))?.pendingPreparationRetry);
      yield* auth.access.apply({ ...auth.policy, revision: 3 }, true);
      yield* restarted.handle(automated(control("status")));
      assert.lengthOf(
        (yield* Ref.get(h.commands)).filter(
          (command) => command.type === "thread.preparation.retry",
        ),
        1,
      );
    }),
  ),
);
it.effect("new publishing stays unreserved while repository access is missing", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const auth = yield* workflowAccess(h);
      let executions = 0;
      const began = yield* Deferred.make<void>();
      const runner = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, auth.access),
        Effect.provideService(WorkflowActions, {
          available: Effect.succeed(true),
          recover: () => Effect.succeed(true),
          execute: () =>
            Effect.gen(function* () {
              executions++;
              yield* Deferred.succeed(began, undefined);
              return yield* Effect.never;
            }),
        }),
      );
      const original = automated(request());
      yield* runner.handle({
        ...original,
        control: {
          ...original.control,
          operation: "start",
          workflow: {
            ...workflow,
            definition: {
              ...workflow.definition,
              steps: [
                workflow.definition.steps[0]!,
                { id: "push", kind: "action", title: "Push", action: "push" },
              ],
            },
          },
        },
      });
      yield* auth.access.apply({ ...auth.policy, revision: 2, repositories: [] }, true);
      yield* h.complete;
      yield* runner.handle(automated(control("status")));
      yield* runner.handle(automated(control("status")));
      const store = yield* WorkflowRunStore;
      assert.equal((yield* store.get("job-1"))?.progress.status, "waiting_capacity");
      assert.isFalse(yield* store.isExecuting());
      assert.equal(executions, 0);
      yield* auth.access.apply({ ...auth.policy, revision: 3 }, true);
      yield* runner.handle(automated(control("status")));
      yield* Deferred.await(began);
      assert.equal(executions, 1);
    }),
  ),
);
it.effect.each(["legacy-manual", "altered-automation"] as const)(
  "cancellation validates a run accepted after lookup: %s",
  (mode) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const auth = yield* workflowAccess(h);
        const original = yield* h.newRunner.pipe(
          Effect.provideService(RepositoryAccess, auth.access),
        );
        yield* original.handle(mode === "legacy-manual" ? request() : automated(request()));
        const store = yield* WorkflowRunStore;
        let hide = false;
        const racing = {
          ...store,
          get: (id: string) =>
            Effect.suspend(() => {
              if (hide && id === "job-1") {
                hide = false;
                return Effect.succeed(null);
              }
              return store.get(id);
            }),
        };
        const runner = yield* makeRunner.pipe(
          Effect.provide(Layer.merge(h.mocks, Layer.succeed(WorkflowRunStore, racing))),
          Effect.provideService(RepositoryAccess, auth.access),
        );
        yield* runner.handle(control("status", "probe"));
        hide = true;
        const response = yield* runner.handle(
          mode === "legacy-manual"
            ? { ...control("cancel"), userId: "bob" }
            : {
                ...automated(control("cancel")),
                origin: { ...origin, occurrenceId: "other" },
                requestedBy: "bob",
              },
        );
        if (mode === "legacy-manual") {
          assert.notEqual(response.outcome, "conflict");
          assert.equal(response.progress?.status, "cancelling");
          assert.deepEqual((yield* store.get("job-1"))?.origin, {
            kind: "manual",
            userId: "user-1",
          });
        } else {
          assert.equal(response.outcome, "conflict");
          assert.isNull(response.progress);
          assert.notEqual((yield* store.get("job-1"))?.progress.status, "cancelling");
        }
      }),
    ),
);

it.effect.each(["initial", "successor", "unavailable-provider"] as const)(
  "policy revocation before Agent enqueue leaves capacity free: %s",
  (step) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const auth = yield* workflowAccess(h);
        const store = yield* WorkflowRunStore;
        const preflight = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let gate = true;
        const query = {
          ...auth.query,
          getProjectShellById: (id: typeof workflow.definition.projectId) =>
            Effect.gen(function* () {
              const run = yield* store.get("job-1");
              if (
                gate &&
                run?.sequence?.cursor === (step === "successor" ? 1 : 0) &&
                !run.promptDispatched
              ) {
                gate = false;
                yield* Deferred.succeed(preflight, undefined);
                yield* Deferred.await(release);
              }
              return yield* auth.query.getProjectShellById(id);
            }),
        };
        const runner = yield* makeRunner.pipe(
          Effect.provide(Layer.merge(h.mocks, Layer.succeed(ProjectionSnapshotQuery, query))),
          Effect.provideService(RepositoryAccess, auth.access),
        );
        const start = automated(request());
        const starting = runner.handle({
          ...start,
          control: {
            ...start.control,
            operation: "start",
            workflow: {
              ...workflow,
              definition: {
                ...workflow.definition,
                steps: [
                  workflow.definition.steps[0]!,
                  { ...workflow.definition.steps[0]!, id: "next-agent" },
                  workflow.definition.steps[1]!,
                ],
              },
            },
          },
        });
        if (step === "successor") {
          yield* starting;
          yield* h.complete;
        }
        const pending = yield* Effect.forkChild(
          step === "successor" ? runner.handle(automated(control("status"))) : starting,
        );
        yield* Deferred.await(preflight);
        yield* auth.access.apply({ ...auth.policy, revision: 2, repositories: [] }, true);
        const providers = yield* Ref.get(h.providers);
        if (step === "unavailable-provider")
          yield* Ref.set(
            h.providers,
            providers.map((provider) => ({ ...provider, enabled: false })),
          );
        yield* Deferred.succeed(release, undefined);
        const denied = yield* Fiber.join(pending);
        assert.equal(denied.progress?.status, "waiting_capacity");
        assert.include(denied.progress?.detail, "Repository access is unavailable.");
        assert.isFalse((yield* store.get("job-1"))!.executionReserved);
        assert.lengthOf(yield* h.starts, step === "successor" ? 1 : 0);
        const stable = yield* runner.handle(automated(control("status")));
        assert.equal(stable.progress?.revision, denied.progress?.revision);
        const saved = (yield* store.get("job-1"))!;
        yield* Ref.set(h.providers, providers);
        assert.equal((yield* runner.handle(request("other-job"))).outcome, "accepted");
        yield* auth.access.apply({ ...auth.policy, revision: 3 }, true);
        yield* runner.handle(automated(control("status")));
        assert.isFalse((yield* store.get("job-1"))!.executionReserved);
        yield* Ref.set(h.branch, "t3-job/other-job");
        yield* h.completeCurrent;
        yield* runner.handle(control("status", "other-job"));
        yield* Ref.set(h.branch, "t3-job/job-1");
        yield* runner.handle(automated(control("status")));
        yield* runner.handle(automated(control("status")));
        const resumed = (yield* store.get("job-1"))!;
        assert.isTrue(resumed.executionReserved);
        assert.deepEqual(resumed.origin, saved.origin);
        assert.equal(resumed.progress.threadId, saved.progress.threadId);
        assert.equal(resumed.sequence?.cursor, saved.sequence?.cursor);
        assert.equal(resumed.sequence?.generation, saved.sequence?.generation);
        const prompts = (yield* h.starts).filter(
          (command) => command.threadId === saved.progress.threadId,
        );
        assert.lengthOf(prompts, step === "successor" ? 2 : 1);
        assert.equal(new Set(prompts.map((command) => command.commandId)).size, prompts.length);
      }),
    ),
);

it.effect("accepted enqueue bookkeeping precedes a concurrent policy acknowledgement", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const auth = yield* workflowAccess(h);
      const store = yield* WorkflowRunStore;
      const enqueue = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const requested = yield* Deferred.make<void>();
      const engine = yield* OrchestrationEngineService.pipe(Effect.provide(h.mocks));
      const gated = {
        ...engine,
        dispatch: (command: Parameters<typeof engine.dispatch>[0]) =>
          Effect.gen(function* () {
            if (command.type === "thread.prompt.enqueue") {
              assert.isTrue((yield* store.get("job-1"))!.executionReserved);
              yield* Deferred.succeed(enqueue, undefined);
              yield* Deferred.await(release);
            }
            return yield* engine.dispatch(command);
          }),
      };
      const runner = yield* makeRunner.pipe(
        Effect.provide(Layer.merge(h.mocks, Layer.succeed(OrchestrationEngineService, gated))),
        Effect.provideService(RepositoryAccess, auth.access),
      );
      const starting = yield* Effect.forkChild(runner.handle(automated(request())));
      yield* Deferred.await(enqueue);
      const applying = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.succeed(requested, undefined);
          yield* auth.access.apply({ ...auth.policy, revision: 2, repositories: [] }, true);
          assert.isTrue((yield* store.get("job-1"))!.promptDispatched);
        }),
      );
      yield* Deferred.await(requested);
      assert.equal((yield* auth.access.status).revision, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(starting);
      yield* Fiber.join(applying);
      assert.lengthOf(yield* h.starts, 1);
      yield* h.complete;
      const finished = yield* runner.handle(automated(control("status")));
      assert.equal(finished.progress?.status, "awaiting_review");
      assert.isFalse((yield* store.get("job-1"))!.executionReserved);
    }),
  ),
);

it.effect.each([false, true])(
  "legacy reviewer reconciles a modern manual cancellation after restart: publishing=%s",
  (publishing) =>
    test(
      Effect.gen(function* () {
        const f = yield* signedHarness(publishing);
        const store = yield* WorkflowRunStore;
        const cancelled = yield* f.send({
          ...control("cancel"),
          userId: "bob",
          requestedBy: "bob",
          origin: { kind: "manual", userId: "user-1" },
        });
        assert.equal(cancelled.response.workflowResult?.outcome, "cancelled");
        const saved = yield* store.getCancellation("job-1");
        assert.deepEqual(saved?.origin, { kind: "manual", userId: "user-1" });
        // The relay may lose this acknowledgement and retry with an older proof shape.
        yield* f.restart;
        for (const operation of ["cancel", "status"] as const) {
          const result = yield* f.send({ ...control(operation), userId: "bob" });
          assert.equal(result.response.workflowResult?.outcome, "cancelled");
          assert.equal(
            decodeLegacyResponse(result.response).workflowResult?.protocol,
            publishing ? 7 : 6,
          );
          assert.equal(
            decodeLegacyProof(result.signed).workflowResult?.protocol,
            publishing ? 7 : 6,
          );
          assert.isTrue(yield* f.invoke(result.proof).pipe(Effect.isFailure));
        }
        const wrongOrigin = yield* f.send({
          ...control("cancel"),
          userId: "bob",
          origin: { kind: "manual", userId: "bob" },
        });
        assert.equal(wrongOrigin.response.workflowResult?.outcome, "conflict");
        const wrongTarget = control("cancel");
        assert.equal(
          (yield* f.runner.handle({
            ...wrongTarget,
            userId: "bob",
            control: { ...wrongTarget.control, repositoryId: "other" },
          })).outcome,
          "conflict",
        );
        assert.deepEqual(yield* store.getCancellation("job-1"), saved);
        assert.lengthOf(yield* f.h.starts, 0);
      }),
    ),
);

it.effect("legacy cancellation recovers manual origin from the fresh transaction result", () =>
  test(
    Effect.gen(function* () {
      const h = yield* harness;
      const auth = yield* workflowAccess(h);
      const original = yield* h.newRunner.pipe(
        Effect.provideService(RepositoryAccess, auth.access),
      );
      yield* original.handle({
        ...control("cancel"),
        userId: "bob",
        requestedBy: "bob",
        origin: { kind: "manual", userId: "user-1" },
      });
      const store = yield* WorkflowRunStore;
      const saved = yield* store.getCancellation("job-1");
      let hide = false;
      const racing = {
        ...store,
        getCancellation: (id: string) =>
          Effect.suspend(() => {
            if (hide && id === "job-1") {
              hide = false;
              return Effect.succeed(null);
            }
            return store.getCancellation(id);
          }),
      };
      const runner = yield* makeRunner.pipe(
        Effect.provide(Layer.merge(h.mocks, Layer.succeed(WorkflowRunStore, racing))),
        Effect.provideService(RepositoryAccess, auth.access),
      );
      yield* runner.handle(control("status", "probe"));
      hide = true;
      assert.equal(
        (yield* runner.handle({ ...control("cancel"), userId: "bob" })).outcome,
        "cancelled",
      );
      assert.deepEqual(yield* store.getCancellation("job-1"), saved);
      assert.lengthOf(yield* h.starts, 0);
    }),
  ),
);

it.effect.each(["before", "after"] as const)(
  "access loss preserves an uncertain Agent reservation after enqueue failure: %s",
  (outage) =>
    test(
      Effect.gen(function* () {
        const h = yield* harness;
        const auth = yield* workflowAccess(h);
        const store = yield* WorkflowRunStore;
        const runner = yield* h.newRunner.pipe(
          Effect.provideService(RepositoryAccess, auth.access),
        );
        yield* Ref.set(h.promptOutage, outage);
        assert.isTrue(yield* runner.handle(automated(request())).pipe(Effect.isFailure));
        const saved = (yield* store.get("job-1"))!;
        assert.isTrue(saved.executionReserved);
        assert.isFalse(saved.promptDispatched);
        yield* auth.access.apply({ ...auth.policy, revision: 2, repositories: [] }, true);
        const blocked = yield* runner.handle(automated(control("status")));
        assert.equal(blocked.progress?.status, "preparing");
        assert.isTrue((yield* store.get("job-1"))!.executionReserved);
        assert.equal((yield* runner.handle(request("other-job"))).outcome, "busy");
        assert.lengthOf(yield* h.starts, outage === "before" ? 0 : 1);
        yield* auth.access.apply({ ...auth.policy, revision: 3 }, true);
        yield* runner.handle(automated(control("status")));
        yield* runner.handle(automated(control("status")));
        const starts = yield* h.starts;
        assert.lengthOf(starts, 1);
        assert.equal(starts[0]!.commandId, "workflow:job-1:start");
        assert.equal(starts[0]!.threadId, saved.progress.threadId);
        assert.isTrue((yield* store.get("job-1"))!.promptDispatched);
      }),
    ),
);
