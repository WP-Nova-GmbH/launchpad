"use client";

import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderIcon, LogInIcon, LogOutIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  extractProviderAccountAuthUrls,
  hasProviderAccountSession,
} from "./ProviderAccountAuthActions.logic";

export function ProviderAccountAuthActions({
  environmentId,
  environmentLabel,
  instanceId,
  providerName,
  driver,
  liveProvider,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly providerName: string;
  readonly driver: ProviderDriverKind;
  readonly liveProvider: ServerProvider | undefined;
}) {
  const authState = useAtomValue(
    serverEnvironment.providerAccountAuthStateAtom(environmentId, instanceId),
  );
  const authenticateProvider = useAtomCommand(serverEnvironment.authenticateProvider, {
    reportFailure: false,
  });
  const logoutProvider = useAtomCommand(serverEnvironment.logoutProvider, {
    reportFailure: false,
  });
  const [isLoginDialogOpen, setIsLoginDialogOpen] = useState(false);
  const [isLogoutDialogOpen, setIsLogoutDialogOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const isAccountAuthenticated =
    liveProvider !== undefined && hasProviderAccountSession(driver, liveProvider.auth);
  const loginUrls = useMemo(
    () => ("output" in authState ? extractProviderAccountAuthUrls(driver, authState.output) : []),
    [authState, driver],
  );

  const startLogin = useCallback(() => {
    setIsLoginDialogOpen(true);
    void authenticateProvider({ environmentId, input: { instanceId } });
  }, [authenticateProvider, environmentId, instanceId]);

  const logout = useCallback(() => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    void (async () => {
      const result = await logoutProvider({ environmentId, input: { instanceId } });
      setIsLoggingOut(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not sign out of ${providerName}`,
            description: error instanceof Error ? error.message : "The logout command failed.",
          }),
        );
        return;
      }
      setIsLogoutDialogOpen(false);
      toastManager.add({
        type: "success",
        title: `Signed out of ${providerName}`,
        description: `The account session was removed from ${environmentLabel}.`,
      });
    })();
  }, [environmentId, environmentLabel, instanceId, isLoggingOut, logoutProvider, providerName]);

  const output = "output" in authState ? authState.output : "";

  return (
    <>
      {isAccountAuthenticated ? (
        <Button size="compact" variant="ghost-muted" onClick={() => setIsLogoutDialogOpen(true)}>
          <LogOutIcon />
          Sign out
        </Button>
      ) : (
        <Button
          size="compact"
          variant="outline"
          disabled={!liveProvider?.installed || authState.status === "running"}
          onClick={startLogin}
        >
          {authState.status === "running" ? <LoaderIcon className="animate-spin" /> : <LogInIcon />}
          {liveProvider?.auth.status === "authenticated" ? "Use account login" : "Sign in"}
        </Button>
      )}

      <Dialog open={isLoginDialogOpen} onOpenChange={setIsLoginDialogOpen}>
        <DialogPopup className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Sign in to {providerName}</DialogTitle>
            <DialogDescription>
              This runs the provider&apos;s own login command on {environmentLabel}. The resulting
              account session stays on that device and is not copied to other environments.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {authState.status === "running"
                ? "Waiting for you to finish in the provider's sign-in page."
                : authState.status === "succeeded"
                  ? "The provider confirmed the account session."
                  : authState.status === "failed"
                    ? authState.message
                    : "Start the account login to receive a sign-in link."}
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-foreground">
              {output || "Provider login output will appear here."}
            </pre>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsLoginDialogOpen(false)}>
              Close
            </Button>
            {authState.status === "failed" ? (
              <Button variant="outline" onClick={startLogin}>
                Try again
              </Button>
            ) : null}
            {loginUrls[0] ? (
              <Button onClick={() => window.open(loginUrls[0], "_blank", "noopener,noreferrer")}>
                <ExternalLinkIcon />
                Open sign-in page
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={isLogoutDialogOpen} onOpenChange={setIsLogoutDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of {providerName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the account session from {environmentLabel}. It does not sign out other
              T3 Code environments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={isLoggingOut} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={isLoggingOut} onClick={logout}>
              {isLoggingOut ? <LoaderIcon className="animate-spin" /> : <LogOutIcon />}
              {isLoggingOut ? "Signing out" : "Sign out"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
