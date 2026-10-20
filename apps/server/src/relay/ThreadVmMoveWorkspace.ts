import { CommandId, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import type { ThreadMoveOwner } from "./ThreadMoveTransport.ts";
import { workspaceFailure } from "./ThreadWorkspaceFiles.ts";

/** Only the assigned move worker may create the one project in a fresh guest. */
export const prepareThreadVmMoveWorkspace = Effect.fn("ThreadVmMoveWorkspace.prepare")(
  function* (
    owner: ThreadMoveOwner,
    projectId: ProjectId,
    root = "/workspace/project",
  ): Effect.fn.Return<
    string,
    | import("./ThreadVmEnrollment.ts").ThreadVmEnrollmentError
    | import("./ThreadWorkspaceFiles.ts").ThreadWorkspaceTransferError
    | import("effect/PlatformError").PlatformError
    | import("effect/unstable/sql/SqlError").SqlError,
    | ServerSecretStore
    | ServerEnvironmentIdentity
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | Path.Path
    | OrchestrationEngineService
  > {
    const vm = yield* readInstalledThreadVm();
    if (
      !vm ||
      vm.scope.generation <= 1 ||
      vm.scope.threadId !== owner.threadId ||
      vm.scope.generation !== owner.generation ||
      vm.operationId !== owner.operationId ||
      vm.environmentId !== owner.environmentId ||
      vm.relayUrl !== owner.relayUrl ||
      projectId !== `vm:${owner.threadId}` ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId)
    )
      return yield* workspaceFailure("The VM move does not match its installed enrollment.");
    const sql = yield* SqlClient.SqlClient,
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const unrelated = yield* sql`SELECT 1 FROM projection_projects WHERE project_id!=${projectId}
    UNION ALL SELECT 1 FROM projection_threads WHERE thread_id!=${owner.threadId} LIMIT 1`;
    if (
      unrelated.length ||
      (yield* fs.realPath(root)) !== root ||
      (yield* fs.realPath(path.dirname(root))) !== path.dirname(root)
    )
      return yield* workspaceFailure("The VM project is occupied or its path changed.");
    const [project] = yield* sql<{
      root: string;
    }>`SELECT workspace_root AS root FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
    if (project) {
      if (project.root !== root) return yield* workspaceFailure("The VM project binding changed.");
      return root;
    }
    if ((yield* fs.readDirectory(root)).length)
      return yield* workspaceFailure("The fresh VM checkout is not empty.");
    yield* (yield* OrchestrationEngineService)
      .dispatch({
        type: "project.create",
        commandId: CommandId.make(`${owner.operationId}:vm-project`),
        projectId,
        title: "VM workspace",
        workspaceRoot: root,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        Effect.mapError(() => workspaceFailure("The VM project registration was not confirmed.")),
      );
    return root;
  },
  Effect.mapError(() => workspaceFailure("The assigned VM workspace could not be prepared.")),
);
