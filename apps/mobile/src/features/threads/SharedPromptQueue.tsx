import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadPromptQueue, TurnId } from "@t3tools/contracts";
import {
  promptAttributionLabel,
  queuedPromptEditConflict,
  type QueuedPromptEdit,
} from "@t3tools/client-runtime/state/threads";
import { useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function QueueButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
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

export function SharedPromptQueue({
  environmentId,
  threadId,
  queue,
  activeTurnId,
  unavailable,
  supportsPreparation = false,
  hasStartedTurn = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  queue: ThreadPromptQueue;
  activeTurnId: TurnId | null;
  unavailable: boolean;
  supportsPreparation?: boolean;
  hasStartedTurn?: boolean;
}) {
  const editPrompt = useAtomCommand(threadEnvironment.editPrompt, { reportFailure: false });
  const removePrompt = useAtomCommand(threadEnvironment.removePrompt, { reportFailure: false });
  const steerPrompt = useAtomCommand(threadEnvironment.steerPrompt, { reportFailure: false });
  const pauseQueue = useAtomCommand(threadEnvironment.pauseQueue, { reportFailure: false });
  const resumeQueue = useAtomCommand(threadEnvironment.resumeQueue, { reportFailure: false });
  const resolveQueue = useAtomCommand(threadEnvironment.resolveQueue, { reportFailure: false });
  const retryPreparation = useAtomCommand(threadEnvironment.retryPreparation, {
    reportFailure: false,
  });
  const [edit, setEdit] = useState<QueuedPromptEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = queue.entries.find((entry) => entry.messageId === edit?.messageId);
  const conflict = edit ? queuedPromptEditConflict(edit, current) : null;
  const disabled = unavailable || busy;
  const preparation = queue.preparation;
  const blockedByPreparation = preparation !== undefined && preparation.state !== "ready";
  const request = <T,>(input: T) => ({ environmentId, input });
  const run = async (
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    onSuccess?: () => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Success") onSuccess?.();
      else {
        const failure = squashAtomCommandFailure(result);
        setError(
          `${failure instanceof Error ? failure.message : "The request failed."} Your draft is preserved.`,
        );
      }
    } catch {
      setError("Could not update the queue. Your draft is preserved.");
    } finally {
      setBusy(false);
    }
  };
  if (
    queue.entries.length === 0 &&
    queue.pauseReason === null &&
    edit === null &&
    !blockedByPreparation
  )
    return null;
  return (
    <ScrollView
      className="mx-3 mb-2 rounded-xl border border-border bg-white p-3"
      style={{ maxHeight: 260 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="mb-2 flex-row items-center justify-between gap-2">
        <Text className="font-t3-medium text-sm text-foreground">
          Shared queue · {queue.entries.length}
        </Text>
        {queue.pauseReason === null || (blockedByPreparation && preparation.settled === false) ? (
          <QueueButton
            label={blockedByPreparation ? "Stop setup" : "Pause queue"}
            disabled={disabled}
            onPress={() => void run(() => pauseQueue(request({ threadId })))}
          />
        ) : queue.pauseReason.code !== "delivery-unknown" ? (
          <QueueButton
            label="Resume queue"
            disabled={disabled || queue.handoff !== null || blockedByPreparation}
            onPress={() =>
              void run(() => resumeQueue(request({ threadId, expectedRevision: queue.revision })))
            }
          />
        ) : null}
      </View>
      {blockedByPreparation ? (
        <View className="mb-2 gap-2">
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {preparation.state === "failed"
              ? (preparation.failure?.detail ??
                "Setup needs attention. Accepted prompts remain queued.")
              : "Preparing the workspace. Accepted prompts will wait until it is ready."}
          </Text>
          {!supportsPreparation ? (
            <Text className="text-xs text-foreground-muted">
              Update the server to use setup recovery.
            </Text>
          ) : preparation.state === "failed" && preparation.settled ? (
            <View className="flex-row flex-wrap gap-2">
              {preparation.recipe !== null ? (
                <QueueButton
                  label="Retry setup and resume"
                  disabled={disabled || queue.handoff !== null}
                  onPress={() =>
                    void run(() =>
                      retryPreparation(
                        request({
                          threadId,
                          expectedRevision: preparation.revision,
                          expectedControlRevision: queue.revision,
                        }),
                      ),
                    )
                  }
                />
              ) : (
                <Text className="text-xs text-foreground-muted">
                  The original setup details are unavailable. Review this workspace before
                  continuing locally.
                </Text>
              )}
              {!hasStartedTurn ? (
                <QueueButton
                  label="Work locally"
                  disabled={disabled || queue.handoff !== null}
                  onPress={() =>
                    void run(() =>
                      retryPreparation(
                        request({
                          threadId,
                          expectedRevision: preparation.revision,
                          expectedControlRevision: queue.revision,
                          target: "project",
                        }),
                      ),
                    )
                  }
                />
              ) : null}
            </View>
          ) : preparation.state === "failed" ? (
            <Text className="text-xs text-foreground-muted">
              Waiting for setup to stop before retrying.
            </Text>
          ) : (
            <Text className="text-xs text-foreground-muted">
              Stop setup first to switch to the project checkout.
            </Text>
          )}
        </View>
      ) : null}
      <Text accessibilityLiveRegion="polite" className="mb-2 text-xs text-foreground-muted">
        {queue.pauseReason
          ? `Paused: ${queue.pauseReason.detail}`
          : "Prompts wait for the current turn to finish."}
      </Text>
      {queue.pauseReason?.code === "delivery-unknown" ? (
        <View className="mb-2 flex-row gap-2">
          {(["retry", "dismiss"] as const).map((resolution) => (
            <QueueButton
              key={resolution}
              label={resolution === "retry" ? "Retry delivery" : "Dismiss delivery"}
              disabled={disabled}
              onPress={() =>
                Alert.alert(
                  "Delivery outcome unknown",
                  resolution === "retry"
                    ? "The provider may already have received this prompt. Retrying can duplicate work."
                    : "Removing this delivery does not undo work already started by the provider.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: resolution === "retry" ? "Retry" : "Dismiss",
                      onPress: () =>
                        void run(() =>
                          resolveQueue(
                            request({ threadId, expectedRevision: queue.revision, resolution }),
                          ),
                        ),
                    },
                  ],
                )
              }
            />
          ))}
        </View>
      ) : null}
      {queue.entries.map((entry, index) => (
        <View key={entry.messageId} className="mb-2 gap-1 rounded-lg border border-border p-2">
          <Text className="text-sm text-foreground">
            {index + 1}. {entry.text || "Attachments"}
          </Text>
          {entry.attachments.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Files: {entry.attachments.map((attachment) => attachment.name).join(", ")}
            </Text>
          ) : null}
          <Text className="text-xs text-foreground-muted">{promptAttributionLabel(entry)}</Text>
          {entry.state === "pending" ? (
            <View className="mt-1 flex-row flex-wrap gap-2">
              <QueueButton
                label="Edit"
                disabled={disabled}
                onPress={() => {
                  setEdit({
                    messageId: entry.messageId,
                    revision: entry.revision,
                    text: entry.text,
                  });
                  setError(null);
                }}
              />
              <QueueButton
                label="Steer now"
                disabled={disabled || activeTurnId === null}
                onPress={() => {
                  if (activeTurnId)
                    void run(() =>
                      steerPrompt(
                        request({
                          threadId,
                          messageId: entry.messageId,
                          expectedRevision: entry.revision,
                          expectedTurnId: activeTurnId,
                        }),
                      ),
                    );
                }}
              />
              <QueueButton
                label="Remove"
                disabled={disabled}
                onPress={() =>
                  void run(() =>
                    removePrompt(
                      request({
                        threadId,
                        messageId: entry.messageId,
                        expectedRevision: entry.revision,
                      }),
                    ),
                  )
                }
              />
            </View>
          ) : (
            <Text className="text-xs text-foreground-muted">
              {entry.state === "unknown" ? "Delivery outcome unknown" : "Sending to agent…"}
            </Text>
          )}
        </View>
      ))}
      {edit ? (
        <View className="mb-3 gap-2">
          <TextInput
            accessibilityLabel="Edit queued prompt"
            multiline
            value={edit.text}
            onChangeText={(text) => setEdit({ ...edit, text })}
            className="min-h-20 rounded-lg border border-neutral-300 p-2 text-foreground"
          />
          {conflict ? (
            <Text accessibilityRole="alert" className="text-xs text-foreground-secondary">
              {conflict}
            </Text>
          ) : null}
          {current && current.revision !== edit.revision ? (
            <View className="gap-2">
              <Text className="text-xs text-foreground-secondary">
                Current prompt: {current.text}
              </Text>
              <QueueButton
                label="Keep my draft against this version"
                disabled={disabled || current.state !== "pending"}
                onPress={() => setEdit({ ...edit, revision: current.revision })}
              />
            </View>
          ) : null}
          <View className="flex-row gap-2">
            <QueueButton
              label="Save edit"
              disabled={disabled || conflict !== null}
              onPress={() => {
                if (current)
                  void run(
                    () =>
                      editPrompt(
                        request({
                          threadId,
                          messageId: edit.messageId,
                          expectedRevision: edit.revision,
                          expectedRuntimeMode: current.runtimeMode,
                          message: {
                            text: edit.text,
                            attachments: current.attachments,
                            ...(current.context ? { context: current.context } : {}),
                          },
                        }),
                      ),
                    () => setEdit(null),
                  );
              }}
            />
            <QueueButton label="Cancel edit" disabled={busy} onPress={() => setEdit(null)} />
          </View>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="mb-2 text-xs text-foreground-secondary">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}
