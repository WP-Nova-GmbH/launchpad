import { useAuth } from "@clerk/react";
import { CodexVmSignIn, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { runtime } from "../lib/runtime";
import { ensureLocalApi } from "../localApi";
import { usePrimaryEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

/** A selected SSH/relay/local-WSL backend cannot put a callback on the browser's computer. */
export function canUseLocalCodexVmSignIn(input: {
  readonly target: ConnectionTarget | null;
  readonly source: string | null;
  readonly windowOrigin: string;
  readonly desktop: boolean;
  readonly primaryRunningDistro: string | null;
}): boolean {
  if (input.target?._tag !== "PrimaryConnectionTarget" || input.primaryRunningDistro) return false;
  try {
    const http = new URL(input.target.httpBaseUrl),
      ws = new URL(input.target.wsBaseUrl);
    const loopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!loopback(http) || !loopback(ws)) return false;
    if (input.desktop) return input.source === "desktop-managed";
    return loopback(new URL(input.windowOrigin));
  } catch {
    return false;
  }
}

const command = <A, E>(run: () => Promise<AtomCommandResult<A, E>>, waitForCallback = false) => {
  const effect = Effect.tryPromise({
    try: async () => {
      const result = await run();
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
    catch: CodexVmSignIn.codexVmSignInFailure,
  });
  return waitForCallback
    ? effect
    : effect.pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(new CodexVmSignIn.CodexVmSignInClientError({ reason: "unavailable" })),
        }),
      );
};
type Tenancy = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];

