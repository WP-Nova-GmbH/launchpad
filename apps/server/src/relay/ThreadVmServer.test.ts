import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { threadVmMoveServerDigest } from "@t3tools/shared/threadVmServerStart";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProcessRunner from "../processRunner.ts";
import { THREAD_VM_IDENTITY_SECRET, type InstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { requireThreadVmMoveServerStart } from "./ThreadVmServer.ts";
import { prepareThreadVmMoveWorkspace } from "./ThreadVmMoveWorkspace.ts";

const vm: InstalledThreadVm = {
  operationId: "move",
  scope: {
    allocationId: "allocation",
    threadId: ThreadId.make("thread"),
    repositoryId: "repo",
    generation: 2,
  },
  relayUrl: "https://relay.test",
  relayIssuer: "https://relay.test",
  environmentId: EnvironmentId.make("vm"),
  environmentCredential: "test",
  cloudMintPublicKey: "test",
};
const receipt = {
  enrolled: true as const,
  operationId: vm.operationId,
  allocationId: vm.scope.allocationId,
  threadId: vm.scope.threadId,
  generation: vm.scope.generation,
  environmentId: vm.environmentId,
};
const owner = {
  threadId: vm.scope.threadId,
  generation: 2,
  operationId: vm.operationId,
  environmentId: vm.environmentId,
  relayUrl: vm.relayUrl,
};
const projectId = ProjectId.make("vm:thread");
const environment = (root: string) =>
  OrchestrationLayerLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), root)),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.mock(ServerSecretStore)({
        get: (name) =>
          Effect.succeed(
            name === THREAD_VM_IDENTITY_SECRET
              ? Option.some(new TextEncoder().encode(JSON.stringify(vm)))
              : Option.none(),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(vm.environmentId),
      }),
    ),
    Layer.fresh,
  );

it.layer(NodeServices.layer)("VM move import server", (it) => {
  it.effect("prepares only its assigned empty project and leaves execution frozen", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "vm-move-start-" }),
          ),
          checkout = path.join(root, "project");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient,
            digest = yield* threadVmMoveServerDigest(receipt),
            fence = makeThreadExecutionFence(sql);
          yield* requireThreadVmMoveServerStart(digest, checkout);
          expect(yield* fs.readDirectory(checkout)).toEqual([]);
          expect(yield* prepareThreadVmMoveWorkspace(owner, projectId, checkout)).toBe(checkout);
          yield* fence.prepare({ ...owner, projectId });
          expect(yield* prepareThreadVmMoveWorkspace(owner, projectId, checkout)).toBe(checkout);
          expect((yield* fence.get(owner.threadId))?.phase).toBe("frozen");
          expect(yield* sql`SELECT project_id FROM projection_projects`).toEqual([
            { project_id: projectId },
          ]);
          expect(yield* sql`SELECT thread_id FROM projection_threads`).toEqual([]);
          yield* Effect.flip(fence.beginWork({ ...owner, workId: "too-early", kind: "provider" }));
          yield* requireThreadVmMoveServerStart(digest, checkout);
          yield* fence.retire(owner);
          expect((yield* Effect.flip(requireThreadVmMoveServerStart(digest, checkout)))._tag).toBe(
            "ThreadVmServerStartError",
          );
        }).pipe(Effect.provide(environment(path.join(root, "state"))));
      }),
    ),
  );
  it.effect("restarts the coordinator through a lifecycle drain without starting work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "vm-held-restart-" }),
        );
        const checkout = path.join(root, "project");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient,
            digest = yield* threadVmMoveServerDigest(receipt),
            fence = makeThreadExecutionFence(sql);
          yield* requireThreadVmMoveServerStart(digest, checkout);
          yield* fence.prepare({ ...owner, projectId });
          yield* fence.activate(owner);
          const pauseOwner = { ...owner, operationId: "pause-operation" };
          yield* fence.beginDrain({ ...pauseOwner, previousOperationId: owner.operationId });
          yield* requireThreadVmMoveServerStart(digest, checkout);
          expect((yield* fence.get(owner.threadId))?.phase).toBe("draining");
          expect(
            (yield* Effect.result(
              fence.beginWork({ ...owner, workId: "restart-too-early", kind: "provider" }),
            ))._tag,
          ).toBe("Failure");
          yield* fence.freeze(pauseOwner);
          yield* requireThreadVmMoveServerStart(digest, checkout);
          expect((yield* fence.get(owner.threadId))?.operationId).toBe(pauseOwner.operationId);
          expect((yield* fence.get(owner.threadId))?.phase).toBe("frozen");
          yield* fence.retire(pauseOwner);
          expect(
            (yield* Effect.result(requireThreadVmMoveServerStart(digest, checkout)))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(environment(path.join(root, "state"))));
      }),
    ),
  );
  it.effect("rejects changed enrollment or project scope without overwriting checkout data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "vm-move-refuse-" }),
          ),
          checkout = path.join(root, "project");
        yield* fs.makeDirectory(checkout);
        yield* fs.writeFileString(path.join(checkout, "keep"), "existing data");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient,
            digest = yield* threadVmMoveServerDigest(receipt);
          yield* Effect.flip(requireThreadVmMoveServerStart("0".repeat(64), checkout));
          yield* Effect.flip(requireThreadVmMoveServerStart(digest, checkout));
          yield* makeThreadExecutionFence(sql).prepare({ ...owner, projectId });
          yield* Effect.flip(
            prepareThreadVmMoveWorkspace({ ...owner, generation: 3 }, projectId, checkout),
          );
          yield* Effect.flip(
            prepareThreadVmMoveWorkspace(owner, ProjectId.make("other"), checkout),
          );
          yield* Effect.flip(prepareThreadVmMoveWorkspace(owner, projectId, checkout));
          expect(yield* sql`SELECT project_id FROM projection_projects`).toEqual([]);
          expect(yield* fs.readFileString(path.join(checkout, "keep"))).toBe("existing data");
        }).pipe(Effect.provide(environment(path.join(root, "state"))));
      }),
    ),
  );
});
