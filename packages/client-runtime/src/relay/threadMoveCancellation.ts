import type { ThreadMoveQueueEntry, ThreadQueueEntry } from "@t3tools/contracts";
import type { CancelThreadMoveInput, CommandSubmission } from "../operations/commands.ts";
import { threadCommandAcceptance } from "../operations/commands.ts";
import type { PortableCommandState } from "./portableThreads.ts";

type CancellationInput = CancelThreadMoveInput &
  Required<Pick<CancelThreadMoveInput, "commandId" | "createdAt">>;
type Cancellation = {
  input: CancellationInput;
  phase: "sending" | "requested" | "unknown";
};

/** Keep one exact cancellation request until its queue state or rejection is known. */
export function createThreadMoveCancellation() {
  let currentScope: string | undefined;
  const pending = new Map<string, Cancellation>();
  const current = (scope: string, input: CancellationInput) => {
    const value = scope === currentScope ? pending.get(input.messageId) : undefined;
    return value?.input.commandId === input.commandId ? value : undefined;
  };
  return {
    phase: (scope: string, messageId: string) =>
      scope === currentScope ? pending.get(messageId)?.phase : undefined,
    prepare: (scope: string, entry: ThreadMoveQueueEntry, create: () => CancellationInput) => {
      if (scope !== currentScope) {
        currentScope = scope;
        pending.clear();
      }
      const prior = pending.get(entry.messageId);
      if (entry.state === "cancelling" || (prior && prior.phase !== "unknown")) return null;
      const input = prior?.input ?? create();
      pending.set(entry.messageId, { input, phase: "sending" });
      return input;
    },
    acknowledge: (
      scope: string,
      input: CancellationInput,
      submission: CommandSubmission | Parameters<typeof threadCommandAcceptance>[0],
    ) => {
      const value = current(scope, input);
      if (!value) return null;
      const outcome =
        "relay" in submission || "status" in submission
          ? threadCommandAcceptance(submission, input.commandId)
          : { status: "accepted" as const };
      if (outcome.status === "rejected") pending.delete(input.messageId);
      else value.phase = outcome.status === "accepted" ? "requested" : "unknown";
      return outcome;
    },
    failed: (scope: string, input: CancellationInput) => {
      const value = current(scope, input);
      if (value) value.phase = "unknown";
    },
    observe: (
      scope: string,
      entries: ReadonlyArray<ThreadQueueEntry>,
      commands: ReadonlyArray<Pick<PortableCommandState, "commandId" | "receipt">>,
    ) => {
      let changed = false;
      let rejection: string | undefined;
      if (scope !== currentScope) {
        currentScope = scope;
        changed = pending.size > 0;
        pending.clear();
      }
      for (const [messageId, value] of pending) {
        const entry = entries.find((candidate) => candidate.messageId === messageId);
        const receipt = commands.find((command) => command.commandId === value.input.commandId)
          ?.receipt?.receipt;
        if (!entry || entry.kind !== "move" || entry.state === "cancelling") {
          pending.delete(messageId);
          changed = true;
        } else if (receipt?.status === "rejected") {
          pending.delete(messageId);
          rejection = receipt.detail ?? "The cancellation request was rejected.";
          changed = true;
        }
      }
      return { changed, rejection };
    },
  };
}
