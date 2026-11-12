import {
  RELAY_WORKFLOW_ENV_MAX_ENTRIES,
  RELAY_WORKFLOW_ENV_TOTAL_MAX_BYTES,
  type RelayRepositoryWorkflowConfiguration,
  type RelayUpdateRepositoryWorkflowConfiguration,
} from "@t3tools/contracts/relay";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { WorkflowAlert } from "../workflows/WorkflowAlert";
import {
  parseWorkflowEnvImport,
  suggestedWorkflowEnvKind,
  WORKFLOW_ENV_IMPORT_TEXT_LIMIT,
} from "./workflowEnvImport";

type ImportMutation = Extract<
  RelayUpdateRepositoryWorkflowConfiguration["mutation"],
  { kind: "import" }
>;
type ImportEntry = ImportMutation["entries"][number];
type PreviewRow = ImportEntry & { readonly existing: boolean };
const encoder = new TextEncoder();

export function WorkflowEnvironmentImport({
  record,
  disabled,
  saving,
  onImport,
  onCancel,
}: {
  record: RelayRepositoryWorkflowConfiguration;
  disabled: boolean;
  saving: boolean;
  onImport: (mutation: ImportMutation) => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<{
    revision: number;
    rows: ReadonlyArray<PreviewRow>;
    editing: boolean;
  } | null>(null);
  const preview = reviewed?.editing === false ? reviewed : null;
  const previewRevision = preview?.revision;
  useLayoutEffect(() => {
    if (previewRevision === undefined) inputRef.current?.focus();
    else headingRef.current?.focus();
  }, [previewRevision]);

  const review = () => {
    const parsed = parseWorkflowEnvImport(input);
    if (!parsed.entries) {
      setError(parsed.error);
      return;
    }
    const existing = new Map(record.entries.map((entry) => [entry.name, entry.kind]));
    const priorKinds = new Map(reviewed?.rows.map((row) => [row.name, row.kind]));
    setError(null);
    setReviewed({
      editing: false,
      revision: record.revision,
      rows: parsed.entries.map(({ name, value }) => ({
        name,
        value,
        existing: existing.has(name),
        kind: existing.get(name) ?? priorKinds.get(name) ?? suggestedWorkflowEnvKind(name),
        replace: false,
      })),
    });
  };
  const select = (name: string, value: string) => {
    setReviewed(
      (current) =>
        current && {
          ...current,
          rows: current.rows.map((row) =>
            row.name !== name
              ? row
              : row.existing
                ? { ...row, replace: value === "replace" }
                : { ...row, kind: value === "secret" ? "secret" : "variable" },
          ),
        },
    );
  };
  const stale = preview !== null && preview.revision !== record.revision;
  const selected = preview?.rows.filter((row) => !row.existing || row.replace) ?? [];
  const selectedNames = new Set(selected.map((row) => row.name));
  const knownBytes =
    selected.reduce((total, row) => total + encoder.encode(row.value).byteLength, 0) +
    record.entries.reduce(
      (total, entry) =>
        total +
        (entry.kind === "variable" && !selectedNames.has(entry.name)
          ? encoder.encode(entry.value).byteLength
          : 0),
      0,
    );
  const limitExceeded =
    record.entries.length + selected.filter((row) => !row.existing).length >
      RELAY_WORKFLOW_ENV_MAX_ENTRIES || knownBytes > RELAY_WORKFLOW_ENV_TOTAL_MAX_BYTES;
  const emptySecret = selected.some((row) => row.kind === "secret" && row.value.length === 0);
  const secretCount = selected.filter((row) => row.kind === "secret").length;
  const addsFirstSecret =
    secretCount > 0 && !record.entries.some((entry) => entry.kind === "secret");

  return (
    <section className="space-y-3" aria-label="Import .env">
      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium">
        Import .env
      </h3>
      {!preview ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={inputId}>Paste .env contents</Label>
            <Textarea
              ref={inputRef}
              id={inputId}
              placeholder="APP_MODE=production"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={disabled}
              value={input}
              onChange={(event) => {
                const text = event.currentTarget.value;
                if (text.length > WORKFLOW_ENV_IMPORT_TEXT_LIMIT) {
                  setInput("");
                  setError("Paste no more than 128 KiB of .env text.");
                  return;
                }
                setInput(text);
                setError(null);
              }}
            />
          </div>
          {error ? <WorkflowAlert title="Check the .env text">{error}</WorkflowAlert> : null}
        </>
      ) : stale ? (
        <WorkflowAlert title="Review the latest settings" variant="info">
          The workflow environment changed. Review the import again before saving.
        </WorkflowAlert>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Review the suggested types. Existing entries are skipped unless you choose Replace.
          </p>
          <ul className="divide-y border-y">
            {preview.rows.map((row) => (
              <li key={row.name} className="space-y-1 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <code className="wrap-anywhere text-xs">{row.name}</code>
                    {row.existing ? (
                      <p className="text-xs text-muted-foreground">
                        {row.kind === "secret" ? "Existing secret" : "Existing variable"}
                      </p>
                    ) : null}
                  </div>
                  <select
                    aria-label={`${row.existing ? "Action" : "Type"} for ${row.name}`}
                    className="rounded-md border bg-popover px-2 py-1 text-sm"
                    disabled={disabled}
                    value={row.existing ? (row.replace ? "replace" : "skip") : row.kind}
                    onChange={(event) => select(row.name, event.currentTarget.value)}
                  >
                    {row.existing ? (
                      <>
                        <option value="skip">Skip</option>
                        <option value="replace">Replace</option>
                      </>
                    ) : (
                      <>
                        <option value="variable">Variable</option>
                        <option value="secret">Secret</option>
                      </>
                    )}
                  </select>
                </div>
                {row.kind === "secret" &&
                row.value.length === 0 &&
                (!row.existing || row.replace) ? (
                  <p className="text-xs text-destructive">
                    Enter a value in the .env text to save this secret.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {limitExceeded ? (
            <WorkflowAlert title="Workflow environment limit exceeded">
              Keep the repository at 64 entries and 32 KiB of values. Edit the pasted text or skip
              replacements as needed.
            </WorkflowAlert>
          ) : null}
          {addsFirstSecret ? (
            <WorkflowAlert title="Secrets restrict VM runs" variant="info">
              With a saved secret, only repository maintainers and organization admins can start the
              repository’s VM workflows.
            </WorkflowAlert>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel import
        </Button>
        {preview ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => setReviewed({ ...preview, editing: true })}
          >
            Edit pasted text
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={
            disabled ||
            (preview && !stale
              ? selected.length === 0 || emptySecret || limitExceeded
              : input.trim().length === 0)
          }
          onClick={() => {
            if (!preview || stale) review();
            else
              onImport({
                kind: "import",
                entries: selected.map(({ name, kind, value, replace }) => ({
                  name,
                  kind,
                  value,
                  replace,
                })),
              });
          }}
        >
          {saving
            ? "Importing…"
            : preview
              ? stale
                ? "Review again"
                : `Import ${selected.length} ${selected.length === 1 ? "entry" : "entries"}`
              : "Preview import"}
        </Button>
      </div>
    </section>
  );
}
