import {
  THREAD_VM_INITIAL_STATE_SECRET,
  encodeThreadVmInitialState as encodeState,
  decodeThreadVmInitialState as decodeState,
} from "./ThreadVmInitialStateRecord.ts";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { RelayThreadVmSetupInput, RelayThreadVmSetupReceipt } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { prepareThreadVmWorkspace, ThreadVmWorkspaceError } from "./ThreadVmWorkspace.ts";

export const ThreadVmInitialStateInput = RelayThreadVmSetupInput;
export type ThreadVmInitialStateInput = RelayThreadVmSetupInput;
export const ThreadVmInitialStateReceipt = RelayThreadVmSetupReceipt;
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(ThreadVmInitialStateInput));
export {
  THREAD_VM_INITIAL_STATE_SECRET,
  readThreadVmInitialState,
} from "./ThreadVmInitialStateRecord.ts";
export class ThreadVmInitialStateError extends Schema.TaggedError<ThreadVmInitialStateError>()(
  "ThreadVmInitialStateError",
  {
    code: Schema.Literals([
      "identity_changed",
      "baseline_import_failed",
      "baseline_unconfirmed",
      "unsupported_provider",
    ]),
  },
) {
  override get message() {
    return `VM thread initialization is blocked (${this.code}).`;
  }
}
const isInitialStateError = Schema.is(ThreadVmInitialStateError);
const isWorkspaceError = Schema.is(ThreadVmWorkspaceError);
const fail = (code: ThreadVmInitialStateError["code"]) => new ThreadVmInitialStateError({ code });

/** Offline guest bootstrap only: no provider/terminal reactors may be running in this process. */
export const prepareThreadVmInitialState = Effect.fn("ThreadVmInitialState.prepare")(
  function* (input: ThreadVmInitialStateInput, workspaceRoot = "/workspace/project") {
    // The first template has one known Codex instance. Other providers need their own portability proof.
    if (input.modelSelection.instanceId !== "codex") return yield* fail("unsupported_provider");
    const vm = yield* readInstalledThreadVm();
    if (
      !vm ||
      vm.operationId !== input.workspace.operationId ||
      vm.scope.generation !== 1 ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId) ||
      vm.scope.allocationId !== input.workspace.scope.allocationId ||
      vm.scope.threadId !== input.workspace.scope.threadId ||
      vm.scope.repositoryId !== input.workspace.scope.repositoryId ||
      input.workspace.scope.generation !== 1
    )
      return yield* fail("identity_changed");
    const secrets = yield* ServerSecretStore;
    const sql = yield* SqlClient.SqlClient;
    const fence = makeThreadExecutionFence(sql);
    const projectId = ProjectId.make(`vm:${input.workspace.scope.threadId}`);
    const owner = {
      threadId: input.workspace.scope.threadId,
      projectId,
      environmentId: vm.environmentId,
      relayUrl: vm.relayUrl,
      generation: 1,
      operationId: vm.operationId,
    };
    const prior = yield* secrets.get(THREAD_VM_INITIAL_STATE_SECRET);
    if (Option.isSome(prior)) {
      const state = yield* decodeState(new TextDecoder().decode(prior.value));
      if (
        state.workspaceRoot !== workspaceRoot ||
        (yield* encodeInput(state.input)) !== (yield* encodeInput(input))
      )
        return yield* fail("identity_changed");
      if (!state.receipt) return yield* fail("baseline_unconfirmed");
      const current = yield* fence.get(owner.threadId);
      if (
        !current ||
        current.phase !== "frozen" ||
        current.environmentId !== owner.environmentId ||
        current.operationId !== owner.operationId ||
        current.generation !== 1 ||
        current.projectId !== projectId ||
        current.relayUrl !== owner.relayUrl
      )
        return yield* fail("identity_changed");
      return state.receipt;
    }
    const workspace = yield* prepareThreadVmWorkspace(input.workspace, workspaceRoot);
    const snapshot = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
    if (snapshot.projects.length || snapshot.threads.length || (yield* fence.get(owner.threadId)))
      return yield* fail("identity_changed");
    const state = { input, workspaceRoot: workspace.workspaceRoot, receipt: null };
    // Exclusive admission prevents two independent offline engines from racing to initialize.
    // If interrupted after this claim, retain the quarantined VM for explicit recovery/reset.
    yield* secrets
      .create(THREAD_VM_INITIAL_STATE_SECRET, new TextEncoder().encode(yield* encodeState(state)))
      .pipe(Effect.mapError(() => fail("baseline_unconfirmed")));
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`vm-setup:${vm.operationId}:project`),
      projectId,
      title: input.workspace.canonicalKey.split("/").at(-1)!,
      workspaceRoot,
      createdAt: input.createdAt,
    });
    const thread = yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`vm-setup:${vm.operationId}:thread`),
      threadId: owner.threadId,
      projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.workspace.branch,
      worktreePath: null,
      createdAt: input.createdAt,
    });
    yield* fence.prepare(owner);
    const receipt: typeof ThreadVmInitialStateReceipt.Type = {
      version: 1,
      operationId: vm.operationId,
      environmentId: vm.environmentId,
      projectId,
      scope: input.workspace.scope,
      workspaceRoot,
      revision: input.workspace.revision,
      sequence: thread.sequence,
      execution: "frozen",
    };
    yield* secrets.set(
      THREAD_VM_INITIAL_STATE_SECRET,
      new TextEncoder().encode(yield* encodeState({ ...state, receipt })),
    );
    return receipt;
  },
  Effect.mapError((error) =>
    isInitialStateError(error) || isWorkspaceError(error) ? error : fail("baseline_import_failed"),
  ),
);
