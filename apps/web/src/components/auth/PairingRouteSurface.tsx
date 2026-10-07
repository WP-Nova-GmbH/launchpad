import type { AuthSessionState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { ClientNameField, useClientName, rememberClientLabel } from "./ClientNameField";
import { peekPendingPairingCredential } from "../../environments/primary/auth";
import { APP_DISPLAY_NAME } from "../../branding";
import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Pairing with this environment"
        description="Validating the pairing link and preparing your session."
      />
    </StandalonePage>
  );
}

export function PairingRouteSurface({
  auth,
  labelOnly = false,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  labelOnly?: boolean;
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const [credential, setCredential] = useState(
    () => peekPendingPairingCredential() ?? peekPairingTokenFromUrl() ?? "",
  );
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [clientName, setClientName] = useClientName();
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential, clientName).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      submittingRef.current = false;
      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      rememberClientLabel(clientName);
      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated, clientName],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={labelOnly ? "Name this client" : "Pair with this environment"}
        description={
          labelOnly ? "Choose a name for this connection." : describeAuthGate(auth.bootstrapMethods)
        }
      />

      <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <ClientNameField value={clientName} onChange={setClientName} disabled={isSubmitting} />
        {!labelOnly ? (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="pairing-token">
              Pairing token
            </label>
            <Input
              id="pairing-token"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setCredential(event.currentTarget.value)}
              placeholder="Paste a one-time token or pairing secret"
              spellCheck={false}
              value={credential}
            />
          </div>
        ) : null}

        {errorMessage ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? "Connecting…" : "Connect"}
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            Reload app
          </Button>
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods)}
      </div>
    </StandalonePage>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const [hostedPairingRequest] = useState(readHostedPairingRequest);
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequest ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    hostedPairingRequest
      ? "Choose a client name, then connect to this backend."
      : "This pairing link is missing its backend host or token.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const [clientName, setClientName] = useClientName();
  const [confirmed, setConfirmed] = useState(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequest;

    if (!request) {
      setStatus("error");
      setMessage("This pairing link is missing its backend host or token.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) return;

    setStatus("pairing");
    setMessage("Connecting to this backend.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
      clientLabel: clientName,
    });
    if (result._tag === "Success") {
      rememberClientLabel(clientName);
      setStatus("paired");
      setMessage(`${request.label || "The environment"} is saved in this browser.`);
      return;
    }

    tokenSubmittedRef.current = false;
    setConfirmed(false);
    setStatus("error");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the backend accepted this one-time token, request a new pairing link before retrying.`,
    );
  }, [connectPairingEnvironment, clientName, hostedPairingRequest]);

  useEffect(() => {
    stripPairingTokenFromUrl();
  }, []);

  const request = hostedPairingRequest;

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={
          !confirmed && request
            ? "Pair with this environment"
            : status === "paired"
              ? "Backend paired"
              : status === "error"
                ? "Pairing failed"
                : "Pairing backend"
        }
        description={message}
      />

      {request && !confirmed ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setConfirmed(true);
            void submitHostedPairingRequest();
          }}
        >
          <ClientNameField value={clientName} onChange={setClientName} />
          <Button type="submit" disabled={!clientName.trim()}>
            Connect
          </Button>
        </form>
      ) : null}
      {request && confirmed ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          Host: <span className="font-mono text-foreground/80">{request.host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
          Verify the backend is reachable from this browser, supports CORS for hosted clients, and
          is served over HTTPS when opening this page from HTTPS.
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "pairing" && confirmed ? (
          <Button disabled size="sm">
            Pairing...
          </Button>
        ) : canRetry && confirmed ? (
          <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
            Try again
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button size="sm" variant="outline" onClick={() => (window.location.href = "/")}>
            Open app
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "Enter a pairing token to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
