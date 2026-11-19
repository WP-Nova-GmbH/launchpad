import { matchesWorkflowRepository, workflowRepositoryRemote } from "@t3tools/client-runtime/relay";
import type { WorkflowEditorDraft } from "@t3tools/client-runtime/relay/workflow-session";
import type { RelayRepositoryId, RelayRepositorySummary } from "@t3tools/contracts/relay";
import type { RepositoryWorkflow } from "@t3tools/contracts/workflows";
import { CheckIcon, FolderGit2Icon, GitBranchIcon, MonitorIcon, SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DiscoveryList, DiscoveryListRow } from "../ui/discovery-list";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SelectButton } from "../ui/select";
import { WorkflowAlert } from "./WorkflowAlert";

export function WorkflowCopyDialog({
  source,
  sourceRepositoryId,
  repositories,
  destination,
  existingDraft,
  checkoutIssue,
  onRefreshCheckouts,
  busy,
  error,
  onSelectDestination,
  onClose,
  onCopy,
}: {
  source: RepositoryWorkflow;
  sourceRepositoryId: RelayRepositoryId;
  repositories: ReadonlyArray<RelayRepositorySummary>;
  destination: RelayRepositorySummary | undefined;
  existingDraft: WorkflowEditorDraft | undefined;
  checkoutIssue: "missing" | "unavailable" | null;
  onRefreshCheckouts: () => void;
  busy: boolean;
  error: string | null;
  onSelectDestination: (id: RelayRepositoryId) => void;
  onClose: () => void;
  onCopy: () => void;
}) {
  const [query, setQuery] = useState("");
  const labelId = useId();
  const identityId = useId();
  const selected = destination?.repository;
  const sameRepository = selected?.repositoryId === sourceRepositoryId;
  const retainedDraft = existingDraft?.baseline ? undefined : existingDraft;
  const save = existingDraft?.operation;
  const vm = source.definition.target.kind === "vm";
  const showTargetNote = selected && !sameRepository && !retainedDraft && !save && !checkoutIssue;
  const matches = repositories.filter(({ repository }) =>
    matchesWorkflowRepository(repository, query),
  );
  const identity = (
    <span id={identityId} className="flex min-w-0 items-center gap-2 py-1">
      <FolderGit2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block wrap-anywhere whitespace-normal font-medium">
          {selected?.name ?? "Choose a repository"}
        </span>
        {selected?.canonicalKeys[0] ? (
          <span className="block wrap-anywhere whitespace-normal text-xs text-muted-foreground">
            {selected.canonicalKeys[0]}
          </span>
        ) : null}
      </span>
      {sameRepository ? (
        <span className="max-w-24 shrink-0 whitespace-normal text-right text-xs text-muted-foreground">
          Current repository
        </span>
      ) : null}
    </span>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Copy workflow</DialogTitle>
          <DialogDescription>
            Latest saved version of{" "}
            <strong className="font-medium text-foreground">{source.definition.name}</strong>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div role="group" aria-labelledby={labelId} className="space-y-1.5">
            <p id={labelId} className="text-sm font-medium">
              Destination repository
            </p>
            {repositories.length > 1 || (!selected && repositories.length > 0) ? (
              <Collapsible
                onOpenChange={(open) => {
                  if (!open) setQuery("");
                }}
              >
                <CollapsibleTrigger
                  aria-labelledby={`${labelId} ${identityId}`}
                  disabled={busy}
                  render={<SelectButton />}
                >
                  {identity}
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="space-y-2 pt-2">
                    <InputGroup>
                      <InputGroupAddon>
                        <SearchIcon aria-hidden />
                      </InputGroupAddon>
                      <InputGroupInput
                        type="search"
                        aria-label="Search destination repositories"
                        placeholder="Search by name or remote path"
                        autoComplete="off"
                        spellCheck={false}
                        value={query}
                        disabled={busy}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                      />
                    </InputGroup>
                    <div className="max-h-48 overflow-y-auto">
                      {matches.length ? (
                        <DiscoveryList>
                          {matches.map(({ repository }) => {
                            const current = repository.repositoryId === sourceRepositoryId;
                            const chosen = repository.repositoryId === selected?.repositoryId;
                            return (
                              <DiscoveryListRow
                                key={repository.repositoryId}
                                icon={
                                  <FolderGit2Icon
                                    aria-hidden
                                    className="size-4 shrink-0 text-muted-foreground"
                                  />
                                }
                                title={
                                  <span className="block wrap-anywhere whitespace-normal">
                                    {repository.name}
                                  </span>
                                }
                                description={
                                  <span className="block wrap-anywhere whitespace-normal">
                                    {workflowRepositoryRemote(repository, query)}
                                  </span>
                                }
                                action={
                                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                    {current ? (
                                      <span className="max-w-24 text-right">
                                        Current repository
                                      </span>
                                    ) : null}
                                    {chosen ? (
                                      <CheckIcon aria-hidden className="size-4 text-foreground" />
                                    ) : null}
                                  </span>
                                }
                                aria-pressed={chosen}
                                disabled={busy}
                                onClick={() => onSelectDestination(repository.repositoryId)}
                              />
                            );
                          })}
                        </DiscoveryList>
                      ) : null}
                    </div>
                    <div
                      role="status"
                      className={
                        matches.length ? "sr-only" : "px-1 py-2 text-sm text-muted-foreground"
                      }
                    >
                      {matches.length === 0
                        ? "No repositories match your search."
                        : matches.length === 1
                          ? "1 repository found."
                          : `${matches.length} repositories found.`}
                    </div>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            ) : selected ? (
              <div className="rounded-lg border px-3 py-1 text-sm">{identity}</div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No destination repositories available.
              </p>
            )}
          </div>
          <div role="status" className={showTargetNote ? undefined : "sr-only"}>
            {showTargetNote ? (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                {vm ? (
                  <GitBranchIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <MonitorIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                )}
                {vm
                  ? "The VM draft starts from the destination’s default branch."
                  : "Review the execution target in the destination draft."}
              </p>
            ) : null}
          </div>
          {retainedDraft || save ? (
            <WorkflowAlert title="This repository already has a draft" variant="warning">
              {save?.state === "pending" ? (
                "Wait for the existing draft to finish saving before copying here."
              ) : save ? (
                "Reconcile the existing draft’s save before copying here."
              ) : (
                <>
                  Replacing{" "}
                  <strong className="font-medium">
                    {retainedDraft?.definition.name || "the existing draft"}
                  </strong>{" "}
                  discards its unsaved changes.
                </>
              )}
            </WorkflowAlert>
          ) : selected ? (
            <p className="text-sm text-muted-foreground">
              {sameRepository
                ? "The copy opens as an unsaved draft with automatic triggering off."
                : "Automatic triggering starts off."}
            </p>
          ) : null}
          {checkoutIssue ? (
            <WorkflowAlert
              title={
                checkoutIssue === "missing"
                  ? "Machine checkout required"
                  : "Could not load Machine checkouts"
              }
              variant="warning"
              actions={
                <Button size="sm" variant="outline" disabled={busy} onClick={onRefreshCheckouts}>
                  {checkoutIssue === "missing" ? "Refresh checkouts" : "Retry loading checkouts"}
                </Button>
              }
            >
              {checkoutIssue === "missing"
                ? "Enroll an organization machine with a checkout in the destination repository first."
                : "This workflow needs a Machine checkout in the destination repository."}
            </WorkflowAlert>
          ) : null}
          {error ? <WorkflowAlert title="Could not copy workflow">{error}</WorkflowAlert> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {retainedDraft ? "Keep existing draft" : "Cancel"}
          </Button>
          <Button
            variant={retainedDraft ? "destructive" : "default"}
            disabled={busy || !destination || !!save || !!checkoutIssue}
            onClick={onCopy}
          >
            {busy ? "Reading saved workflow…" : retainedDraft ? "Replace draft" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
