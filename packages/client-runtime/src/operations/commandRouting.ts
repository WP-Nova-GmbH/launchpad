import type { RelayThreadCommandReceipt } from "@t3tools/contracts/relay";
import type {
  ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationShellSnapshot,
  ThreadId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** A relay admission does not acknowledge execution or carry an environment sequence. */
export interface RelayCommandSubmission {
  readonly relay: RelayThreadCommandReceipt;
}

export class ThreadCommandRouting extends Context.Reference<{
  readonly remember: (
    snapshot: Pick<OrchestrationShellSnapshot, "threads">,
    environmentId: EnvironmentId,
  ) => void;
  readonly isPortable: (threadId: ThreadId, environmentId: EnvironmentId) => boolean;
  readonly receipt: (
    threadId: ThreadId,
    commandId: string,
    environmentId: EnvironmentId,
  ) => Effect.Effect<RelayThreadCommandReceipt | null, OrchestrationDispatchCommandError>;
  readonly dispatch: (
    command: ClientOrchestrationCommand,
    environmentId: EnvironmentId,
  ) => Effect.Effect<RelayCommandSubmission, OrchestrationDispatchCommandError>;
} | null>("@t3tools/client-runtime/operations/ThreadCommandRouting", {
  defaultValue: () => null,
}) {}
