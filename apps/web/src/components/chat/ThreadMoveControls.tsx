import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  threadMoveProjectTargets,
  threadMoveRepositoryCanonicalKey,
  threadMoveProviderSupported,
  type ThreadMoveSubmission,
} from "@t3tools/client-runtime/relay/threadMoveSubmission";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ThreadId,
  type ThreadMoveDestination,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { threadMoveSubmissions, threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { openPortableThreadChat, threadEnvironment, threadVmControls } from "../../state/threads";
import { environmentProjects } from "../../state/projects";
import { environmentSnapshotAtom } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { useCloudLinkController } from "../../cloud/useCloudLinkController";
import { environmentCatalog } from "../../connection/catalog";

function FollowThreadLocation({
  environmentId,
  threadId,
  recoverUnavailable = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  recoverUnavailable?: boolean;
}) {
  const state = useAtomValue(
    threadVmControls.locationViewAtom(environmentId, threadId, recoverUnavailable),
  );
  const session = useAtomValue(managedRelaySessionAtom);
  const open = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const destinationId = state?.destination?.environmentId,
    generation = state?.destination?.generation;
  useEffect(() => {
    if (!destinationId || generation === undefined || !session) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        if (cancelled || appAtomRegistry.get(managedRelaySessionAtom) !== session) return null;
        setBusy(true);
        setError(null);
        return open({
          threadId,
          title: "Moved thread",
          expectedPlacement: { environmentId: destinationId, generation },
        });
      })
      .then(async (result) => {
        if (!result || cancelled || appAtomRegistry.get(managedRelaySessionAtom) !== session)
          return;
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not connect to the current location.",
          );
        } else
          await navigate({ to: "/$environmentId/$threadId", params: result.value, replace: true });
      })
      .catch(() => {
        if (!cancelled)
          setError(
            attempt > 0
              ? "Still could not open the current location. Try again after checking its connection."
              : "Could not open the current location. Try again.",
          );
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destinationId, generation, session, threadId, attempt, open, navigate]);
  if (!state || (!recoverUnavailable && !state.destination && !state.error)) return null;
  return (
    <section role="status" className="border-b border-border px-3 py-2 text-xs">
      <p>
        {busy
          ? "Opening the thread’s current location…"
          : state.isPending
            ? "Checking this thread’s current location…"
            : state.movePending
              ? "This thread is still moving. Check again when the move finishes."
              : state.destination
                ? "Open this thread’s current location to continue."
                : "Could not confirm this thread’s current location."}
      </p>
      {error || state.error ? (
        <p role="alert" className="text-destructive">
          {error ?? state.error}
        </p>
      ) : null}
      <Button
        size="xs"
        variant="secondary"
        disabled={busy || state.isPending}
        onClick={() => {
          if (state.destination) setAttempt((value) => value + 1);
          else
            appAtomRegistry.refresh(
              threadVmControls.locationQueryAtom(environmentId, threadId, recoverUnavailable),
            );
        }}
      >
        Open current location
      </Button>
    </section>
  );
}

export function CurrentThreadLocation(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  recoverUnavailable?: boolean;
}) {
  if (import.meta.env.VITE_THREAD_VM_CONTROLS_ENABLED !== "1") return null;
  return <FollowThreadLocation {...props} />;
}

function PersonalMoveLink({ environmentId }: { environmentId: EnvironmentId }) {
  const controller = useCloudLinkController();
  const reconnect = useAtomCommand(environmentCatalog.retryNow);
  const [busy, setBusy] = useState(false);
  if (
    controller.linkState.target?.environmentId !== environmentId ||
    controller.managedTunnelActive ||
    controller.publishAgentActivity
  )
    return null;
  const update = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (
        await controller.reconcileCloudState({
          managedTunnel: false,
          publish: false,
          keepLinked: !controller.linked,
        })
      )
        await reconnect(environmentId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">
        {controller.linked
          ? "This environment is connected for thread moves."
          : "Connect this environment to move its threads. Agent activity publishing stays off."}
      </p>
      <Button
        size="xs"
        variant="secondary"
        disabled={busy || controller.linkState.isPending}
        onClick={() => void update()}
      >
        {busy
          ? "Updating connection"
          : controller.linked
            ? "Disconnect relay"
            : "Connect for thread moves"}
      </Button>
      {controller.operationError ? (
        <p role="alert" className="text-destructive">
          {controller.operationError}
        </p>
      ) : null}
    </div>
  );
}

