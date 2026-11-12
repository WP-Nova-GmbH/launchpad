import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { portableThreadPlacementsAtom } from "@t3tools/client-runtime/relay/portableThreadPresentation";
import { canRecoverPrivateThreadLocation } from "@t3tools/client-runtime/relay/workflow-result";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import ChatView from "./ChatView";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import { WorkflowResultReturn } from "./workflows/WorkflowNavigation";
import { Button } from "./ui/button";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { CurrentThreadLocation } from "./chat/ThreadMoveControls";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  useEnvironmentThreadRefs,
  useThread,
  useThreadDetail,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import { threadMoveRelayUrl } from "../state/thread-move-submissions";
import { threadVmControls, useEnvironmentThread } from "../state/threads";
import {
  buildThreadRouteParams,
  isCurrentThreadMoveHandoff,
  resolveThreadRouteRenderState,
  threadMoveHandoffPhase,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";

/**
 * The single chat surface behind both `/draft/$draftId` and
 * `/$environmentId/$threadId`. Each draft gets its own ChatView instance (so
 * a background send's state stays with the draft it came from), and that
 * instance carries the draft through its promotion to a server thread: the
 * thread route keeps keying by the draft id while the draft record exists,
 * so the route swap only changes props and the timeline never paints an
 * empty frame. Plain server threads are unkeyed, so navigating between them
 * reuses one instance as ChatView expects.
 *
 * Rendered by the `_chat` layout rather than by the two leaf routes, since
 * an element only survives a route swap when the same parent renders it.
 */
export function ThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const handoff = useLocation({ select: (location) => location.state.threadMoveHandoff });
  const workflowOrigin = useLocation({ select: (location) => location.state.workflowOrigin });
  const environments = useEnvironments();
  const reconnect = useAtomCommand(environmentCatalog.retryNow);
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  // The server thread this view is about: the route's own ref, or the draft's
  // reserved ref once the server knows it.
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : (draftSession?.promotedTo ?? inferredThreadRef);
  const serverThread = useThread(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const shell = useEnvironmentQuery(
    serverThreadRef === null ? null : environmentShell.stateAtom(serverThreadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(serverThreadRef);
  const serverThreadDetail = useThreadDetail(serverThreadRef);
  const serverThreadStatus = useThreadStatus(serverThreadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environment = serverThreadRef
    ? environments.presentationById.get(serverThreadRef.environmentId)
    : undefined;
  const connection = environment?.connection;
  const privateLocationRecovery = canRecoverPrivateThreadLocation({
    capabilities: environment?.serverConfig?.environment.capabilities,
    origin: workflowOrigin,
    accountId: relaySession?.accountId,
    threadId: serverThreadRef?.threadId,
  });
  const relayUrl = handoff ? threadMoveRelayUrl() : null;
  const handoffCurrent = useAtomValue(
    portableThreadPlacementsAtom,
    useCallback(
      (proofs) =>
        !!handoff &&
        target.kind === "server" &&
        !!relaySession &&
        proofs?.session === relaySession &&
        proofs.relayUrl === relayUrl &&
        isCurrentThreadMoveHandoff(
          handoff,
          target.threadRef,
          relaySession.accountId,
          relayUrl,
          proofs.placements.get(target.threadRef.threadId),
        ),
      [handoff, target, relaySession, relayUrl],
    ),
  );
  const [openedHandoff, setOpenedHandoff] = useState<typeof handoff>(undefined);
  const openingHandoff = handoff && handoffCurrent && openedHandoff !== handoff ? handoff : null;
  const handoffThread = useEnvironmentThread(
    openingHandoff?.environmentId ?? null,
    openingHandoff?.threadId ?? null,
  );
  const handoffReadError = handoffThread.error._tag === "Some" ? handoffThread.error.value : null;
  const handoffPhase = openingHandoff
    ? threadMoveHandoffPhase({
        handoff: openingHandoff,
        connection: connection?.phase,
        liveRouting: shell.data?.status === "live" ? serverThreadShell?.relayRouting : undefined,
        liveArchivedThread:
          serverThreadShell === null &&
          handoffThread.status === "live" &&
          handoffThread.data._tag === "Some" &&
          handoffThread.data.value.archivedAt !== null,
        deleted: handoffThread.status === "deleted",
        readFailed: handoffReadError !== null,
      })
    : null;
  if (handoffPhase === "opened") setOpenedHandoff(handoff);
  const handoffOwnsNotice = handoffPhase !== null && handoffPhase !== "opened";
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const promotedDraftId = useComposerDraftStore((store) =>
    target.kind === "server" ? store.getDraftIdByRef(target.threadRef) : null,
  );
  // The draft record is removed once the promoted thread has started, which
  // is after the route swap. Latch the key so the element that carried the
  // draft keeps its identity for as long as this thread stays on screen.
  const [chatViewKey, setChatViewKey] = useState<{ threadKey: string; key: string } | null>(null);
  const serverThreadKey = target.kind === "server" ? scopedThreadKey(target.threadRef) : null;
  const nextChatViewKey =
    serverThreadKey === null
      ? null
      : chatViewKey?.threadKey === serverThreadKey
        ? chatViewKey
        : promotedDraftId
          ? { threadKey: serverThreadKey, key: promotedDraftId }
          : null;
  if (nextChatViewKey !== chatViewKey) {
    setChatViewKey(nextChatViewKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists: draftThread !== null,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;
  const recoverUnavailable =
    !handoffOwnsNotice &&
    target.kind === "server" &&
    relaySession !== null &&
    serverThreadShell === null &&
    ((environments.isReady && !environments.presentationById.has(target.threadRef.environmentId)) ||
      shell.error !== null ||
      renderState === "missing");

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete || handoffOwnsNotice) {
      return;
    }
    // Navigation already resolved onto this path, so a drop aimed here
    // passed its landing check; once the thread reads as missing it can
    // never be attached, release it even when there is nowhere to redirect.
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads && !recoverUnavailable) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [
    bootstrapComplete,
    environmentHasAnyThreads,
    handoffOwnsNotice,
    navigate,
    recoverUnavailable,
    renderState,
    target,
  ]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let view: React.ReactNode = null;
  if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      );
    }
  } else if (
    !handoffOwnsNotice &&
    (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null))
  ) {
    view = (
      <ChatView
        {...(nextChatViewKey ? { key: nextChatViewKey.key } : {})}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
        threadSyncPhase={threadSyncPhase}
      />
    );
  } else {
    const opening = handoffPhase === "opening";
    const unavailable = handoffPhase === "unavailable";
    const error =
      connection?.error ??
      handoffReadError ??
      shell.error ??
      (handoffOwnsNotice && shell.data?.error._tag === "Some" ? shell.data.error.value : null);
    view = (
      <div className="flex flex-1 items-center justify-center px-6">
        <div role="status" className="max-w-md space-y-3 text-center">
          <h2 className="text-sm font-medium">
            {opening
              ? "Opening thread…"
              : unavailable
                ? "Thread unavailable"
                : handoffPhase === "unreadable"
                  ? "Could not open this thread"
                  : error || handoffPhase === "blocked"
                    ? "Could not connect to this thread"
                    : "Loading thread…"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {opening
              ? "Connecting to the thread’s current location."
              : unavailable
                ? "The thread is unavailable at its current location."
                : (error ??
                  (connection
                    ? connectionStatusText(connection)
                    : "Connecting to its environment…"))}
          </p>
          {opening && error ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-1 break-words">{error}</p>
            </details>
          ) : null}
          {!unavailable &&
          connection &&
          (error ||
            connection.phase === "offline" ||
            connection.phase === "available" ||
            (opening && connection.phase === "reconnecting")) ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (openingHandoff && privateLocationRecovery)
                  appAtomRegistry.refresh(
                    threadVmControls.locationQueryAtom(
                      target.threadRef.environmentId,
                      target.threadRef.threadId,
                      true,
                    ),
                  );
                void reconnect(target.threadRef.environmentId);
              }}
            >
              Reconnect
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <WorkflowResultReturn />
      {target.kind === "server" && privateLocationRecovery ? (
        <CurrentThreadLocation
          key={scopedThreadKey(target.threadRef)}
          environmentId={target.threadRef.environmentId}
          threadId={target.threadRef.threadId}
          recoverUnavailable={recoverUnavailable || handoffOwnsNotice}
          observeOnly={handoffOwnsNotice}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{view}</div>
    </SidebarInset>
  );
}
