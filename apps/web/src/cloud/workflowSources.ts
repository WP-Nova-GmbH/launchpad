import { useAuth } from "@clerk/react";
import { WorkflowSourceError } from "@t3tools/contracts/relay";
import type { ManagedRelay } from "@t3tools/client-runtime/relay";
import { WorkflowSources } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { runtime } from "../lib/runtime";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

type Operation<A> = (
  client: WorkflowSources.Client,
  token: string,
) => Effect.Effect<A, WorkflowSourceError | ManagedRelay.ManagedRelayClientError>;
type SourceFailure = { message: string; code?: WorkflowSourceError["code"] | undefined };
type RefreshOptions = { preserveMutationError?: boolean };
const isSourceError = Schema.is(WorkflowSourceError);

/** Mount under the current account and resource key. */
export function useWorkflowSources<T>(
  accountId: string,
  read: Operation<T>,
  {
    mergeSnapshot,
    discardSnapshotOnError,
  }: {
    mergeSnapshot?: (previous: T | null, result: T) => T;
    discardSnapshotOnError?: (code: SourceFailure["code"]) => boolean;
  } = {},
) {
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
    [readFailure, setReadFailure] = useState<SourceFailure | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [readFailed, setReadFailed] = useState(false),
    [unverified, setUnverified] = useState(false);
  useLayoutEffect(() => {
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
  const load = useCallback(
    async (options?: RefreshOptions) => {
      const preserveMutationError = options?.preserveMutationError;
      const request = ++version.current;
      readAbort.current?.abort();
      const controller = new AbortController();
      readAbort.current = controller;
      setLoading(true);
      try {
        const result = await call(read, controller.signal);
        if (live.current && identity.current === accountId && request === version.current) {
          setSnapshot((previous) => (mergeSnapshot ? mergeSnapshot(previous, result) : result));
          setReadFailure(null);
          if (!preserveMutationError) setMutationError(null);
          setReadFailed(false);
          uncertain.current = false;
          setUnverified(false);
          return result;
        }
        return null;
      } catch (cause) {
        if (live.current && identity.current === accountId && request === version.current) {
          const code = isSourceError(cause) ? cause.code : undefined;
          if (WorkflowSources.accessRejected(cause) || discardSnapshotOnError?.(code))
            setSnapshot(null);
          setReadFailed(true);
          setReadFailure({
            code,
            message: cause instanceof Error ? cause.message : "Could not load workflow sources.",
          });
          if (!preserveMutationError) setMutationError(null);
        }
        return null;
      } finally {
        if (live.current && request === version.current) setLoading(false);
      }
    },
    [call, read, accountId, mergeSnapshot, discardSnapshotOnError],
  );
  const refresh = useCallback(
    async (options?: RefreshOptions) => {
      if (live.current && !writing.current) await load(options);
    },
    [load],
  );
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
    setReadFailure(null);
    setMutationError(null);
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
        setReadFailure((previous) => previous ?? { message: "Refresh to verify this change." });
        return null;
      }
      return { result, snapshot: verified };
    } catch (cause) {
      if (live.current && identity.current === accountId) {
        uncertain.current = true;
        setUnverified(true);
        if (WorkflowSources.accessRejected(cause)) setSnapshot(null);
        await load();
        if (live.current && identity.current === accountId) {
          setReadFailure(null);
          setMutationError(
            cause instanceof Error ? cause.message : "Refresh to verify this change.",
          );
        }
      }
      return null;
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  };
  return {
    snapshot,
    error: readFailure?.message ?? mutationError,
    errorCode: readFailure?.code,
    busy,
    loading,
    readFailed,
    unverified,
    refresh,
    mutate,
  };
}
