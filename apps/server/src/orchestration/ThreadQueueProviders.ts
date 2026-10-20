import type {
  OrchestrationCommand,
  OrchestrationThread,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Follow each move in order: prompts retain their own model selection, and a
 * prompt before a move can change the native conversation that must be moved.
 */
export const validateThreadQueueProviders = Effect.fn("validateThreadQueueProviders")(function* (
  thread: Pick<OrchestrationThread, "modelSelection" | "promptQueue">,
  startsOnVm: boolean,
  commandType: OrchestrationCommand["type"],
  supportsTransfer: (id: ProviderInstanceId) => Effect.Effect<boolean>,
) {
  let onVm = startsOnVm;
  let instanceId = thread.modelSelection.instanceId;
  const checked = new Set<ProviderInstanceId>();
  const requireCodex = Effect.fnUntraced(function* (id: ProviderInstanceId, vm = false) {
    // Fresh guests and Reset VM expose only the default Codex instance.
    if (vm && id !== "codex")
      return yield* new OrchestrationCommandInvariantError({
        commandType,
        detail: "Private VMs currently require the default Codex provider.",
      });
    if (checked.has(id)) return;
    if (!(yield* supportsTransfer(id)))
      return yield* new OrchestrationCommandInvariantError({
        commandType,
        detail:
          "VM work and conversation moves require an enabled Codex provider. Change the queued provider or the move order first.",
      });
    checked.add(id);
  });
  if (onVm) yield* requireCodex(instanceId, true);
  for (const entry of thread.promptQueue?.entries ?? []) {
    if (entry.kind === "move") {
      yield* requireCodex(instanceId, onVm || entry.destination.kind === "vm");
      onVm = entry.destination.kind === "vm";
    } else {
      instanceId = entry.modelSelection?.instanceId ?? instanceId;
      if (onVm) yield* requireCodex(instanceId, true);
    }
  }
});

export const changesQueueProviders = (command: OrchestrationCommand) =>
  command.type === "thread.move.enqueue" ||
  command.type === "thread.move.edit" ||
  command.type === "thread.move.cancel" ||
  command.type === "thread.move.claim" ||
  command.type === "thread.queue.reorder" ||
  command.type === "thread.prompt.enqueue" ||
  command.type === "thread.prompt.edit" ||
  command.type === "thread.prompt.remove" ||
  command.type === "thread.prompt.claim" ||
  command.type === "thread.prompt.steer" ||
  (command.type === "thread.meta.update" && command.modelSelection !== undefined);
