import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ManagedRelaySession } from "./managedRelayState.ts";
import type { ThreadVmControlAction } from "./threadVmControls.ts";
import type {
  createThreadVmActionJournal,
  ThreadVmActionSubmission,
} from "./threadVmActionSubmission.ts";
export interface ThreadVmActionInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly accountId: string;
  readonly relayUrl: string;
  readonly action: ThreadVmControlAction;
}
export interface ThreadVmActionState {
  readonly entries: ReadonlyArray<ThreadVmActionSubmission>;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly error: string | null;
}
/** Account-scoped presentation; disposal retains the original persisted request for a later retry. */
export function createThreadVmActionController(
  journal: ReturnType<typeof createThreadVmActionJournal>,
  session: ManagedRelaySession | null,
  relayUrl: string | null,
  submit: (input: ThreadVmActionInput) => Promise<unknown>,
) {
  let state: ThreadVmActionState = { entries: [], ready: false, busy: false, error: null };
  let epoch = 0,
    active = false,
    readRevision = 0;
  const listeners = new Set<() => void>();
  const update = (next: Partial<ThreadVmActionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const scope = session && relayUrl ? { accountId: session.accountId, relayUrl } : null;
  const refresh = async () => {
    if (!scope || !active) return;
    const version = ++readRevision,
      started = epoch;
    try {
      const entries = await journal.list(scope);
      if (active && started === epoch && version === readRevision) update({ entries, ready: true });
    } catch {
      if (active && started === epoch && version === readRevision)
        update({
          ready: false,
          error: "Could not read saved VM requests. Resolve storage before changing the VM.",
        });
    }
  };
  const run = async (input: Omit<ThreadVmActionInput, "accountId" | "relayUrl">) => {
    if (!scope || !active || !state.ready || state.busy) return false;
    const started = epoch,
      current = () => active && started === epoch;
    update({ busy: true, error: null });
    try {
      const action = input.action;
      const saved =
        action.type === "restore" ||
        action.type === "restore_backup" ||
        action.type === "reset" ||
        action.type === "delete"
          ? await journal.prepare(scope, {
              environmentId: input.environmentId,
              threadId: input.threadId,
              action,
            })
          : null;
      if (!current()) return false;
      const reply = await submit({ ...(saved ?? input), ...scope });
      if (!current()) return false;
      if (saved) await journal.acknowledge(scope, saved, reply);
      else if (action.type === "cancel_replacement")
        await journal.acknowledgeReplacementCancellation(scope, input.threadId, reply);
      else if (action.type === "cancel_backup_recovery")
        await journal.acknowledgeBackupCancellation(
          scope,
          {
            threadId: input.threadId,
            operationId: action.payload.operationId,
          },
          reply,
        );
      if (!current()) return false;
      await refresh();
      return current();
    } catch (cause) {
      if (current())
        update({
          error:
            cause instanceof Error
              ? cause.message
              : "Could not confirm this VM request. Retry uses the same request.",
        });
      return false;
    } finally {
      if (current()) update({ busy: false });
    }
  };
  return {
    run,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount: () => {
      active = true;
      epoch++;
      update({ entries: [], ready: false, busy: false, error: null });
      void refresh();
      const unsubscribe = journal.subscribe(() => {
        void refresh();
      });
      return () => {
        active = false;
        epoch++;
        unsubscribe();
      };
    },
  };
}
