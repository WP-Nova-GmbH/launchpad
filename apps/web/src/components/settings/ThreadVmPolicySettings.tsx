import { Link } from "@tanstack/react-router";
import { useAuth } from "@clerk/react";
import {
  ManagedRelayTenancy,
  THREAD_VM_POLICY_FIELDS,
  THREAD_VM_POLICY_INPUT_ERROR,
  parseThreadVmPolicyDraft,
  threadVmPolicyDraft,
  type ThreadVmPolicyDraft,
} from "@t3tools/client-runtime/relay";
import type { ThreadVmCapabilities, ThreadVmPolicyRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { threadVmCapabilityLabel } from "@t3tools/client-runtime/relay/threadVmControls";
import { ChevronRightIcon, MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodedRelayClientError } from "../../cloud/linkEnvironment";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { requestConfirmDialog } from "../../confirmDialog";
import { runtime } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WorkflowVmPolicySettings } from "./WorkflowVmPolicySettings";

export function ThreadVmPolicySettings({
  isAdmin,
  organizationId,
}: {
  readonly isAdmin: boolean;
  readonly organizationId: string;
}) {
  const { userId } = useAuth();
  return (
    <>
      <ThreadVmPolicyEditor
        key={JSON.stringify([userId, organizationId, isAdmin])}
        isAdmin={isAdmin}
        organizationId={organizationId}
      />
      <WorkflowVmPolicySettings organizationId={organizationId} />
    </>
  );
}

function ThreadVmPolicyEditor({
  isAdmin,
  organizationId,
}: {
  readonly isAdmin: boolean;
  readonly organizationId: string;
}) {
  const { getToken } = useAuth();
  const [capabilities, setCapabilities] = useState<ThreadVmCapabilities | null>(null);
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
      const [next, health] = await runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) =>
            Effect.all([client.getThreadVmPolicy({ clerkToken }), client.getHealth()], {
              concurrency: 2,
            }),
          ),
          Effect.mapError(decodedRelayClientError("Could not read the VM policy")),
        ),
      );
      if (request !== epoch.current) return;
      if (next.organizationId !== organizationId) {
        throw new Error(
          "Your organization changed. Reopen Organization settings to load its VM policy.",
        );
      }
      setCapabilities(health.threadVmCapabilities ?? null);
      setRecord(next);
      setDraft(threadVmPolicyDraft(next.policy));
    } catch (cause) {
      if (request === epoch.current)
        setError(cause instanceof Error ? cause.message : "Could not read the VM policy.");
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }, [getToken, organizationId]);

  useEffect(() => {
    void load();
    return () => {
      epoch.current += 1;
    };
  }, [load]);

  const editedPolicy = useMemo(() => {
    if (!draft) return null;
    try {
      return parseThreadVmPolicyDraft(draft);
    } catch {
      return null;
    }
  }, [draft]);
  const dirty = !!(
    draft &&
    record &&
    (!editedPolicy ||
      editedPolicy.calendarTimeZone !== record.policy.calendarTimeZone ||
      THREAD_VM_POLICY_FIELDS.some(({ key }) => editedPolicy[key] !== record.policy[key]))
  );

  const reload = async () => {
    const request = epoch.current;
    if (
      dirty &&
      !(await requestConfirmDialog(
        "Discard unsaved policy changes?\nReloading restores the saved Thread VM policy.",
        { variant: "destructive" },
      ))
    )
      return;
    if (request === epoch.current) await load();
  };

  const save = async () => {
    if (!record || !editedPolicy || !dirty || !isAdmin || busy) return;
    const policy = editedPolicy;
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
      <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
        Each VM belongs to one thread.{" "}
        {isAdmin
          ? "These limits apply to everyone in your organization."
          : "An organization admin can change these limits."}
      </p>
      <details className="group/automation">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring sm:px-4 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground group-open/automation:rotate-90"
          />
          Automation status
        </summary>
        <div className="grid gap-2 px-3 pb-3 sm:px-4">
          <p className="text-sm text-muted-foreground">
            The relay controls which automations are active.
          </p>
          {(
            [
              ["configured", "VM host"],
              ["autoPause", "Pause inactive VMs"],
              ["autoBackup", "Automatic workspace backups"],
              ["autoDelete", "Save and stop inactive VMs"],
              ["replacement", "Replace an idle VM at the limit"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex justify-between gap-3 text-sm">
              <span>{label}</span>
              <span className="text-muted-foreground">
                {threadVmCapabilityLabel(capabilities, key)}
              </span>
            </div>
          ))}
        </div>
      </details>
      {draft ? (
        <>
          {THREAD_VM_POLICY_FIELDS.map((field) => (
            <SettingsRow
              key={field.key}
              title={field.label}
              description={field.description}
              control={
                isAdmin ? (
                  <div className="w-28">
                    <Input
                      size="sm"
                      type="number"
                      min={field.min}
                      step={1}
                      aria-label={field.label}
                      disabled={busy}
                      value={draft[field.key]}
                      onChange={(event) => {
                        setDraft({ ...draft, [field.key]: event.target.value });
                        setSaved(false);
                        setError(null);
                      }}
                    />
                  </div>
                ) : (
                  <span className="text-sm tabular-nums">{draft[field.key]}</span>
                )
              }
            />
          ))}
          <SettingsRow
            title="Calendar time zone"
            description="Idle deletion counts Monday–Friday. Saved workspace retention counts calendar days in this time zone."
            control={
              isAdmin ? (
                <div className="w-48 max-w-full">
                  <Input
                    size="sm"
                    aria-label="Calendar time zone"
                    disabled={busy}
                    value={draft.calendarTimeZone}
                    onChange={(event) => {
                      setDraft({ ...draft, calendarTimeZone: event.target.value });
                      setSaved(false);
                      setError(null);
                    }}
                  />
                </div>
              ) : (
                <span className="break-all text-sm">{draft.calendarTimeZone}</span>
              )
            }
          />
        </>
      ) : busy ? (
        <p role="status" className="px-3 py-3 text-sm sm:px-4">
          Loading VM policy…
        </p>
      ) : null}
      {draft && !editedPolicy ? (
        <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
          {THREAD_VM_POLICY_INPUT_ERROR}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          VM policy saved.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 sm:px-4">
        <Button size="sm" variant="ghost" render={<Link to="/settings/vms" />}>
          VM threads
        </Button>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>
            Reload policy
          </Button>
          {isAdmin ? (
            <Button
              size="sm"
              disabled={busy || !dirty || !editedPolicy}
              onClick={() => void save()}
            >
              Save policy
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}
