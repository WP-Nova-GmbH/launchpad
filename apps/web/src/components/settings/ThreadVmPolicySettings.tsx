import { PortableThreadLibrary } from "../chat/PortableThreadLibrary";
import { useAuth } from "@clerk/react";
import {
  ManagedRelayTenancy,
  THREAD_VM_POLICY_FIELDS,
  THREAD_VM_POLICY_INPUT_ERROR,
  parseThreadVmPolicyDraft,
  threadVmPolicyDraft,
  type ThreadVmPolicyDraft,
} from "@t3tools/client-runtime/relay";
import type { ThreadVmPolicyRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { decodedRelayClientError } from "../../cloud/linkEnvironment";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ThreadVmPolicySettings({ isAdmin }: { readonly isAdmin: boolean }) {
  const { userId } = useAuth();
  return <ThreadVmPolicyEditor key={userId} isAdmin={isAdmin} />;
}

function ThreadVmPolicyEditor({ isAdmin }: { readonly isAdmin: boolean }) {
  const { getToken } = useAuth();
  const [record, setRecord] = useState<ThreadVmPolicyRecord | null>(null);
  const [draft, setDraft] = useState<ThreadVmPolicyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clerkToken = await getToken(resolveRelayClerkTokenOptions());
      if (!clerkToken) throw new Error("Sign in to Launchpad Connect first.");
      if (request !== epoch.current) return;
      const next = await runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) => client.getThreadVmPolicy({ clerkToken })),
          Effect.mapError(decodedRelayClientError("Could not read the VM policy")),
        ),
      );
      if (request !== epoch.current) return;
      setRecord(next);
      setDraft(threadVmPolicyDraft(next.policy));
    } catch (cause) {
      if (request === epoch.current)
        setError(cause instanceof Error ? cause.message : "Could not read the VM policy.");
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }, [getToken]);

  useEffect(() => {
    void load();
    return () => {
      epoch.current += 1;
    };
  }, [load]);

  const save = async () => {
    if (!record || !draft || !isAdmin || busy) return;
    let policy;
    try {
      policy = parseThreadVmPolicyDraft(draft);
    } catch {
      setError(THREAD_VM_POLICY_INPUT_ERROR);
      return;
    }
    const request = epoch.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const clerkToken = await getToken(resolveRelayClerkTokenOptions());
      if (!clerkToken) throw new Error("Sign in to Launchpad Connect first.");
      if (request !== epoch.current) return;
      const next = await runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) =>
            client.updateThreadVmPolicy({ clerkToken, payload: { ...record, policy } }),
          ),
          Effect.mapError(decodedRelayClientError("Could not save the VM policy")),
        ),
      );
      if (request !== epoch.current) return;
      setRecord(next);
      setDraft(threadVmPolicyDraft(next.policy));
      setSaved(true);
    } catch (cause) {
      if (request === epoch.current)
        setError(cause instanceof Error ? cause.message : "Could not save the VM policy.");
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  };

  return (
    <SettingsSection
      id={searchableSetting("organization-thread-vms").id}
      title="Thread VMs"
      icon={<MonitorIcon className="size-4 text-muted-foreground" />}
    >
      <p className="px-3 pb-1 text-sm text-muted-foreground sm:px-4">
        Each VM belongs to one thread.{" "}
        {isAdmin
          ? "These limits apply to everyone in your organization."
          : "An organization admin can change these limits."}
      </p>
      {draft ? (
        <>
          {THREAD_VM_POLICY_FIELDS.map((field) => (
            <SettingsRow
              key={field.key}
              title={field.label}
              description={field.description}
              control={
                <div className="w-28">
                  <Input
                    size="sm"
                    type="number"
                    min={field.min}
                    step={1}
                    aria-label={field.label}
                    disabled={busy || !isAdmin}
                    value={draft[field.key]}
                    onChange={(event) => {
                      setDraft({ ...draft, [field.key]: event.target.value });
                      setSaved(false);
                    }}
                  />
                </div>
              }
            />
          ))}
          <SettingsRow
            title="Calendar time zone"
            description="Weekday deletion and saved disk expiry use this time zone."
            control={
              <div className="w-48">
                <Input
                  size="sm"
                  aria-label="Calendar time zone"
                  disabled={busy || !isAdmin}
                  value={draft.calendarTimeZone}
                  onChange={(event) => {
                    setDraft({ ...draft, calendarTimeZone: event.target.value });
                    setSaved(false);
                  }}
                />
              </div>
            }
          />
        </>
      ) : busy ? (
        <p role="status" className="px-3 text-sm sm:px-4">
          Loading VM policy…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-3 text-sm text-destructive sm:px-4">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
          VM policy saved.
        </p>
      ) : null}
      <div className="flex gap-2 px-3 py-3 sm:px-4">
        <PortableThreadLibrary />
        {isAdmin ? (
          <Button disabled={busy || !draft} onClick={() => void save()}>
            Save policy
          </Button>
        ) : null}
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          Reload policy
        </Button>
      </div>
    </SettingsSection>
  );
}
