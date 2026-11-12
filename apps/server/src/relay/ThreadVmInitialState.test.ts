import * as Crypto from "effect/Crypto";
import { RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import { requireThreadVmServerStart } from "./ThreadVmServer.ts";
import { activateInitialThreadVm } from "./ThreadVmActivation.ts";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { SecretStorePersistError, ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeThreadExecutionRelay } from "./ThreadExecutionRelay.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import {
  prepareThreadVmInitialState,
  THREAD_VM_INITIAL_STATE_SECRET,
  type ThreadVmInitialStateInput,
} from "./ThreadVmInitialState.ts";
import { THREAD_VM_WORKSPACE_SECRET } from "./ThreadVmWorkspace.ts";

const encodeSetupReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReceipt));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const bytes = (value: unknown) => new TextEncoder().encode(encode(value));
const input: ThreadVmInitialStateInput = {
  workspace: {
    operationId: "initial",
    scope: {
      allocationId: "allocation",
      threadId: ThreadId.make("thread"),
      repositoryId: "repository",
      generation: 1,
    },
    canonicalKey: "github.com/acme/project",
    branch: "main",
    revision: "a".repeat(40),
  },
  title: "New VM task",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "selected-model" },
  createdAt: "2026-10-05T10:00:00.000Z",
};
const workspaceRoot = "/tmp/launchpad-vm-initial-test";
const vm = {
  operationId: "initial",
  scope: input.workspace.scope,
  environmentId: "vm",
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  environmentCredential: "credential",
  cloudMintPublicKey: "key",
};
const testLayer = OrchestrationLayerLive.pipe(
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-vm-initial-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const fence = makeThreadExecutionFence(sql);
  const values = new Map<string, Uint8Array>([
    [THREAD_VM_IDENTITY_SECRET, bytes(vm)],
    [
      THREAD_VM_WORKSPACE_SECRET,
      bytes({
        input: input.workspace,
        workspaceRoot,
        createdAt: input.createdAt,
        state: "ready",
        errorCode: null,
      }),
    ],
  ]);
  let failReceipt = false;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore, {
        get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
        create: (name, value) =>
          Effect.suspend(() => {
            if (values.has(name))
              return Effect.fail(new SecretStorePersistError({ resource: name, cause: "exists" }));
            values.set(name, value);
            return Effect.void;
          }),
        set: (name, value) =>
          Effect.suspend(() => {
            if (failReceipt)
              return Effect.fail(
                new SecretStorePersistError({ resource: name, cause: "injected write failure" }),
              );
            values.set(name, value);
            return Effect.void;
          }),
        remove: () => Effect.die("never erase identity"),
        getOrCreateRandom: () => Effect.die("no new identity"),
      }),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("vm")),
      }),
      Effect.provideService(ProcessRunner, {
        run: () => Effect.die("the persisted successful workspace setup must not run again"),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("offline initialization must not call the relay")),
      ),
    );
  const execution = makeThreadExecutionRelay(
    sql,
    {
      admit: () => Effect.die("frozen work must not contact the relay"),
      complete: () => Effect.die("no work started"),
    },
    {
      threadId: input.workspace.scope.threadId,
      generation: 1,
      environmentId: "vm",
      relayUrl: "https://relay.test",
    },
  );
  return {
    values,
    engine,
    query,
    fence,
    execution,
    provide,
    failReceipt: () => {
      failReceipt = true;
    },
  };
});

