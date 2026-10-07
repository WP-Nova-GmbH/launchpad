import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { fetchSessionState } from "./auth";
import { authEnvironment } from "../../state/auth";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

const primarySessionStateAtom = Atom.make(
  Effect.suspend(() =>
    isLocalEnvironmentDisabled() ? Effect.succeed(null) : Effect.promise(fetchSessionState),
  ),
).pipe(
  Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
  Atom.setIdleTTL(5 * 60_000),
  Atom.withLabel("primary-environment:session"),
);

function refreshPrimarySessionState(): void {
  appAtomRegistry.refresh(primarySessionStateAtom);
}

export function usePrimarySessionState() {
  const result = useAtomValue(primarySessionStateAtom);
  const environmentId = usePrimaryEnvironmentId();
  const live = useEnvironmentQuery(
    environmentId === null ? null : authEnvironment.currentSession({ environmentId, input: null }),
  );
  let data = Option.getOrNull(AsyncResult.value(result));
  if (data?.authenticated && live.isSuccess) {
    const { currentSession: _currentSession, ...state } = data;
    data =
      live.data === null
        ? { ...state, authenticated: false }
        : { ...state, currentSession: live.data };
  }
  const refresh = useCallback(() => {
    refreshPrimarySessionState();
  }, []);
  let error: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not read environment session.";
  }
  return {
    data,
    error,
    isPending: result.waiting,
    refresh,
  };
}