/** Organization-scoped metadata and one temporary sign-in flow; renewable credentials never enter the client. */
export function useCodexVmConnection(organizationId: string) {
  const { getToken, userId, isSignedIn } = useAuth();
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const identity = useRef({ userId, organizationId, environmentId });
  useLayoutEffect(() => {
    identity.current = { userId, organizationId, environmentId };
  }, [userId, organizationId, environmentId]);
  const capability = useAtomCommand(serverEnvironment.codexVmSignInCapability, {
    reportFailure: false,
  });
  const startBridge = useAtomCommand(serverEnvironment.startCodexVmSignIn, {
    reportFailure: false,
  });
  const waitBridge = useAtomCommand(serverEnvironment.waitForCodexVmSignIn, {
    reportFailure: false,
  });
  const cancelBridge = useAtomCommand(serverEnvironment.cancelCodexVmSignIn, {
    reportFailure: false,
  });
  const target = primary?.entry.target ?? null;
  const controller = useMemo(() => {
    const sameContext = () =>
      identity.current.userId === userId &&
      identity.current.organizationId === organizationId &&
      identity.current.environmentId === environmentId;
    const relay = <A, E>(run: (client: Tenancy, clerkToken: string) => Effect.Effect<A, E>) =>
      Effect.tryPromise({
        try: async (signal) => {
          const token = await getToken({ ...resolveRelayClerkTokenOptions(), skipCache: true });
          if (!isSignedIn || !token || !sameContext() || signal.aborted)
            throw new CodexVmSignIn.CodexVmSignInClientError({ reason: "signed_out" });
          const result = await runtime.runPromiseExit(
            ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
              Effect.flatMap((client) =>
                Effect.gen(function* () {
                  yield* CodexVmSignIn.requireCodexVmOrganization(
                    client.getOrganization({ clerkToken: token }),
                    { userId, organizationId, current: sameContext },
                  );
                  return yield* run(client, token);
                }),
              ),
              Effect.withTracerEnabled(false),
            ),
            { signal },
          );
          if (Exit.isFailure(result)) throw Cause.squash(result.cause);
          return result.value;
        },
        catch: CodexVmSignIn.codexVmSignInFailure,
      }).pipe(
        Effect.timeoutOrElse({
          duration: "35 seconds",
          orElse: () =>
            Effect.fail(new CodexVmSignIn.CodexVmSignInClientError({ reason: "unavailable" })),
        }),
      );
    const local = () => {
      let source: string | null = null;
      try {
        source = readPrimaryEnvironmentTarget()?.source ?? null;
      } catch {
        return false;
      }
      const desktop = window.desktopBridge;
      let primaryRunningDistro: string | null = null;
      if (desktop) {
        try {
          const bootstrap = desktop
            .getLocalEnvironmentBootstraps()
            .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
          if (!bootstrap) return false;
          primaryRunningDistro = bootstrap.runningDistro ?? null;
        } catch {
          return false;
        }
      }
      return (
        sameContext() &&
        canUseLocalCodexVmSignIn({
          target,
          source,
          windowOrigin: window.location.origin,
          desktop: Boolean(desktop),
          primaryRunningDistro,
        })
      );
    };
    const unavailable = () => new CodexVmSignIn.CodexVmSignInClientError({ reason: "unavailable" });
    // These Effect callbacks execute after render, when a command runs.
    // oxlint-disable react/refs
    const checkLocal = Effect.suspend(() =>
      environmentId && local() ? Effect.void : Effect.fail(unavailable()),
    );
    return CodexVmSignIn.makeCodexVmSignInController({
      capability: Effect.suspend(() =>
        environmentId && local()
          ? command(() => capability({ environmentId, input: {} })).pipe(
              Effect.map((result) => result.supported),
            )
          : Effect.succeed(false),
      ),
      startBridge: checkLocal.pipe(
        Effect.andThen(command(() => startBridge({ environmentId: environmentId!, input: {} }))),
      ),
      waitBridge: (bridgeId) =>
        command(() => waitBridge({ environmentId: environmentId!, input: { bridgeId } }), true),
      cancelBridge: (bridgeId) =>
        command(() => cancelBridge({ environmentId: environmentId!, input: { bridgeId } })),
      readConnection: relay((client, clerkToken) => client.getCodexVmConnection({ clerkToken })),
      startAttempt: (payload) =>
        relay((client, clerkToken) => client.startCodexVmSignIn({ clerkToken, payload })),
      completeAttempt: (payload) =>
        relay((client, clerkToken) => client.completeCodexVmSignIn({ clerkToken, payload })),
      readAttempt: (attemptId) =>
        relay((client, clerkToken) => client.getCodexVmSignInAttempt({ clerkToken, attemptId })),
      cancelAttempt: (attemptId) =>
        relay((client, clerkToken) => client.cancelCodexVmSignIn({ clerkToken, attemptId })),
      disconnect: relay((client, clerkToken) => client.disconnectCodexVmConnection({ clerkToken })),
      openAuthorization: (url) =>
        checkLocal.pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => ensureLocalApi().shell.openExternal(url),
              catch: () =>
                new CodexVmSignIn.CodexVmSignInClientError({ reason: "browser_unavailable" }),
            }).pipe(
              Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () =>
                  Effect.fail(
                    new CodexVmSignIn.CodexVmSignInClientError({ reason: "browser_unavailable" }),
                  ),
              }),
            ),
          ),
        ),
    });
    // oxlint-enable react/refs
  }, [
    organizationId,
    userId,
    isSignedIn,
    getToken,
    environmentId,
    target,
    capability,
    startBridge,
    waitBridge,
    cancelBridge,
  ]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    controller.activate();
    void runtime.runPromise(controller.refresh);
    const focus = () => void runtime.runPromise(controller.refresh);
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
      void runtime.runPromise(controller.dispose);
    };
  }, [controller]);
  return {
    ...snapshot,
    refresh: () => runtime.runPromise(controller.refresh),
    connect: () => runtime.runPromise(controller.connect),
    reconnect: () => runtime.runPromise(controller.reconnect),
    replace: () => runtime.runPromise(controller.replace),
    retry: () => runtime.runPromise(controller.retry),
    cancel: () => runtime.runPromise(controller.cancel),
    disconnect: () => runtime.runPromise(controller.disconnect),
    dismissPlanConfirmation: controller.dismissPlanConfirmation,
  };
}
