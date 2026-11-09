import { WorkflowAlert } from "../workflows/WorkflowAlert";
import { useAuth } from "@clerk/react";
import { ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  RELAY_WORKFLOW_ENV_NAME_MAX_LENGTH,
  type RelayOrganizationId,
  type RelayRepositoryId,
  type RelayRepositoryWorkflowConfiguration,
  type RelayUpdateRepositoryWorkflowConfiguration,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Textarea } from "../ui/textarea";

interface Scope {
  readonly accountId: string;
  readonly organizationId: RelayOrganizationId;
  readonly repositoryId: RelayRepositoryId;
  readonly repositoryName: string;
}

type Failure = "access" | "changed" | "invalid" | "limit" | "unknown";
const editorErrorMessages = {
  access: "You no longer have access to this workflow environment.",
  invalid: "This name or value is not allowed. Check both and try again.",
  limit: "This change exceeds the workflow environment size limit.",
  saveUnconfirmed: "Could not confirm the change. Reload the latest settings before trying again.",
  loadFailed: "Could not load the workflow environment.",
};

class WorkflowEnvironmentError extends Error {
  constructor(readonly failure: Failure) {
    super(failure);
  }
}

type Request = (
  signal: AbortSignal,
  update?: RelayUpdateRepositoryWorkflowConfiguration,
) => Promise<RelayRepositoryWorkflowConfiguration>;

type Draft =
  | {
      readonly kind: "variable" | "secret";
      readonly name: string;
      readonly value: string;
      readonly editing: boolean;
    }
  | { readonly kind: "delete"; readonly name: string };

export function WorkflowEnvironmentButton(scope: Scope) {
  const { getToken, userId } = useAuth();
  if (scope.accountId !== userId) return null;
  return (
    <ScopedWorkflowEnvironmentButton
      key={JSON.stringify([scope.accountId, scope.organizationId, scope.repositoryId])}
      scope={scope}
      getToken={getToken}
    />
  );
}

function ScopedWorkflowEnvironmentButton({
  scope,
  getToken,
}: {
  readonly scope: Scope;
  readonly getToken: ReturnType<typeof useAuth>["getToken"];
}) {
  const [open, setOpen] = useState(false);
  const { accountId, organizationId, repositoryId, repositoryName } = scope;
  const request = useCallback<Request>(
    async (signal, update) => {
      const clerkToken = await getToken(resolveRelayClerkTokenOptions());
      signal.throwIfAborted();
      if (!clerkToken) throw new WorkflowEnvironmentError("access");
      return runtime.runPromise(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              // The Clerk token may resolve after the signed-in account changes.
              const membership = yield* client.getOrganization({ clerkToken });
              if (
                membership.userId !== accountId ||
                membership.organization.organizationId !== organizationId
              )
                return yield* Effect.fail(new WorkflowEnvironmentError("access"));
              const result = update
                ? yield* client.updateRepositoryWorkflowConfiguration({
                    clerkToken,
                    repositoryId,
                    payload: update,
                  })
                : yield* client.getRepositoryWorkflowConfiguration({ clerkToken, repositoryId });
              if (result.repositoryId !== repositoryId || result.organizationId !== organizationId)
                return yield* Effect.fail(new WorkflowEnvironmentError("access"));
              if (update && result.revision !== update.expectedRevision + 1)
                return yield* Effect.fail(new WorkflowEnvironmentError("unknown"));
              return result;
            }),
          ),
          Effect.mapError((cause) => {
            if (cause instanceof WorkflowEnvironmentError) return cause;
            const error =
              cause._tag === "ManagedRelayRequestFailedError" ? cause.relayError : undefined;
            switch (error?._tag) {
              case "RelayAuthInvalidError":
              case "RelayTenancyForbiddenError":
              case "RelayTenancyNotFoundError":
                return new WorkflowEnvironmentError("access");
              case "RelayTenancyConflictError":
                return new WorkflowEnvironmentError("changed");
              case "RelayTenancyInvalidError":
                return new WorkflowEnvironmentError(
                  error.reason === "workflow_configuration_limit" ? "limit" : "invalid",
                );
              default:
                return new WorkflowEnvironmentError("unknown");
            }
          }),
        ),
        { signal },
      );
    },
    [accountId, getToken, organizationId, repositoryId],
  );

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Workflow environment
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup>
          <SheetHeader>
            <SheetTitle>Workflow environment</SheetTitle>
            <SheetDescription>
              Variables and secrets for {repositoryName}’s workflow VMs. Runs that have started
              preparing keep their current values.
            </SheetDescription>
          </SheetHeader>
          {open ? <WorkflowEnvironmentEditor request={request} /> : null}
        </SheetPopup>
      </Sheet>
    </>
  );
}

