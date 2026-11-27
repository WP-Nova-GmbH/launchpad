import {
  ThreadQueuePauseCommand,
  ThreadQueueResumeCommand,
  type ThreadId,
  type CommandId,
} from "@t3tools/contracts";
import type { RelayThreadCommandReceipt, RelayThreadCurrentQueue } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
const Submission = Schema.Struct({
  command: Schema.Union([ThreadQueuePauseCommand, ThreadQueueResumeCommand]),
  rejection: Schema.NullOr(Schema.String),
  accepted: Schema.optionalKey(Schema.Boolean),
});
const codec = Schema.fromJsonString(Submission),
  decode = Schema.decodeSync(codec),
  encode = Schema.encodeSync(codec);
export type ThreadQueueControlSubmission = typeof Submission.Type;
export interface ThreadQueueControlScope {
  readonly accountId: string;
  readonly relayUrl: string;
  readonly threadId: ThreadId;
}
const keyFor = (scope: ThreadQueueControlScope) => {
  const relayUrl = normalizeSecureRelayUrl(scope.relayUrl);
  if (!relayUrl || !scope.accountId)
    throw new Error("Sign in to Launchpad Connect before changing this queue.");
  // Queue ownership follows the logical thread through environment changes.
  return `launchpad.thread-queue-control.v1:${JSON.stringify([scope.accountId, relayUrl, scope.threadId])}`;
};
export function createThreadQueueControlJournal(storage: ThreadMoveSubmissionStorage) {
  const read = async (scope: ThreadQueueControlScope) => {
    const raw = await storage.read(keyFor(scope));
    const draft = raw === null ? null : decode(raw);
    if (draft && draft.command.threadId !== scope.threadId)
      throw new Error("The saved queue request belongs to another thread.");
    return draft;
  };
  const observe = (scope: ThreadQueueControlScope, current: RelayThreadCurrentQueue) =>
    storage.withLock(keyFor(scope), async () => {
      if (current.threadId !== scope.threadId)
        throw new Error("The current queue belongs to another thread.");
      const prior = await read(scope);
      // Admission and execution can happen on different VM generations. Only the exact
      // command's projected queue event proves that the displayed state includes its result.
      if (prior?.accepted && current.appliedCommandId === prior.command.commandId) {
        await storage.remove(keyFor(scope));
        return null;
      }
      return prior;
    });
  const acknowledge = (
    scope: ThreadQueueControlScope,
    command: ThreadQueueControlSubmission["command"],
    receipt: RelayThreadCommandReceipt,
  ) =>
    storage.withLock(keyFor(scope), async () => {
      if (command.threadId !== scope.threadId || receipt.commandId !== command.commandId)
        throw new Error("The relay acknowledged another queue request.");
      const prior = await read(scope);
      if (prior && prior.command.commandId !== command.commandId)
        throw new Error("The saved queue request changed.");
      // Admission does not settle a command, and a late admission response must not undo acceptance.
      if (receipt.receipt === null || prior?.accepted) return prior;
      const outcome = receipt.receipt;
      if (prior === null && outcome.status === "accepted") return null;
      if (prior?.command.commandId !== command.commandId)
        throw new Error("The saved queue request changed.");
      const next =
        outcome.status === "accepted"
          ? { ...prior, accepted: true }
          : { ...prior, rejection: outcome.detail ?? "The queue request was rejected." };
      await storage.write(keyFor(scope), encode(next));
      return next;
    });
  return {
    read,
    observe,
    acknowledge,
    refresh: async (
      scope: ThreadQueueControlScope,
      readCurrent: (commandId?: CommandId) => Promise<RelayThreadCurrentQueue>,
      readReceipt: (commandId: string) => Promise<RelayThreadCommandReceipt | null>,
    ) => {
      const prior = await read(scope);
      if (prior && !prior.accepted && !prior.rejection) {
        const receipt = await readReceipt(prior.command.commandId);
        if (receipt) await acknowledge(scope, prior.command, receipt);
      }
      return observe(scope, await readCurrent(prior?.command.commandId));
    },
    prepare: (
      scope: ThreadQueueControlScope,
      current: RelayThreadCurrentQueue | null,
      create: () => ThreadQueueControlSubmission["command"],
    ) =>
      storage.withLock(keyFor(scope), async () => {
        const prior = await read(scope);
        if (prior) return prior;
        if (!current || current.threadId !== scope.threadId)
          throw new Error("Read this thread's current queue before changing it.");
        const draft = {
          command: create(),
          rejection: null,
          accepted: false,
        };
        if (draft.command.threadId !== scope.threadId)
          throw new Error("The queue request targets another thread.");
        await storage.write(keyFor(scope), encode(draft));
        return draft;
      }),
    discardRejected: (scope: ThreadQueueControlScope) =>
      storage.withLock(keyFor(scope), async () => {
        const prior = await read(scope);
        if (!prior?.rejection)
          throw new Error("Check this queue request before discarding an uncertain command.");
        await storage.remove(keyFor(scope));
      }),
  };
}
