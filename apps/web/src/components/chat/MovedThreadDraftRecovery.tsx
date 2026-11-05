import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  portableThreadPlacementsAtom,
  isPortableThreadSourceLocation,
} from "@t3tools/client-runtime/relay/portableThreadPresentation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { useState } from "react";
import {
  composerDraftHasUserContent,
  handoffMovedThreadDraft,
  useComposerDraftStore,
  type MovedThreadDraftConflict,
} from "../../composerDraftStore";
import { recoverMovedDraftFile } from "../../lib/movedThreadDraft";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells } from "../../state/threads";
import { threadMoveRelayUrl } from "../../state/thread-move-submissions";
import { Button } from "../ui/button";

/** An unselected draft stays reachable after navigation collapses the old thread row. */
export function MovedThreadDraftRecovery({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const session = useAtomValue(managedRelaySessionAtom);
  const proofs = useAtomValue(portableThreadPlacementsAtom);
  const drafts = useComposerDraftStore((state) => state.draftsByThreadKey);
  const [conflict, setConflict] = useState<{
    source: { environmentId: EnvironmentId; threadId: ThreadId };
    conflict: MovedThreadDraftConflict;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
            !composerDraftHasUserContent(draft)
          )
            return [];
          const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
          return shell &&
            isPortableThreadSourceLocation(shell, placement, relayUrl ?? "") &&
            (shell.relayRouting?.generation ?? Infinity) < placement.generation
            ? [{ ref, draft }]
            : [];
        })
      : [];
  if (!session || !placement || retained.length === 0) return null;
  const useDraft = async (
    source: { environmentId: EnvironmentId; threadId: ThreadId },
    choice?: { use: "source" | "destination"; conflict: MovedThreadDraftConflict },
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await handoffMovedThreadDraft({
        source,
        destination: { environmentId, threadId },
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
        recoverFile: recoverMovedDraftFile,
        ...(choice ? { choice } : {}),
      });
      setConflict(result.conflict ? { source, conflict: result.conflict } : null);
    } catch (cause) {
      setConflict(null);
      setError(cause instanceof Error ? cause.message : "Could not recover the saved draft.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="border-b border-border px-3 py-2 text-xs">
      <p>An unsent draft is saved at a previous location.</p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {conflict ? (
        <div className="space-y-2 py-2">
          <p>Choose a draft. Both stay saved.</p>
          {(["source", "destination"] as const).map((use) => (
            <div key={use} className="rounded-md border border-border p-2">
              <p className="line-clamp-3 whitespace-pre-wrap">
                {conflict.conflict[use].prompt || "Attachments and context"}
              </p>
              <Button
                size="xs"
                variant="secondary"
                disabled={busy}
                onClick={() => void useDraft(conflict.source, { use, conflict: conflict.conflict })}
              >
                {use === "source" ? "Use saved draft" : "Keep current draft"}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        retained.map(({ ref }) => (
          <Button
            key={ref.environmentId}
            size="xs"
            variant="secondary"
            disabled={busy}
            onClick={() => void useDraft(ref)}
          >
            Review saved draft
          </Button>
        ))
      )}
    </section>
  );
}
