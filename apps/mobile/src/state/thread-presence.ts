import { useAtomValue } from "@effect/atom-react";
import {
  createThreadPresenceAtoms,
  THREAD_PRESENCE_HEARTBEAT_MS,
  THREAD_TYPING_IDLE_MS,
  THREAD_TYPING_RENEW_INTERVAL_MS,
  type ThreadPresencePerson,
} from "@t3tools/client-runtime/state/threadPresence";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const threadPresence = createThreadPresenceAtoms(connectionAtomRuntime);

const EMPTY_PEOPLE_ATOM = Atom.make<ReadonlyArray<ThreadPresencePerson>>([]).pipe(
  Atom.withLabel("mobile-thread-presence:empty"),
);

export function useThreadPresencePeople(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<ThreadPresencePerson> {
  const ref = useMemo(
    () => (environmentId !== null && threadId !== null ? { environmentId, threadId } : null),
    [environmentId, threadId],
  );
  return useAtomValue(ref === null ? EMPTY_PEOPLE_ATOM : threadPresence.peopleAtom(ref));
}

/**
 * Announces which thread this client is looking at and whether it is typing.
 * Mirrors the web reporter: typing starts on the first draft edit, renews
 * while edits keep coming, and ends after a pause, on an empty draft, or when
 * the thread changes. Best effort; failures are ignored.
 */
export function useThreadPresenceReporter(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  draft: string,
): void {
  const ref = useMemo<ScopedThreadRef | null>(
    () => (environmentId !== null && threadId !== null ? { environmentId, threadId } : null),
    [environmentId, threadId],
  );
  const report = useAtomCommand(threadPresence.report, {
    reportFailure: false,
    reportDefect: false,
  });
  const typingRef = useRef(false);
  const lastRenewAtRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDraftRef = useRef(draft);

  const send = useCallback(
    (target: ScopedThreadRef, typing: boolean) => {
      typingRef.current = typing;
      lastRenewAtRef.current = Date.now();
      void report({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, typing },
      });
    },
    [report],
  );

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (ref === null) return;
    lastDraftRef.current = draft;
    typingRef.current = false;
    send(ref, false);
    const heartbeat = setInterval(() => send(ref, typingRef.current), THREAD_PRESENCE_HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      clearIdleTimer();
      typingRef.current = false;
      void report({ environmentId: ref.environmentId, input: { threadId: null, typing: false } });
    };
    // The draft is captured for the reset only; edits are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, send, report, clearIdleTimer]);

  useEffect(() => {
    if (ref === null || draft === lastDraftRef.current) return;
    lastDraftRef.current = draft;
    if (draft.trim().length === 0) {
      clearIdleTimer();
      if (typingRef.current) send(ref, false);
      return;
    }
    if (
      !typingRef.current ||
      Date.now() - lastRenewAtRef.current >= THREAD_TYPING_RENEW_INTERVAL_MS
    ) {
      send(ref, true);
    }
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      if (typingRef.current) send(ref, false);
    }, THREAD_TYPING_IDLE_MS);
  }, [draft, ref, send, clearIdleTimer]);
}
