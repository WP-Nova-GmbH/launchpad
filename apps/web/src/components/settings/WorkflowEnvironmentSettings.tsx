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
import { GitForkIcon, InfoIcon } from "lucide-react";
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

type Draft = {
  readonly kind: "variable" | "secret";
  readonly name: string;
  readonly value: string;
  readonly mode: "add" | "edit" | "delete";
};

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
            <div className="pe-8">
              <SheetTitle>Workflow environment</SheetTitle>
            </div>
            <SheetDescription>
              <GitForkIcon aria-hidden className="me-1.5 inline size-3.5 align-[-2px]" />
              <span className="wrap-anywhere">{repositoryName}</span>
              <span className="ms-2 border-s ps-2">Workflow VMs</span>
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
  const [kind, setKind] = useState<"variable" | "secret">("variable");
  const [savedName, setSavedName] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const active = useRef<AbortController | null>(null);
  const recoveryRef = useRef<HTMLDivElement | null>(null);
  const reloadButton = useRef<HTMLButtonElement | null>(null);
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
      setSavedName(null);
      try {
        const result = await request(operation.signal, update);
        if (operation.signal.aborted) return;
        setRecord(result);
        setNeedsReload(false);
        if (update) {
          setDraft(null);
          setSavedName(update.mutation.name);
        } else {
          setDraft((current) => (current?.mode === "delete" ? null : current));
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

  useLayoutEffect(() => {
    if (draft || pending || !returnFocus.current) return;
    if (needsReload) {
      reloadButton.current?.focus();
      return;
    }
    const trigger = returnFocus.current;
    returnFocus.current = null;
    if (trigger.isConnected && !trigger.disabled) trigger.focus();
    else addButton.current?.focus();
  }, [draft, needsReload, pending]);

  const disabled = pending !== null || needsReload;
  const existing = draft && record?.entries.find((entry) => entry.name === draft.name);
  const kindConflict = draft && draft.mode !== "delete" && existing && existing.kind !== draft.kind;
  const validName = draft !== null && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(draft.name);
  const submit = (mutation: RelayUpdateRepositoryWorkflowConfiguration["mutation"]) => {
    if (record && !disabled) void run({ expectedRevision: record.revision, mutation });
  };

  const editingEntry =
    draft && draft.mode !== "add" && existing?.kind === kind ? existing : undefined;
  const beginDraft = (next: Draft, trigger: HTMLButtonElement) => {
    returnFocus.current = trigger;
    setSavedName(null);
    setError(null);
    setDraft(next);
  };

  const recovery =
    error || needsReload ? (
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
                ref={reloadButton}
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
          {error === "changed"
            ? draft?.mode === "delete"
              ? "Reload the latest settings before confirming the deletion again."
              : draft
                ? "Reload the latest settings before trying again. Your draft will stay."
                : "Reload the latest settings before trying again."
            : error
              ? editorErrorMessages[error]
              : null}
        </WorkflowAlert>
      </div>
    ) : null;
  const savedNotice = savedName ? (
    <p role="status" className="text-sm text-muted-foreground">
      Workflow environment updated.
    </p>
  ) : null;
  const draftForm = draft ? (
    <>
      <div
        key={draft.mode}
        ref={focusDraft}
        role="group"
        aria-labelledby={`${fieldId}-draft-title`}
        tabIndex={-1}
        className="space-y-3 rounded-lg border bg-muted/25 p-3"
      >
        {draft.mode === "delete" ? (
          <p id={`${fieldId}-draft-title`} className="wrap-anywhere text-sm">
            Delete {draft.name} from future runs?
          </p>
        ) : (
          <>
            <p
              id={`${fieldId}-draft-title`}
              className={editingEntry ? "sr-only" : "wrap-anywhere text-sm font-medium"}
            >
              {draft.mode === "edit"
                ? `${draft.kind === "secret" ? "Replace" : "Edit"} ${draft.name}`
                : `Add ${draft.kind}`}
            </p>
            {draft.mode === "add" ? (
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
                  aria-describedby={`${fieldId}-name-hint`}
                  aria-invalid={(draft.name.length > 0 && !validName) || undefined}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                />
                <p
                  id={`${fieldId}-name-hint`}
                  className={
                    draft.name && !validName
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  Start with a letter or underscore. Use only letters, numbers, and underscores.
                </p>
              </div>
            ) : null}
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
                  size="sm"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                  value={draft.value}
                  onChange={(event) => setDraft({ ...draft, value: event.currentTarget.value })}
                />
              )}
            </div>
            {kindConflict ? (
              <WorkflowAlert title="Environment name already in use" variant="warning">
                A {existing.kind} already uses this name. Choose a different name before saving.
              </WorkflowAlert>
            ) : null}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {draft.mode === "edit" && editingEntry ? (
            <Button
              type="button"
              size="sm"
              variant="ghost-destructive"
              disabled={disabled}
              aria-label={`Delete ${draft.name}`}
              onClick={() => setDraft({ ...draft, mode: "delete" })}
            >
              Delete
            </Button>
          ) : null}
          <div className="ms-auto flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending === "save"}
              onClick={() => setDraft(draft.mode === "delete" ? { ...draft, mode: "edit" } : null)}
            >
              {draft.mode === "delete" ? "Cancel deletion" : "Cancel"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={draft.mode === "delete" ? "destructive" : "default"}
              disabled={
                disabled ||
                !!kindConflict ||
                !validName ||
                (draft.mode !== "delete" && draft.kind === "secret" && draft.value.length === 0)
              }
              onClick={() =>
                submit(
                  draft.mode === "delete"
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
                : draft.mode === "delete"
                  ? "Confirm delete"
                  : existing?.kind === draft.kind &&
                      (draft.kind === "secret" || draft.mode === "add")
                    ? `Replace ${draft.kind}`
                    : `Save ${draft.kind}`}
            </Button>
          </div>
        </div>
      </div>
      {recovery}
    </>
  ) : null;

  const entries = record?.entries.filter((entry) => entry.kind === kind) ?? [];

  return (
    <>
      {record ? (
        <div
          role="group"
          aria-label="Environment entry type"
          className="flex shrink-0 gap-4 border-b px-6"
        >
          {(["variable", "secret"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={choice === kind}
              disabled={draft !== null && choice !== kind}
              onClick={() => {
                setKind(choice);
                setSavedName(null);
              }}
              className="min-h-9 border-b-2 border-transparent px-0.5 text-sm text-muted-foreground aria-pressed:border-primary aria-pressed:font-medium aria-pressed:text-foreground disabled:opacity-50 pointer-coarse:min-h-11"
            >
              {choice === "variable" ? "Variables" : "Secrets"}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-3">
        {record ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {kind === "variable"
                  ? "Plain text values for workflow runs."
                  : "Saved secret values can’t be viewed."}
              </p>
              <Button
                ref={addButton}
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || draft !== null}
                onClick={(event) =>
                  beginDraft({ kind, name: "", value: "", mode: "add" }, event.currentTarget)
                }
              >
                {kind === "variable" ? "Add variable" : "Add secret"}
              </Button>
            </div>
            {draft && draft.mode === "add" ? draftForm : null}
            {entries.length > 0 ? (
              <ul className="divide-y border-t">
                {entries.map((entry) => (
                  <li key={entry.name} className="space-y-2 py-2">
                    <div className="flex min-h-8 items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <code className="wrap-anywhere text-xs">{entry.name}</code>
                        {entry.kind === "variable" && entry !== editingEntry ? (
                          <p className="truncate text-sm text-muted-foreground">{entry.value}</p>
                        ) : null}
                      </div>
                      <div hidden={entry === editingEntry}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`${entry.kind === "secret" ? "Replace" : "Edit"} ${entry.name}`}
                          disabled={disabled || draft !== null}
                          onClick={(event) =>
                            beginDraft(
                              {
                                kind: entry.kind,
                                name: entry.name,
                                value: entry.kind === "variable" ? entry.value : "",
                                mode: "edit",
                              },
                              event.currentTarget,
                            )
                          }
                        >
                          {entry.kind === "secret" ? "Replace" : "Edit"}
                        </Button>
                      </div>
                    </div>
                    {entry === editingEntry ? draftForm : null}
                    {savedName === entry.name ? savedNotice : null}
                  </li>
                ))}
              </ul>
            ) : !draft ? (
              <p className="border-t py-3 text-sm text-muted-foreground">
                {kind === "variable" ? "No variables yet." : "No secrets yet."}
              </p>
            ) : null}
            {draft && draft.mode !== "add" && !editingEntry ? draftForm : null}
          </>
        ) : null}
        {pending === "load" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading workflow environment…
          </p>
        ) : null}
        {!draft ? recovery : null}
        {savedName && !entries.some((entry) => entry.name === savedName) ? savedNotice : null}
      </div>
      <div className="flex shrink-0 items-start gap-2 border-t px-6 py-3 text-xs text-muted-foreground">
        <InfoIcon aria-hidden className="size-3.5 shrink-0" />
        <p>Changes apply to runs that haven’t started preparing.</p>
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
