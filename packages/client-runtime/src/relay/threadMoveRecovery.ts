import type {
  EnvironmentId,
  OrchestrationGetCommandReceiptResult,
  ThreadRelayRouting,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { EnvironmentThreadState } from "../state/threadState.ts";
import type {
  createThreadMoveSubmissionJournal,
  ThreadMoveSubmission,
  ThreadMoveSubmissionObservation,
  ThreadMoveSubmissionScope,
} from "./threadMoveSubmission.ts";

type Placement = NonNullable<ThreadMoveSubmissionObservation["placement"]>;

/** Read the queue and its cursor together; cached or retired detail cannot resolve a move. */
export function threadMoveObservation(
  environmentId: EnvironmentId,
  state: EnvironmentThreadState,
  placement: Placement | null,
  routing: ThreadRelayRouting | null,
): ThreadMoveSubmissionObservation {
  const thread = Option.getOrNull(state.data);
  if (state.status !== "live" || !thread || routing?.phase !== "active") return { entries: [] };
  const currentOwner =
    placement?.operationId === null &&
    placement.environmentId === environmentId &&
    placement.generation === routing.generation;
  return {
    entries: currentOwner ? (thread.promptQueue?.entries ?? []) : [],
    ...(state.snapshotSequence === undefined
      ? {}
      : {
          projection: {
            environmentId,
            generation: routing.generation,
            snapshotSequence: state.snapshotSequence,
          },
        }),
    ...(placement ? { placement } : {}),
  };
}

/** Subscribe to this threshold rather than repainting on every streamed event. */
export function threadMoveSnapshotReached(
  environmentId: EnvironmentId,
  state: EnvironmentThreadState,
  saved: ThreadMoveSubmission | null,
  routing: ThreadRelayRouting | null,
) {
  const proof = saved?.executionProof;
  return !!(
    proof &&
    proof.environmentId === environmentId &&
    state.status === "live" &&
    routing?.phase === "active" &&
    routing.generation === proof.generation &&
    state.snapshotSequence !== undefined &&
    state.snapshotSequence >= proof.sequence
  );
}

/** Verify a saved command on its current owner without creating another move or connection. */
export async function recoverThreadMove(
  journal: ReturnType<typeof createThreadMoveSubmissionJournal>,
  scope: ThreadMoveSubmissionScope,
  saved: ThreadMoveSubmission,
  options: {
    readonly checkLocation: () => Promise<Placement>;
    readonly readReceipt: () => Promise<typeof OrchestrationGetCommandReceiptResult.Type>;
    readonly readObservation: () => ThreadMoveSubmissionObservation;
    readonly isCurrent: () => boolean;
  },
) {
  const ensureCurrent = () => {
    if (!options.isCurrent())
      throw new Error("The thread or account changed. The move remains saved.");
  };
  ensureCurrent();
  const before = await options.checkLocation();
  ensureCurrent();
  const initial = options.readObservation();
  if (
    before.operationId !== null ||
    before.environmentId !== scope.environmentId ||
    initial.projection?.environmentId !== before.environmentId ||
    initial.projection.generation !== before.generation
  )
    return journal.read(scope);

  if (
    initial.entries.some(
      (entry) => entry.kind === "move" && entry.messageId === saved.command.messageId,
    )
  )
    return journal.observe(scope, saved, initial);

  const receipt = await options.readReceipt();
  ensureCurrent();
  if ("relay" in receipt || receipt.status === "unknown") return journal.read(scope);
  const after = await options.checkLocation();
  ensureCurrent();
  if (
    after.operationId !== null ||
    after.environmentId !== before.environmentId ||
    after.generation !== before.generation
  )
    return journal.read(scope);
  const observation = options.readObservation();
  if (
    observation.projection?.environmentId !== after.environmentId ||
    observation.projection.generation !== after.generation
  )
    return journal.read(scope);
  if (receipt.status === "rejected") {
    await journal.reconcile(scope, saved, receipt);
    return journal.read(scope);
  }
  if (receipt.sequence === undefined) return journal.read(scope);
  return journal.observe(scope, saved, {
    ...observation,
    placement: after,
    executionProof: {
      commandId: saved.command.commandId,
      environmentId: scope.environmentId,
      generation: after.generation,
      sequence: receipt.sequence,
    },
  });
}
