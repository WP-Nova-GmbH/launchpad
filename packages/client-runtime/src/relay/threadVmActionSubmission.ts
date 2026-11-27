import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  RelayThreadVmRestoreRequest,
  RelayThreadVmBackupRecoveryRequest,
  RelayThreadVmBackupRecoveryCancellation,
  RelayThreadVmResetRequest,
  RelayThreadDeletionRequest,
  RelayThreadVmRestoreResponse,
  RelayThreadVmResetResponse,
  RelayThreadDeletion,
  RelayThreadVmReplacement,
} from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";
import type { ThreadMoveSubmissionStorage } from "./threadMoveSubmission.ts";
const Action = Schema.Union([
  Schema.Struct({ type: Schema.Literal("restore"), payload: RelayThreadVmRestoreRequest }),
  Schema.Struct({
    type: Schema.Literal("restore_backup"),
    payload: RelayThreadVmBackupRecoveryRequest,
  }),
  Schema.Struct({ type: Schema.Literal("reset"), payload: RelayThreadVmResetRequest }),
  Schema.Struct({ type: Schema.Literal("delete"), payload: RelayThreadDeletionRequest }),
]);
const Submission = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  action: Action,
});
const codec = Schema.fromJsonString(Schema.Array(Submission));
const decode = Schema.decodeSync(codec),
  encode = Schema.encodeSync(codec);
const decodeRestore = Schema.decodeUnknownSync(RelayThreadVmRestoreResponse),
  decodeReset = Schema.decodeUnknownSync(RelayThreadVmResetResponse),
  decodeDeletion = Schema.decodeUnknownSync(RelayThreadDeletion),
  decodeReplacement = Schema.decodeUnknownSync(RelayThreadVmReplacement);
export type ThreadVmActionSubmission = typeof Submission.Type;
export interface ThreadVmActionScope {
  readonly accountId: string;
  readonly relayUrl: string;
}
const keyFor = (scope: ThreadVmActionScope) => {
  const relay = normalizeSecureRelayUrl(scope.relayUrl);
  if (!relay || !scope.accountId)
    throw new Error("Sign in to Launchpad Connect before changing this VM.");
  return `launchpad.thread-vm-actions.v1:${JSON.stringify([scope.accountId, relay])}`;
};
/** Retains uncertain lifecycle requests independently of environment discovery and app restarts. */
export function createThreadVmActionJournal(storage: ThreadMoveSubmissionStorage) {
  const listeners = new Set<() => void>();
  const list = async (scope: ThreadVmActionScope) => {
    const raw = await storage.read(keyFor(scope));
    const entries = raw === null ? [] : decode(raw);
    if (new Set(entries.map((e) => e.threadId)).size !== entries.length)
      throw new Error("Saved VM requests contain duplicate threads.");
    return entries;
  };
  const save = async (
    scope: ThreadVmActionScope,
    entries: ReadonlyArray<ThreadVmActionSubmission>,
  ) => {
    if (entries.length) await storage.write(keyFor(scope), encode(entries));
    else await storage.remove(keyFor(scope));
    for (const listener of listeners) listener();
  };
  const prepare = (scope: ThreadVmActionScope, incoming: ThreadVmActionSubmission) =>
    storage.withLock(keyFor(scope), async () => {
      const entries = await list(scope),
        prior = entries.find((e) => e.threadId === incoming.threadId);
      if (prior) {
        if (prior.action.type !== incoming.action.type)
          throw new Error("Confirm the saved VM request before choosing another action.");
        return prior;
      }
      await save(scope, [...entries, incoming]);
      return incoming;
    });
  const acknowledge = (
    scope: ThreadVmActionScope,
    submitted: ThreadVmActionSubmission,
    response: unknown,
  ) =>
    storage.withLock(keyFor(scope), async () => {
      const entries = await list(scope),
        prior = entries.find((e) => e.threadId === submitted.threadId);
      if (!prior || encode([prior]) !== encode([submitted]))
        throw new Error("The saved VM request changed while confirming it.");
      const { action, threadId } = prior,
        request = action.payload;
      let finished: boolean;
      if (action.type === "delete") {
        const receipt = decodeDeletion(response);
        if (
          receipt.threadId !== threadId ||
          receipt.operationId !== request.operationId ||
          receipt.generation !== request.expectedGeneration
        )
          throw new Error("The relay acknowledged a different deletion.");
        finished = receipt.phase === "completed";
      } else {
        const reply = action.type === "reset" ? decodeReset(response) : decodeRestore(response);
        if (reply.status === "quota_reached") {
          if (
            reply.replacement?.threadId !== threadId ||
            reply.replacement.requestId !== request.operationId
          )
            throw new Error("The relay did not retain this VM replacement request.");
          finished = false;
        } else {
          const receipt = "restore" in reply ? reply.restore : reply.reset;
          if (
            receipt.threadId !== threadId ||
            receipt.operationId !== request.operationId ||
            receipt.allocationId !== action.payload.allocationId ||
            receipt.generation !== request.expectedGeneration + 1
          )
            throw new Error("The relay acknowledged a different VM operation.");
          finished = true;
        }
      }
      if (finished)
        await save(
          scope,
          entries.filter((e) => e.threadId !== threadId),
        );
      return finished;
    });
  const acknowledgeReplacementCancellation = (
    scope: ThreadVmActionScope,
    threadId: ThreadId,
    response: unknown,
  ) =>
    storage.withLock(keyFor(scope), async () => {
      const entries = await list(scope),
        prior = entries.find((e) => e.threadId === threadId);
      if (!prior || prior.action.type === "delete") return;
      const receipt = decodeReplacement(response);
      if (
        receipt.threadId !== threadId ||
        receipt.requestId !== prior.action.payload.operationId ||
        receipt.phase !== "cancelled"
      )
        throw new Error("The relay has not cancelled this saved VM replacement.");
      await save(
        scope,
        entries.filter((e) => e.threadId !== threadId),
      );
    });
  const acknowledgeBackupCancellation = (
    scope: ThreadVmActionScope,
    submitted: { threadId: ThreadId; operationId: string },
    response: unknown,
  ) =>
    storage.withLock(keyFor(scope), async () => {
      const entries = await list(scope),
        prior = entries.find((entry) => entry.threadId === submitted.threadId),
        receipt = Schema.decodeUnknownSync(RelayThreadVmBackupRecoveryCancellation)(response);
      if (
        !prior ||
        prior.action.type !== "restore_backup" ||
        prior.action.payload.operationId !== submitted.operationId ||
        receipt.operationId !== submitted.operationId ||
        receipt.threadId !== submitted.threadId
      )
        throw new Error("The relay has not cancelled this saved backup recovery request.");
      await save(
        scope,
        entries.filter((entry) => entry.threadId !== submitted.threadId),
      );
    });
  return {
    list,
    prepare,
    acknowledge,
    acknowledgeReplacementCancellation,
    acknowledgeBackupCancellation,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
