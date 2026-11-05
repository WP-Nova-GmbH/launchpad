import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  portableThreadPlacementsAtom,
  isPortableThreadSourceLocation,
} from "@t3tools/client-runtime/relay/portableThreadPresentation";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import {
  composerDraftsAtom,
  handoffMovedThreadDraft,
  isComposerDraftEmpty,
  type MovedThreadDraftConflict,
} from "../../state/use-composer-drafts";
import { scopedThreadKey } from "../../lib/scopedEntities";

export function MovedThreadDraftRecovery({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const session = useAtomValue(managedRelaySessionAtom),
    proofs = useAtomValue(portableThreadPlacementsAtom),
    drafts = useAtomValue(composerDraftsAtom);
  const [conflict, setConflict] = useState<{
    sourceKey: string;
    conflict: MovedThreadDraftConflict;
  } | null>(null);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const relayUrl = normalizeSecureRelayUrl(threadMoveRelayUrl() ?? "");
  const placement =
    proofs?.session === session && proofs.relayUrl === relayUrl
      ? proofs.placements.get(threadId)
      : null;
  const retained =
    placement?.operationId === null && placement.environmentId === environmentId
      ? Object.entries(drafts).flatMap(([key, draft]) => {
          const ref = parseScopedThreadKey(key);
          if (
            !ref ||
            ref.threadId !== threadId ||
            ref.environmentId === environmentId ||
            isComposerDraftEmpty(draft)
          )
            return [];
          const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
          return shell &&
            isPortableThreadSourceLocation(shell, placement, relayUrl ?? "") &&
            (shell.relayRouting?.generation ?? Infinity) < placement.generation
            ? [key]
            : [];
        })
      : [];
  if (!session || !placement || !retained.length) return null;
  const useDraft = async (
    sourceKey: string,
    choice?: { use: "source" | "destination"; conflict: MovedThreadDraftConflict },
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await handoffMovedThreadDraft({
        sourceKey,
        destinationKey: scopedThreadKey(environmentId, threadId),
        stillCurrent: () => {
          const current = appAtomRegistry.get(portableThreadPlacementsAtom);
          const currentPlacement = current?.placements.get(threadId);
          return (
            appAtomRegistry.get(managedRelaySessionAtom) === session &&
            normalizeSecureRelayUrl(threadMoveRelayUrl() ?? "") === relayUrl &&
            current?.session === session &&
            current.relayUrl === relayUrl &&
            currentPlacement?.operationId === null &&
            currentPlacement.environmentId === placement.environmentId &&
            currentPlacement.generation === placement.generation
          );
        },
        ...(choice ? { choice } : {}),
      });
      setConflict(result.conflict ? { sourceKey, conflict: result.conflict } : null);
    } catch (cause) {
      setConflict(null);
      setError(cause instanceof Error ? cause.message : "Could not recover the saved draft.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2 px-3 py-2">
      <Text className="text-xs">An unsent draft is saved at a previous location.</Text>
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      {conflict ? (
        <View className="gap-2">
          <Text className="text-xs">Choose a draft. Both stay saved.</Text>
          {(["source", "destination"] as const).map((use) => (
            <Pressable
              key={use}
              disabled={busy}
              accessibilityRole="button"
              className="gap-1 rounded-lg border border-border p-3"
              onPress={() =>
                void useDraft(conflict.sourceKey, { use, conflict: conflict.conflict })
              }
            >
              <Text className="text-xs" numberOfLines={3}>
                {conflict.conflict[use].text || "Attachments and context"}
              </Text>
              <Text className="text-sm text-primary">
                {use === "source" ? "Use saved draft" : "Keep current draft"}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        retained.map((key) => (
          <Pressable
            key={key}
            disabled={busy}
            accessibilityRole="button"
            onPress={() => void useDraft(key)}
          >
            <Text className="text-sm text-primary">Review saved draft</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}