function MovePicker({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const session = useAtomValue(managedRelaySessionAtom);
  const relayUrl = threadMoveRelayUrl();
  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const vm = useAtomValue(threadVmControls.viewAtom(environmentId, threadId));
  const { environments } = useEnvironments();
  const thread = snapshot?.threads.find((item) => item.id === threadId);
  const source = projects.find(
    (item) => item.environmentId === environmentId && item.id === thread?.projectId,
  );
  const canonicalKey =
    source && thread
      ? threadMoveRepositoryCanonicalKey(source, thread, config?.environment, vm?.data?.status)
      : undefined;
  const targets = source
    ? threadMoveProjectTargets(source, projects, environments, canonicalKey)
    : [];
  const enqueue = useAtomCommand(threadEnvironment.enqueueMove, { reportFailure: false });
  const receipt = useAtomCommand(threadEnvironment.getCommandReceipt, { reportFailure: false });
  const [expanded, setExpanded] = useState(false),
    [selected, setSelected] = useState("vm"),
    [position, setPosition] = useState<"next" | "last">("next"),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<ThreadMoveSubmission | null>(null),
    [ready, setReady] = useState(!session || !relayUrl),
    [error, setError] = useState<string | null>(null);
  const accountId = session?.accountId ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!accountId || !relayUrl) return;
    void threadMoveSubmissions.read({ accountId, relayUrl, environmentId, threadId }).then(
      (value) => {
        if (!cancelled) {
          setSaved(value);
          setReady(true);
        }
      },
      () => {
        if (!cancelled)
          setError("Could not read the saved move. Resolve storage before sending another.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountId, relayUrl, environmentId, threadId]);
  if (!thread || !source || thread.archivedAt) return null;
  const selectedProvider = config?.providers.find(
    (provider) => provider.instanceId === thread.modelSelection.instanceId,
  );
  const codexSupported = threadMoveProviderSupported(selectedProvider, "environment");
  const vmSupported = threadMoveProviderSupported(selectedProvider, "vm");
  const supported = config?.environment.capabilities.threadMoves === true && codexSupported;
  const destination: ThreadMoveDestination | undefined =
    selected === "vm"
      ? vm?.data?.status?.allocation
        ? undefined
        : { kind: "vm" }
      : targets.find((target) => target.key === selected)?.destination;
  const disabled = busy || !ready || !session || !relayUrl || !supported || !canonicalKey;
  const lookup = async (command: ThreadMoveSubmission["command"]) => {
    const result = await receipt({
      environmentId,
      input: { threadId, commandId: command.commandId },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const run = async (kind: "send" | "check" | "discard") => {
    if (busy || !session || !relayUrl || !ready) return;
    const scope = { accountId: session.accountId, relayUrl, environmentId, threadId };
    setBusy(true);
    setError(null);
    try {
      if (kind === "discard") await threadMoveSubmissions.discardRejected(scope);
      else {
        const outcome =
          kind === "check" && saved
            ? await threadMoveSubmissions.reconcile(scope, saved, await lookup(saved.command))
            : await threadMoveSubmissions.submit(
                scope,
                () => {
                  if (!destination) throw new Error("Choose a destination for this repository.");
                  if (destination.kind === "vm" && !vmSupported)
                    throw new Error("Private VMs currently require the default Codex provider.");
                  return {
                    type: "thread.move.enqueue",
                    commandId: CommandId.make(randomUUID()),
                    messageId: MessageId.make(randomUUID()),
                    threadId,
                    destination,
                    position,
                    createdAt: new Date().toISOString(),
                  };
                },
                async (command) => {
                  const result = await enqueue({ environmentId, input: command });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  return result.value;
                },
                lookup,
                () => appAtomRegistry.get(managedRelaySessionAtom) === session,
              );
        if (outcome.status === "unknown")
          setError("Acceptance is unknown. This move remains saved; retry uses the same IDs.");
        else if (outcome.status === "rejected")
          setError(outcome.detail ?? "The move was rejected.");
        else setExpanded(false);
      }
      setSaved(await threadMoveSubmissions.read(scope));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not confirm this move. The saved request is retained.",
      );
      try {
        setSaved(await threadMoveSubmissions.read(scope));
      } catch {
        /* Keep the visible draft. */
      }
    } finally {
      setBusy(false);
    }
  };
  const titleFor = (target: (typeof targets)[number]) =>
    `${environments.find((item) => item.environmentId === target.project.environmentId)?.label ?? target.project.environmentId} / ${target.project.title}`;
  return (
    <section aria-label="Move thread" className="border-b border-border px-3 py-2 text-xs">
      <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(!expanded)}>
        Move thread
      </Button>
      {expanded || saved || error ? (
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">
            The conversation, queued prompts and files move together after the current turn
            finishes.
          </p>
          {!session ? <p>Sign in to Launchpad Connect to move this thread.</p> : null}
          {!supported ? (
            <p>
              {!codexSupported
                ? "Thread moves currently require Codex."
                : config?.environment.capabilities.threadMoves === false
                  ? "Connect this environment to the relay before moving its threads."
                  : "Update this environment’s server to support queued moves."}
            </p>
          ) : null}
          {session &&
          codexSupported &&
          config?.environment.capabilities.threadMoves !== undefined ? (
            <PersonalMoveLink environmentId={environmentId} />
          ) : null}
          {codexSupported && !vmSupported && !vm?.data?.status?.allocation ? (
            <p>Private VMs currently require the default Codex provider.</p>
          ) : null}
          {!canonicalKey ? (
            <p>Register this project’s Git repository with Launchpad Connect first.</p>
          ) : null}
          {saved ? (
            <p role="status">
              Saved request:{" "}
              {saved.command.destination.kind === "vm"
                ? "Move to VM"
                : "Move to selected environment"}
              , {saved.command.position === "next" ? "after current turn" : "at end of queue"}.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Move destination">
                {!vm?.data?.status?.allocation ? (
                  <Button
                    size="xs"
                    variant={selected === "vm" ? "secondary" : "ghost-muted"}
                    aria-pressed={selected === "vm"}
                    disabled={disabled || !vmSupported}
                    onClick={() => setSelected("vm")}
                  >
                    Private VM
                  </Button>
                ) : null}
                {targets.map((target) => (
                  <Button
                    key={target.key}
                    size="xs"
                    variant={selected === target.key ? "secondary" : "ghost-muted"}
                    aria-pressed={selected === target.key}
                    disabled={disabled}
                    onClick={() => setSelected(target.key)}
                  >
                    {titleFor(target)}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2" role="group" aria-label="Move timing">
                <Button
                  size="xs"
                  variant={position === "next" ? "secondary" : "ghost-muted"}
                  disabled={disabled}
                  aria-pressed={position === "next"}
                  onClick={() => setPosition("next")}
                >
                  After current turn
                </Button>
                <Button
                  size="xs"
                  variant={position === "last" ? "secondary" : "ghost-muted"}
                  disabled={disabled}
                  aria-pressed={position === "last"}
                  onClick={() => setPosition("last")}
                >
                  At end of queue
                </Button>
              </div>
            </>
          )}
          <div className="flex gap-2">
            {saved?.rejection ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy}
                onClick={() => void run("discard")}
              >
                Discard rejected move
              </Button>
            ) : (
              <Button
                size="xs"
                variant="secondary"
                disabled={
                  disabled ||
                  (!saved && (!destination || (destination.kind === "vm" && !vmSupported)))
                }
                onClick={() => void run("send")}
              >
                {saved ? "Retry saved move" : "Queue move"}
              </Button>
            )}
            {saved ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={busy || !session}
                onClick={() => void run("check")}
              >
                Check outcome
              </Button>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ThreadMoveControls(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const session = useAtomValue(managedRelaySessionAtom);
  if (import.meta.env.VITE_THREAD_VM_CONTROLS_ENABLED !== "1") return null;
  return (
    <MovePicker
      key={`${session?.accountId ?? "signed-out"}:${threadMoveRelayUrl()}:${props.environmentId}:${props.threadId}`}
      {...props}
    />
  );
}