describe("initial VM thread state", () => {
  it.effect(
    "starts only the matching prepared VM without activating it, and refuses an old owner",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.equal(
          (yield* requireThreadVmServerStart("a".repeat(64), workspaceRoot).pipe(
            f.provide,
            Effect.flip,
          ))._tag,
          "ThreadVmServerStartError",
        );
        const receipt = yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide);
        const encoded = yield* encodeSetupReceipt(receipt);
        const digest = yield* (yield* Crypto.Crypto).digest(
          "SHA-256",
          new TextEncoder().encode(encoded),
        );
        const sha = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const start = requireThreadVmServerStart(sha, workspaceRoot).pipe(f.provide);
        assert.deepEqual(yield* start, receipt);
        assert.equal((yield* f.fence.get(receipt.scope.threadId))?.phase, "frozen");
        yield* requireThreadVmServerStart("b".repeat(64), workspaceRoot).pipe(
          f.provide,
          Effect.flip,
        );
        yield* requireThreadVmServerStart(sha, "/wrong-checkout").pipe(f.provide, Effect.flip);
        f.values.set(
          THREAD_VM_IDENTITY_SECRET,
          bytes({ ...vm, scope: { ...vm.scope, repositoryId: "other" } }),
        );
        yield* start.pipe(Effect.flip);
        f.values.set(THREAD_VM_IDENTITY_SECRET, bytes(vm));
        yield* f.fence.activate({
          threadId: receipt.scope.threadId,
          generation: 1,
          operationId: receipt.operationId,
        });
        assert.deepEqual(yield* start, receipt);
        yield* f.fence.beginDrain({
          threadId: receipt.scope.threadId,
          generation: 1,
          previousOperationId: receipt.operationId,
          operationId: "move",
        });
        assert.deepEqual(yield* start, receipt);
        assert.equal((yield* f.fence.get(receipt.scope.threadId))?.phase, "draining");
        yield* f.fence
          .beginWork({
            threadId: receipt.scope.threadId,
            generation: 1,
            workId: "held-restart",
            kind: "provider",
          })
          .pipe(Effect.flip);
        yield* f.fence.freeze({
          threadId: receipt.scope.threadId,
          generation: 1,
          operationId: "move",
        });
        assert.deepEqual(yield* start, receipt);
        assert.equal((yield* f.fence.get(receipt.scope.threadId))?.phase, "frozen");
        yield* f.fence.retire({
          threadId: receipt.scope.threadId,
          generation: 1,
          operationId: "move",
        });
        yield* start.pipe(Effect.flip);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "opens the fence only after relay confirmation and leaves it frozen on failure or pending history",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let calls = 0;
        let ready = false;
        let status = 200;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++;
            assert.equal(
              request.url,
              "https://relay.test/v1/environments/vm/threads/thread/setup/activate",
            );
            assert.equal(request.headers.authorization, "Bearer credential");
            return HttpClientResponse.fromWeb(request, Response.json({ ready }, { status }));
          }),
        );
        const activate = activateInitialThreadVm(input.workspace.scope.threadId).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          f.provide,
        );
        assert.isFalse(yield* activate);
        assert.equal(calls, 0);
        yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide);
        assert.isFalse(yield* activate);
        assert.equal((yield* f.fence.get(input.workspace.scope.threadId))?.phase, "frozen");
        status = 503;
        assert.equal((yield* Effect.flip(activate))._tag, "ThreadVmActivationError");
        assert.equal((yield* f.fence.get(input.workspace.scope.threadId))?.phase, "frozen");
        status = 200;
        ready = true;
        assert.isTrue(yield* activate);
        assert.equal((yield* f.fence.get(input.workspace.scope.threadId))?.phase, "active");
        const count = calls;
        assert.isFalse(yield* activate);
        assert.equal(calls, count);
        yield* f.fence.beginDrain({
          threadId: input.workspace.scope.threadId,
          generation: 1,
          operationId: "move-later",
          previousOperationId: "initial",
        });
        yield* f.fence.freeze({
          threadId: input.workspace.scope.threadId,
          generation: 1,
          operationId: "move-later",
        });
        assert.isFalse(yield* activate);
        assert.equal((yield* f.fence.get(input.workspace.scope.threadId))?.phase, "frozen");
        assert.equal(calls, count);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "persists the requested model and conversation with a frozen fence, and deduplicates retries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const receipt = yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide);
        assert.equal(receipt.execution, "frozen");
        const snapshot = yield* f.query.getSnapshot();
        assert.lengthOf(snapshot.projects, 1);
        assert.lengthOf(snapshot.threads, 1);
        assert.equal(snapshot.threads[0]?.title, input.title);
        assert.deepEqual(snapshot.threads[0]?.modelSelection, input.modelSelection);
        assert.equal(snapshot.threads[0]?.branch, "main");
        assert.equal((yield* f.fence.get(input.workspace.scope.threadId))?.phase, "frozen");
        for (const kind of ["provider", "terminal", "setup", "workspace"] as const) {
          assert.equal(
            (yield* f.execution
              .begin({ threadId: input.workspace.scope.threadId, workId: kind, kind })
              .pipe(Effect.flip))._tag,
            "ThreadExecutionFenceError",
          );
        }
        assert.equal(
          (yield* f.engine
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make("early-write"),
              threadId: input.workspace.scope.threadId,
              title: "Too early",
            })
            .pipe(Effect.flip))._tag,
          "ThreadExecutionFenceError",
        );
        assert.deepEqual(
          yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide),
          receipt,
        );
        assert.equal(yield* f.engine.latestSequence, receipt.sequence);
        assert.equal(
          (yield* prepareThreadVmInitialState(
            { ...input, title: "Different intent" },
            workspaceRoot,
          ).pipe(f.provide, Effect.flip)).code,
          "identity_changed",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps the fence closed when saving the completion receipt fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.failReceipt();
      assert.equal(
        (yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide, Effect.flip))
          .code,
        "baseline_import_failed",
      );
      assert.equal((yield* f.fence.get(input.workspace.scope.threadId))?.phase, "frozen");
      assert.equal(
        (yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide, Effect.flip))
          .code,
        "baseline_unconfirmed",
      );
      assert.lengthOf((yield* f.query.getSnapshot()).threads, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects unknown provider instances and mismatched enrollment without creating thread state",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.equal(
          (yield* prepareThreadVmInitialState(
            {
              ...input,
              modelSelection: {
                ...input.modelSelection,
                instanceId: ProviderInstanceId.make("claude"),
              },
            },
            workspaceRoot,
          ).pipe(f.provide, Effect.flip)).code,
          "unsupported_provider",
        );
        f.values.set(
          THREAD_VM_IDENTITY_SECRET,
          bytes({ ...vm, scope: { ...vm.scope, repositoryId: "other" } }),
        );
        assert.equal(
          (yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide, Effect.flip))
            .code,
          "identity_changed",
        );
        assert.lengthOf((yield* f.query.getSnapshot()).threads, 0);
        assert.isFalse(f.values.has(THREAD_VM_INITIAL_STATE_SECRET));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not replace existing state or reopen ownership that has advanced", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const receipt = yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide);
      yield* f.fence.activate({
        threadId: receipt.scope.threadId,
        generation: 1,
        operationId: receipt.operationId,
      });
      assert.equal(
        (yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide, Effect.flip))
          .code,
        "identity_changed",
      );
      f.values.delete(THREAD_VM_INITIAL_STATE_SECRET);
      assert.equal(
        (yield* prepareThreadVmInitialState(input, workspaceRoot).pipe(f.provide, Effect.flip))
          .code,
        "identity_changed",
      );
      assert.lengthOf((yield* f.query.getSnapshot()).threads, 1);
      assert.equal((yield* f.fence.get(receipt.scope.threadId))?.phase, "active");
    }).pipe(Effect.provide(testLayer)),
  );
});
