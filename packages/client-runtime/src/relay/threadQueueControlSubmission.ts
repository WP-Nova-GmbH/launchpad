import {
  ThreadQueuePauseCommand,
  ThreadQueueResumeCommand,
  type ThreadId,
} from "@t3tools/contracts";
import type { RelayThreadCommandReceipt } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
import { threadCommandAcceptance } from "../operations/commands.ts";
const Submission = Schema.Struct({
  command: Schema.Union([ThreadQueuePauseCommand, ThreadQueueResumeCommand]),
  rejection: Schema.NullOr(Schema.String),
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
  if (!relayUrl) throw new Error("Configure Launchpad Connect before changing this queue.");
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
  return {
    read,
    prepare: (
      scope: ThreadQueueControlScope,
      create: () => ThreadQueueControlSubmission["command"],
    ) =>
      storage.withLock(keyFor(scope), async () => {
        const prior = await read(scope);
        if (prior) return prior;
        const draft = { command: create(), rejection: null };
        if (draft.command.threadId !== scope.threadId)
          throw new Error("The queue request targets another thread.");
        await storage.write(keyFor(scope), encode(draft));
        return draft;
      }),
    acknowledge: (
      scope: ThreadQueueControlScope,
      command: ThreadQueueControlSubmission["command"],
      receipt: RelayThreadCommandReceipt,
    ) =>
      storage.withLock(keyFor(scope), async () => {
        if (receipt.commandId !== command.commandId)
          throw new Error("The relay acknowledged another queue request.");
        const outcome = threadCommandAcceptance({ relay: receipt }),
          prior = await read(scope);
        if (prior === null && outcome.status === "accepted") return null;
        if (prior?.command.commandId !== command.commandId)
          throw new Error("The saved queue request changed.");
        if (outcome.status === "accepted") {
          await storage.remove(keyFor(scope));
          return null;
        }
        const next = { ...prior, rejection: outcome.detail ?? "The queue request was rejected." };
        await storage.write(keyFor(scope), encode(next));
        return next;
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
