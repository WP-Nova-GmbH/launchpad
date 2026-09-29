import { setDesktopLocalAccount } from "../environments/primary/desktopAuth";
import { toastManager } from "../components/ui/toast";
import { useAuth } from "@clerk/react";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
import { setSharedPromptSubmissionAccount } from "../sharedPromptSubmissionStore";

export function deactivateManagedRelayAuthentication(): void {
  setSharedPromptSubmissionAccount(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  setSharedPromptSubmissionAccount(accountId);
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);
  const localIdentityWarningRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    const id = isSignedIn && userId ? userId : null;
    setDesktopLocalAccount(
      id === null
        ? null
        : {
            id,
            readToken: () => getToken(resolveRelayClerkTokenOptions()),
          },
      () => {
        if (localIdentityWarningRef.current === id) return;
        localIdentityWarningRef.current = id;
        toastManager.add({
          type: "warning",
          title: "Message names are unavailable",
          description:
            "Launchpad Connect could not verify your account. Local messages will remain anonymous until verification succeeds.",
        });
      },
    );
  }, [getToken, isLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    const queueAccountCleanup = () => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const results = await Promise.all([
          removeRelayEnvironments(),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache),
              ),
            ),
          ),
        ]);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      deactivateManagedRelayAuthentication();
      if (previousAccount !== null) {
        void queueAccountCleanup();
      }
    } else {
      const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, tokenProvider);
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      if (previousAccount !== undefined && previousAccount !== null && previousAccount !== userId) {
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup());
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  useEffect(() => () => deactivateManagedRelayAuthentication(), []);

  return children;
}
