import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
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
import { Pressable, View } from "react-native";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/AppText";
import { threadMoveSubmissions, threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { openPortableThreadChat, threadEnvironment, threadVmControls } from "../../state/threads";
import { environmentProjects } from "../../state/projects";
import { environmentSnapshotAtom } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../state/atom-registry";

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
  const navigation = useNavigation();
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
      .then((result) => {
        if (!result || cancelled || appAtomRegistry.get(managedRelaySessionAtom) !== session)
          return;
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not connect to the current location.",
          );
        } else navigation.navigate("Thread", result.value);
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
  }, [destinationId, generation, session, threadId, attempt, open, navigation]);
  if (!state || (!recoverUnavailable && !state.destination && !state.error)) return null;
  return (
    <View accessibilityLiveRegion="polite" className="px-3 py-2">
      <Text className="text-xs">
        {busy
          ? "Opening the thread’s current location…"
          : state.isPending
            ? "Checking this thread’s current location…"
            : state.movePending
              ? "This thread is still moving. Check again when the move finishes."
              : state.destination
                ? "Open this thread’s current location to continue."
                : "Could not confirm this thread’s current location."}
      </Text>
      {error || state.error ? (
        <Text className="text-xs text-destructive">{error ?? state.error}</Text>
      ) : null}
      <Pressable
        disabled={busy || state.isPending}
        accessibilityRole="button"
        onPress={() => {
          if (state.destination) setAttempt((value) => value + 1);
          else
            appAtomRegistry.refresh(
              threadVmControls.locationQueryAtom(environmentId, threadId, recoverUnavailable),
            );
        }}
      >
        <Text className="text-sm text-primary">Open current location</Text>
      </Pressable>
    </View>
  );
}

export function CurrentThreadLocation(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  recoverUnavailable?: boolean;
}) {
  if (process.env.EXPO_PUBLIC_THREAD_VM_CONTROLS_ENABLED !== "1") return null;
  return <FollowThreadLocation {...props} />;
}

function Action({
  label,
  disabled = false,
  selected,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="rounded-lg bg-card px-3 py-2"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Text className="text-xs text-foreground">{label}</Text>
    </Pressable>
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
                    commandId: CommandId.make(Crypto.randomUUID()),
                    messageId: MessageId.make(Crypto.randomUUID()),
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
    <View className="gap-2 px-3 py-2">
      <Action label="Move thread" onPress={() => setExpanded(!expanded)} />
      {expanded || saved || error ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground-muted">
            The conversation, queued prompts and files move together after the current turn
            finishes.
          </Text>
          {!session ? (
            <Text className="text-xs">Sign in to Launchpad Connect to move this thread.</Text>
          ) : null}
          {!supported ? (
            <Text className="text-xs">
              {!codexSupported
                ? "Thread moves currently require Codex."
                : config?.environment.capabilities.threadMoves === false
                  ? "Connect this environment for thread moves in its local app first."
                  : "Update this environment’s server to support queued moves."}
            </Text>
          ) : null}
          {codexSupported && !vmSupported && !vm?.data?.status?.allocation ? (
            <Text className="text-xs">
              Private VMs currently require the default Codex provider.
            </Text>
          ) : null}
          {!canonicalKey ? (
            <Text className="text-xs">
              Register this project’s Git repository with Launchpad Connect first.
            </Text>
          ) : null}
          {saved ? (
            <Text accessibilityLiveRegion="polite" className="text-xs">
              Saved request:{" "}
              {saved.command.destination.kind === "vm"
                ? "Move to VM"
                : "Move to selected environment"}
              , {saved.command.position === "next" ? "after current turn" : "at end of queue"}.
            </Text>
          ) : (
            <>
              {!vm?.data?.status?.allocation ? (
                <Action
                  label="Private VM"
                  selected={selected === "vm"}
                  disabled={disabled || !vmSupported}
                  onPress={() => setSelected("vm")}
                />
              ) : null}
              {targets.map((target) => (
                <Action
                  key={target.key}
                  label={titleFor(target)}
                  selected={selected === target.key}
                  disabled={disabled}
                  onPress={() => setSelected(target.key)}
                />
              ))}
              <View className="flex-row gap-2">
                <Action
                  label="After current turn"
                  selected={position === "next"}
                  disabled={disabled}
                  onPress={() => setPosition("next")}
                />
                <Action
                  label="At end of queue"
                  selected={position === "last"}
                  disabled={disabled}
                  onPress={() => setPosition("last")}
                />
              </View>
            </>
          )}
          {saved?.rejection ? (
            <Action
              label="Discard rejected move"
              disabled={busy}
              onPress={() => void run("discard")}
            />
          ) : (
            <Action
              label={saved ? "Retry saved move" : "Queue move"}
              disabled={
                disabled ||
                (!saved && (!destination || (destination.kind === "vm" && !vmSupported)))
              }
              onPress={() => void run("send")}
            />
          )}
          {saved ? (
            <Action
              label="Check outcome"
              disabled={busy || !session}
              onPress={() => void run("check")}
            />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-xs text-destructive">
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
export function ThreadMoveControls(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const session = useAtomValue(managedRelaySessionAtom);
  if (process.env.EXPO_PUBLIC_THREAD_VM_CONTROLS_ENABLED !== "1") return null;
  return (
    <MovePicker
      key={`${session?.accountId ?? "signed-out"}:${threadMoveRelayUrl()}:${props.environmentId}:${props.threadId}`}
      {...props}
    />
  );
}
