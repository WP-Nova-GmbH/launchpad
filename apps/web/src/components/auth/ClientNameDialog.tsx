import { useEffect, useRef, useState } from "react";
import type { AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { readConnectedClient, renameConnectedClient } from "../../connection/onboarding";
import { useEnvironments } from "../../state/environments";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { ClientNameField, rememberClientLabel, useClientName } from "./ClientNameField";

function ClientNameDialog({
  environmentId,
  environmentLabel,
  sessionId,
  initialLabel,
  onRenamed,
  onClose,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  sessionId?: AuthSessionId;
  initialLabel?: string;
  onRenamed?: () => void;
  onClose: () => void;
}) {
  const live = useEnvironmentQuery(authEnvironment.currentSession({ environmentId, input: null }));
  const [suggestion] = useClientName();
  const [name, setName] = useState(initialLabel ?? suggestion);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const edited = useRef(false);
  const latestLive = useRef(live.data);
  const storedLabel = useRef(initialLabel ?? null);
  const submitting = useRef(false);
  const read = useAtomCommand(readConnectedClient, { reportFailure: false });
  const rename = useAtomCommand(renameConnectedClient, { reportFailure: false });
  useEffect(() => {
    if (!edited.current && storedLabel.current === null) setName(suggestion);
  }, [suggestion]);
  useEffect(() => {
    // The authorized-client list supplies live names for sessions other than our own.
    if (!sessionId || sessionId === live.data?.sessionId || initialLabel === undefined) return;
    storedLabel.current = initialLabel;
    if (!edited.current) setName(initialLabel);
  }, [sessionId, initialLabel, live.data?.sessionId]);
  useEffect(() => {
    if (sessionId) return;
    let active = true;
    const liveAtRequest = latestLive.current;
    void read(environmentId).then((result) => {
      if (
        active &&
        latestLive.current === liveAtRequest &&
        result._tag === "Success" &&
        result.value.currentSession?.client.label
      ) {
        storedLabel.current = result.value.currentSession.client.label;
        if (!edited.current) setName(storedLabel.current);
      }
    });
    return () => {
      active = false;
    };
  }, [environmentId, sessionId, read]);
  useEffect(() => {
    if (sessionId && sessionId !== live.data?.sessionId) return;
    latestLive.current = live.data;
    const label = live.data?.client.label;
    if (label) {
      storedLabel.current = label;
      if (!edited.current) setName(label);
    }
  }, [sessionId, live.data]);
  const save = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    const result = await rename({
      environmentId,
      label: name,
      ...(sessionId ? { sessionId } : {}),
    });
    submitting.current = false;
    setSaving(false);
    if (result._tag === "Success") {
      if (result.value.current) rememberClientLabel(name);
      onRenamed?.();
      onClose();
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save the client name.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Name this client</DialogTitle>
          <DialogDescription>A client name on {environmentLabel}.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogPanel>
            <ClientNameField
              value={name}
              disabled={saving}
              onChange={(value) => {
                edited.current = true;
                setName(value);
              }}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={onClose} type="button">
              Cancel
            </Button>
            <Button disabled={saving || !name.trim()} type="submit">
              {saving ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
export function ClientNameButton({
  environmentId,
  environmentLabel,
  sessionId,
  initialLabel,
  onRenamed,
  buttonLabel,
  required = false,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  sessionId?: AuthSessionId;
  initialLabel?: string;
  onRenamed?: () => void;
  buttonLabel?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        {buttonLabel ?? (required ? "Name this client" : "Rename client")}
      </Button>
      {open ? (
        <ClientNameDialog
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          {...(sessionId ? { sessionId } : {})}
          {...(initialLabel !== undefined ? { initialLabel } : {})}
          {...(onRenamed ? { onRenamed } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
/** A dismissed naming request remains actionable in connection settings. */
export function ClientLabelGate() {
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const environment = environments.find(
    (entry) => entry.connection.needsClientLabel && !dismissed.has(entry.environmentId),
  );
  if (!environment) return null;
  return (
    <ClientNameDialog
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      onClose={() => setDismissed((previous) => new Set([...previous, environment.environmentId]))}
    />
  );
}
