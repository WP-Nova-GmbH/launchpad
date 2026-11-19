import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
  ThreadRelayRouting,
} from "@t3tools/contracts";
import type { RelayPortableThreadPlacement } from "@t3tools/contracts/relay";
import type { DraftId } from "./composerDraftStore";

interface ThreadMoveHandoff extends ScopedThreadRef {
  readonly accountId: string;
  readonly relayUrl: string;
  readonly generation: number;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    threadMoveHandoff?: ThreadMoveHandoff;
  }
}

export function isCurrentThreadMoveHandoff(
  handoff: ThreadMoveHandoff,
  target: ScopedThreadRef,
  accountId: string,
  relayUrl: string | null,
  placement: RelayPortableThreadPlacement | undefined,
): boolean {
  return (
    handoff.accountId === accountId &&
    handoff.relayUrl === relayUrl &&
    handoff.threadId === target.threadId &&
    handoff.environmentId === target.environmentId &&
    placement?.threadId === handoff.threadId &&
    placement.environmentId === handoff.environmentId &&
    placement.generation === handoff.generation &&
    placement.operationId === null
  );
}

export function threadMoveHandoffPhase(input: {
  readonly handoff: ThreadMoveHandoff;
  readonly connection: EnvironmentConnectionPhase | undefined;
  readonly liveRouting: ThreadRelayRouting | undefined;
  readonly liveArchivedThread: boolean;
  readonly deleted: boolean;
  readonly readFailed: boolean;
}) {
  if (input.deleted) return "unavailable";
  if (input.connection === "error" || input.connection === "unsupported") return "blocked";
  if (
    input.connection === "connected" &&
    (input.liveArchivedThread ||
      (input.liveRouting?.phase === "active" &&
        input.liveRouting.generation === input.handoff.generation))
  )
    return "opened";
  if (input.connection === "connected" && input.readFailed) return "unreadable";
  return "opening";
}

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadShellExists: boolean;
  serverThreadDetailExists: boolean;
  serverThreadDetailDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.serverThreadDetailExists || input.draftThreadExists) {
    return "ready";
  }
  if (input.serverThreadDetailDeleted) {
    return "missing";
  }
  return input.serverThreadShellExists ? "loading" : "missing";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

/**
 * Resolves the thread represented by either a canonical thread route or a
 * draft route whose promotion to a server thread has been recorded.
 */
export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}
