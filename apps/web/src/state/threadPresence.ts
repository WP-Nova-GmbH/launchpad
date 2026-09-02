import { useAtomValue } from "@effect/atom-react";
import {
  createThreadPresenceAtoms,
  THREAD_PRESENCE_HEARTBEAT_MS,
  THREAD_TYPING_IDLE_MS,
  THREAD_TYPING_RENEW_INTERVAL_MS,
  type ThreadPresencePerson,
} from "@t3tools/client-runtime/state/threadPresence";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const threadPresence = createThreadPresenceAtoms(connectionAtomRuntime);

const EMPTY_PEOPLE_ATOM = Atom.make<ReadonlyArray<ThreadPresencePerson>>([]).pipe(
  Atom.withLabel("web-thread-presence:empty"),
);

export function useThreadPresencePeople(
  ref: ScopedThreadRef | null,
): ReadonlyArray<ThreadPresencePerson> {
  return useAtomValue(ref === null ? EMPTY_PEOPLE_ATOM : threadPresence.peopleAtom(ref));
}

/**
 * Announces which thread this client is looking at and whether it is typing.
 * Typing is derived from prompt edits: it starts on the first edit, renews
 * while edits keep coming, and ends after a pause, on an empty prompt, or
 * when the thread changes. Failures are ignored; presence is best effort.
 */
export function useThreadPresenceReporter(ref: ScopedThreadRef | null, prompt: string): void {
  const report = useAtomCommand(threadPresence.report, {
    reportFailure: false,
    reportDefect: false,
  });
  const typingRef = useRef(false);
  const lastRenewAtRef = useRef(0);
  const idleTimerRef = useRef<number | null>(null);
  const lastPromptRef = useRef(prompt);

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
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (ref === null) return;
    lastPromptRef.current = prompt;
    typingRef.current = false;
    send(ref, false);
    const heartbeat = window.setInterval(
      () => send(ref, typingRef.current),
      THREAD_PRESENCE_HEARTBEAT_MS,
    );
    return () => {
      window.clearInterval(heartbeat);
      clearIdleTimer();
      typingRef.current = false;
      void report({ environmentId: ref.environmentId, input: { threadId: null, typing: false } });
    };
    // The prompt is captured for the reset only; edits are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, send, report, clearIdleTimer]);

  useEffect(() => {
    if (ref === null || prompt === lastPromptRef.current) return;
    lastPromptRef.current = prompt;
    if (prompt.trim().length === 0) {
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
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (typingRef.current) send(ref, false);
    }, THREAD_TYPING_IDLE_MS);
  }, [prompt, ref, send, clearIdleTimer]);
}