function WorkflowEnvironmentEditor({ request }: { readonly request: Request }) {
  const fieldId = useId();
  const [record, setRecord] = useState<RelayRepositoryWorkflowConfiguration | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<"load" | "save" | null>("load");
  const [error, setError] = useState<keyof typeof editorErrorMessages | "changed" | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [saved, setSaved] = useState(false);
  const active = useRef<AbortController | null>(null);
  const recoveryRef = useRef<HTMLDivElement | null>(null);
  const focusDraft = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);

  const run = useCallback(
    async (update?: RelayUpdateRepositoryWorkflowConfiguration) => {
      if (active.current) return;
      const operation = new AbortController();
      active.current = operation;
      setPending(update ? "save" : "load");
      setError(null);
      setSaved(false);
      try {
        const result = await request(operation.signal, update);
        if (operation.signal.aborted) return;
        setRecord(result);
        setNeedsReload(false);
        if (update) {
          setDraft(null);
          setSaved(true);
        } else {
          setDraft((current) => (current?.kind === "delete" ? null : current));
        }
      } catch (cause) {
        if (operation.signal.aborted) return;
        const failure = cause instanceof WorkflowEnvironmentError ? cause.failure : "unknown";
        switch (failure) {
          case "access":
            setRecord(null);
            setDraft(null);
            setNeedsReload(false);
            setError(failure);
            break;
          case "changed":
            setNeedsReload(true);
            setError(failure);
            break;
          case "invalid":
          case "limit":
            setError(failure);
            break;
          case "unknown":
            setNeedsReload(true);
            setError(update ? "saveUnconfirmed" : "loadFailed");
            break;
        }
      } finally {
        if (active.current === operation) {
          active.current = null;
          setPending(null);
        }
      }
    },
    [request],
  );

  useLayoutEffect(() => {
    let closed = false;
    void Promise.resolve().then(() => {
      if (!closed) return run();
    });
    return () => {
      closed = true;
      const operation = active.current;
      active.current = null;
      operation?.abort();
    };
  }, [run]);

  useLayoutEffect(() => {
    if (error) recoveryRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const disabled = pending !== null || needsReload;
  const existing = draft && record?.entries.find((entry) => entry.name === draft.name);
  const kindConflict = draft && draft.kind !== "delete" && existing && existing.kind !== draft.kind;
  const validName = draft !== null && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(draft.name);
  const submit = (mutation: RelayUpdateRepositoryWorkflowConfiguration["mutation"]) => {
    if (record && !disabled) void run({ expectedRevision: record.revision, mutation });
  };

  return (
    <>
      {record ? (
        <div className="flex shrink-0 flex-wrap gap-2 px-6 pb-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || draft !== null}
            onClick={() => setDraft({ kind: "variable", name: "", value: "", editing: false })}
          >
            Add variable
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || draft !== null}
            onClick={() => setDraft({ kind: "secret", name: "", value: "", editing: false })}
          >
            Add secret
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {record ? (
          <>
            {record.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No variables or secrets yet.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {record.entries.map((entry) => (
                  <li
                    key={entry.name}
                    className="flex flex-wrap items-start justify-between gap-2 p-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="break-all text-xs">{entry.name}</code>
                        {entry.kind === "secret" ? <Badge variant="outline">Secret</Badge> : null}
                      </div>
                      {entry.kind === "variable" ? (
                        <p className="truncate text-sm text-muted-foreground">{entry.value}</p>
                      ) : null}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${entry.kind === "secret" ? "Replace" : "Edit"} ${entry.name}`}
                        disabled={disabled || draft !== null}
                        onClick={() =>
                          setDraft({
                            kind: entry.kind,
                            name: entry.name,
                            value: entry.kind === "variable" ? entry.value : "",
                            editing: true,
                          })
                        }
                      >
                        {entry.kind === "secret" ? "Replace" : "Edit"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${entry.name}`}
                        disabled={disabled || draft !== null}
                        onClick={() => setDraft({ kind: "delete", name: entry.name })}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {draft ? (
              <div
                ref={focusDraft}
                role="group"
                aria-labelledby={`${fieldId}-draft-title`}
                tabIndex={-1}
                className="space-y-2 rounded-md border p-3"
              >
                {draft.kind === "delete" ? (
                  <p id={`${fieldId}-draft-title`} className="break-words text-sm">
                    Delete {draft.name} from future runs?
                  </p>
                ) : (
                  <>
                    <p id={`${fieldId}-draft-title`} className="text-sm font-medium">
                      {draft.kind === "secret"
                        ? existing?.kind === "secret" || draft.editing
                          ? "Replace secret"
                          : "Add secret"
                        : draft.editing
                          ? "Edit variable"
                          : "Add variable"}
                    </p>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${fieldId}-name`}>Name</Label>
                      <Input
                        id={`${fieldId}-name`}
                        nativeInput
                        size="sm"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="API_KEY"
                        maxLength={RELAY_WORKFLOW_ENV_NAME_MAX_LENGTH}
                        disabled={pending !== null}
                        readOnly={draft.editing}
                        aria-describedby={draft.editing ? undefined : `${fieldId}-name-hint`}
                        aria-invalid={
                          (!draft.editing && draft.name.length > 0 && !validName) || undefined
                        }
                        value={draft.name}
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.currentTarget.value })
                        }
                      />
                      {draft.editing ? null : (
                        <p
                          id={`${fieldId}-name-hint`}
                          className={
                            draft.name && !validName
                              ? "text-xs text-destructive"
                              : "text-xs text-muted-foreground"
                          }
                        >
                          Start with a letter or underscore. Use only letters, numbers, and
                          underscores.
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${fieldId}-value`}>
                        {draft.kind === "secret" ? "Secret value" : "Variable value"}
                      </Label>
                      {draft.kind === "secret" ? (
                        <SecretDraft
                          id={`${fieldId}-value`}
                          value={draft.value}
                          disabled={pending !== null}
                          onChange={(value) => setDraft({ ...draft, value })}
                        />
                      ) : (
                        <Textarea
                          id={`${fieldId}-value`}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={pending !== null}
                          value={draft.value}
                          onChange={(event) =>
                            setDraft({ ...draft, value: event.currentTarget.value })
                          }
                        />
                      )}
                    </div>
                    {kindConflict ? (
                      <WorkflowAlert title="Environment name already in use" variant="warning">
                        A {existing.kind} already uses this name. Choose a different name before
                        saving.
                      </WorkflowAlert>
                    ) : null}
                  </>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={draft.kind === "delete" ? "destructive" : "default"}
                    disabled={
                      disabled ||
                      !!kindConflict ||
                      !validName ||
                      (draft.kind === "secret" && draft.value.length === 0)
                    }
                    onClick={() =>
                      submit(
                        draft.kind === "delete"
                          ? { kind: "delete", name: draft.name }
                          : {
                              kind: draft.kind === "secret" ? "setSecret" : "setVariable",
                              name: draft.name,
                              value: draft.value,
                            },
                      )
                    }
                  >
                    {pending === "save"
                      ? "Saving…"
                      : draft.kind === "delete"
                        ? "Confirm delete"
                        : existing
                          ? "Replace value"
                          : "Save value"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending === "save"}
                    onClick={() => setDraft(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {pending === "load" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading workflow environment…
          </p>
        ) : null}
        {error || needsReload ? (
          <div ref={recoveryRef} className="min-w-0">
            <WorkflowAlert
              title={
                error === "changed"
                  ? "Workflow environment changed"
                  : "Could not update workflow environment"
              }
              actions={
                needsReload ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => void run()}
                  >
                    Reload settings
                  </Button>
                ) : undefined
              }
            >
              {error === "changed" ? (
                <div className="space-y-1">
                  <p className="font-medium">Settings changed</p>
                  <p className="text-muted-foreground">
                    {draft?.kind === "delete"
                      ? "Reload the latest settings before confirming the deletion again."
                      : draft
                        ? "Reload the latest settings before trying again. Your draft will stay."
                        : "Reload the latest settings before trying again."}
                  </p>
                </div>
              ) : error ? (
                <p>{editorErrorMessages[error]}</p>
              ) : null}
            </WorkflowAlert>
          </div>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            Workflow environment updated.
          </p>
        ) : null}
      </div>
    </>
  );
}

function SecretDraft({
  id,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const multiline = /[\r\n]/u.test(value);
  return (
    <div className="space-y-1">
      <Input
        id={id}
        nativeInput
        size="sm"
        type="password"
        autoComplete="new-password"
        disabled={disabled}
        readOnly={multiline}
        value={multiline ? "••••••••" : value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (!/[\r\n]/u.test(pasted)) return;
          event.preventDefault();
          onChange(pasted);
        }}
      />
      {multiline ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">Multiline secret pasted.</p>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange("")}>
            Clear pasted value
          </Button>
        </div>
      ) : null}
    </div>
  );
}
