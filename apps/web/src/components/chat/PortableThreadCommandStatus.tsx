import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { portableThreadCommands } from "../../state/threads";

export function PortableThreadCommandStatus({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const state = useAtomValue(portableThreadCommands.viewAtom(environmentId, threadId));
  if (
    !state ||
    !(
      state.waitingForRelay ||
      state.waitingForEnvironment ||
      state.rejections.length ||
      state.error
    )
  )
    return null;
  return (
    <div role="status" className="border-border border-b px-4 py-2 text-xs text-muted-foreground">
      {state.waitingForRelay > 0 ? (
        <p>
          Waiting to confirm {state.waitingForRelay} change{state.waitingForRelay === 1 ? "" : "s"}{" "}
          with Launchpad Connect.
        </p>
      ) : null}
      {state.waitingForEnvironment > 0 ? (
        <p>
          {state.waitingForEnvironment}
          {state.hasMore ? "+" : ""} change
          {state.waitingForEnvironment === 1 && !state.hasMore ? "" : "s"} waiting for this
          environment.
        </p>
      ) : null}
      {state.rejections.map(({ commandId, detail }) => (
        <p key={commandId} className="text-destructive">
          {detail}
        </p>
      ))}
      {state.error ? (
        <p className="text-destructive">Queued changes could not be refreshed. {state.error}</p>
      ) : null}
    </div>
  );
}
