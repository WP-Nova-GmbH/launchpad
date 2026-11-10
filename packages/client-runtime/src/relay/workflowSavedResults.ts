import type { ThreadId } from "@t3tools/contracts";
import {
  WORKFLOW_RESULT_MAX_BYTES,
  isTerminalWorkflowJob,
  WorkflowSavedResult,
  type RepositoryWorkflowJob,
} from "@t3tools/contracts/workflows";
import type { ManagedRelaySnapshotState } from "./managedRelayState.ts";
import type { ThreadVmCapabilities } from "@t3tools/contracts/relay";
import type { RelayThreadHistoryPage } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import {
  applyPortableThreadHistoryPage,
  emptyPortableThreadHistory,
  type PortableThreadHistory,
} from "./portableThreadHistory.ts";

/** A logical VM thread may exist before its first Agent, including on cancellation. */
export function savedWorkflowThreadState(job: RepositoryWorkflowJob) {
  if (job.progress?.threadDeletionRequested) return "deleted";
  if (!job.progress?.hasThread && !isTerminalWorkflowJob(job.status)) return "not_started";
  return "available";
}

export function canDeleteSavedWorkflowThread(
  job: RepositoryWorkflowJob,
  canConfigure: boolean,
  capabilities: ManagedRelaySnapshotState<ThreadVmCapabilities | null>,
) {
  return (
    canConfigure &&
    isTerminalWorkflowJob(job.status) &&
    job.progress?.executionReleased === true &&
    !job.progress.threadDeletionRequested &&
    !capabilities.isPending &&
    !capabilities.error &&
    capabilities.data?.permanentDelete === true
  );
}

const sameResult = Schema.toEquivalence(WorkflowSavedResult);
export type SavedWorkflowResultRead = { result: WorkflowSavedResult; patch: string };

/** One account/relay/repository/job owns a reader. Keep at most two selected patches in memory. */
export function makeWorkflowSavedResultReader(scopeKey: string) {
  const cached = new Map<string, SavedWorkflowResultRead>();
  let epoch = 0;
  return {
    clear() {
      epoch++;
      cached.clear();
    },
    async read(result: WorkflowSavedResult, fetch: () => Promise<SavedWorkflowResultRead>) {
      const key = JSON.stringify([scopeKey, result.resultId, result.patch.sha256]);
      const hit = cached.get(key);
      if (hit) return hit;
      const started = epoch;
      const response = await fetch();
      if (epoch !== started) throw new Error("This saved-result view changed.");
      if (
        !sameResult(result, response.result) ||
        new TextEncoder().encode(response.patch).length !== result.patch.sizeBytes ||
        result.patch.sizeBytes > WORKFLOW_RESULT_MAX_BYTES
      )
        throw new Error("The saved result does not match the selected Agent result.");
      cached.set(key, response);
      if (cached.size > 2) cached.delete(cached.keys().next().value!);
      return response;
    },
    async history(
      threadId: ThreadId,
      previous: PortableThreadHistory | null,
      fetch: (after: number) => Promise<RelayThreadHistoryPage>,
    ) {
      const started = epoch;
      const current = previous ?? emptyPortableThreadHistory();
      const page = await fetch(current.cursor);
      if (epoch !== started) throw new Error("This saved conversation view changed.");
      if (page.entries.length > 200)
        throw new Error("The saved conversation page exceeds its limit.");
      return {
        history: applyPortableThreadHistoryPage(current, threadId, page),
        more: page.entries.length === 200,
      };
    },
  };
}
