import { useAuth } from "@clerk/react";
import type { WorkflowSourceError } from "@t3tools/contracts/relay";
import type { ManagedRelay } from "@t3tools/client-runtime/relay";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { runtime } from "../lib/runtime";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type Operation<A> = (
  client: WorkflowSources.Client,
  token: string,
) => Effect.Effect<A, WorkflowSourceError | ManagedRelay.ManagedRelayClientError>;
/** Mount under an account/repository key; reads and writes share one response owner. */
export function useWorkflowSources<T>(accountId: string, read: Operation<T>) {
  const { getToken, userId } = useAuth();
  const identity = useRef(userId);
  useLayoutEffect(() => {
    identity.current = userId;
  }, [userId]);
  const readAbort = useRef<AbortController | null>(null);
  const live = useRef(true),
    version = useRef(0),
    writing = useRef(false),
    uncertain = useRef(false);
  const [snapshot, setSnapshot] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [unverified, setUnverified] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      version.current++;
      readAbort.current?.abort();
    };
  }, []);
  const call = useCallback(
    async <A>(operation: Operation<A>, signal?: AbortSignal) => {
      const token = await getToken(resolveRelayClerkTokenOptions());
      if (!token || !live.current || identity.current !== accountId)
        throw new Error("Sign in to Launchpad Connect first.");
      const result = await runtime.runPromiseExit(
        WorkflowSources.client.pipe(Effect.flatMap((c) => operation(c, token))),
        signal ? { signal } : {},
      );
      if (Exit.isFailure(result)) throw Cause.squash(result.cause);
      return result.value;
    },
    [getToken, accountId],
  );
  const load = useCallback(async () => {
    const request = ++version.current;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setLoading(true);
    try {
      const result = await call(read, controller.signal);
      if (live.current && identity.current === accountId && request === version.current) {
        setSnapshot(result);
        setError(null);
        uncertain.current = false;
        setUnverified(false);
        return result;
      }
      return null;
    } catch (cause) {
      if (live.current && identity.current === accountId && request === version.current) {
        if (WorkflowSources.accessRejected(cause)) setSnapshot(null);
        setError(cause instanceof Error ? cause.message : "Could not load workflow sources.");
      }
      return null;
    } finally {
      if (live.current && request === version.current) setLoading(false);
    }
  }, [call, read, accountId]);
  const refresh = useCallback(async () => {
    if (!writing.current) await load();
  }, [load]);
  useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      version.current++;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  const mutate = async <A>(operation: Operation<A>) => {
    if (writing.current || uncertain.current) return null;
    writing.current = true;
    setBusy(true);
    setError(null);
    ++version.current;
    try {
      const result = await call(operation);
      if (!live.current || identity.current !== accountId) return null;
      uncertain.current = true;
      setUnverified(true);
      const verified = await load();
      if (!live.current || identity.current !== accountId) return null;
      if (verified === null) {
        uncertain.current = true;
        setUnverified(true);
        setError((previous) => previous ?? "Refresh to verify this change.");
        return null;
      }
      return { result, snapshot: verified };
    } catch (cause) {
      if (live.current && identity.current === accountId) {
        uncertain.current = true;
        setUnverified(true);
        if (WorkflowSources.accessRejected(cause)) setSnapshot(null);
        await load();
        if (live.current)
          setError(cause instanceof Error ? cause.message : "Refresh to verify this change.");
      }
      return null;
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  };
  return { snapshot, error, busy, loading, unverified, refresh, mutate };
}
