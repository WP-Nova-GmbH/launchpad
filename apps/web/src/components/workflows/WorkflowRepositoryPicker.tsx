import { matchesWorkflowRepository, workflowRepositoryRemote } from "@t3tools/client-runtime/relay";
import type { RelayRepositoryId, RelayRepositorySummary } from "@t3tools/contracts/relay";
import {
  CheckIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { DiscoveryList, DiscoveryListRow } from "../ui/discovery-list";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SelectButton } from "../ui/select";

const noMatches = "No repositories match your search.";

type RepositoryPickerProps = {
  repositories: ReadonlyArray<RelayRepositorySummary>;
  onSelect: (repositoryId: RelayRepositoryId) => void;
};

export function WorkflowRepositoryChooser({
  repositories,
  onSelect,
  canManageRepositories,
  onManageRepositories,
}: RepositoryPickerProps & {
  canManageRepositories: boolean;
  onManageRepositories: () => void;
}) {
  const [query, setQuery] = useState("");
  if (repositories.length === 0) {
    return (
      <div className="grid justify-items-start gap-2 rounded-xl border border-border/70 p-4">
        <FolderGit2Icon aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">
          {canManageRepositories ? "No repositories yet" : "No repositories available"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {canManageRepositories
            ? "Add a repository in Organization settings to create workflows."
            : "Ask an organization admin for access to the repository you need."}
        </p>
        {canManageRepositories ? (
          <div className="mt-1">
            <Button size="sm" onClick={onManageRepositories}>
              <SettingsIcon aria-hidden /> Organization settings
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const matches = repositories.filter(({ repository }) =>
    matchesWorkflowRepository(repository, query),
  );
  return (
    <section className="grid gap-3" aria-label="Choose a repository">
      <h2 className="text-sm font-medium">Choose a repository</h2>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search repositories by name or remote path"
          placeholder="Search repositories"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </InputGroup>
      {matches.length ? (
        <DiscoveryList>
          {matches.map(({ repository }) => (
            <DiscoveryListRow
              key={repository.repositoryId}
              icon={
                <FolderGit2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              }
              title={
                <span className="block wrap-anywhere whitespace-normal">{repository.name}</span>
              }
              description={
                <span className="block wrap-anywhere whitespace-normal">
                  {workflowRepositoryRemote(repository, query)}
                </span>
              }
              action={
                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              }
              onClick={() => onSelect(repository.repositoryId)}
            />
          ))}
        </DiscoveryList>
      ) : null}
      <div role="status">
        {matches.length ? (
          <span className="sr-only">
            {matches.length === 1 ? "1 repository found." : `${matches.length} repositories found.`}
          </span>
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">{noMatches}</p>
        )}
      </div>
    </section>
  );
}

function RepositoryIdentity({
  name,
  remote,
  truncate = false,
  compact = false,
}: {
  name: string;
  remote: string | undefined;
  truncate?: boolean;
  compact?: boolean;
}) {
  const textLayout = truncate ? "truncate" : "wrap-anywhere whitespace-normal";
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className={cn("block text-sm font-medium", textLayout, compact && "leading-4")}>
        {name}
      </span>
      {remote ? (
        <span
          className={cn(
            "block text-xs text-muted-foreground",
            textLayout,
            compact && "leading-3.5",
          )}
        >
          {remote}
        </span>
      ) : null}
    </span>
  );
}

export function WorkflowRepositorySwitcher({
  current,
  repositories,
  onSelect,
  compact = false,
}: RepositoryPickerProps & { current: RelayRepositorySummary; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const { name, canonicalKeys, repositoryId } = current.repository;
  const remote = canonicalKeys[0];
  const identity = (
    <span className={cn("flex min-w-0 items-center gap-2", compact ? "py-0.5" : "py-1")}>
      <FolderGit2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <RepositoryIdentity name={name} remote={remote} truncate compact={compact} />
    </span>
  );
  if (repositories.length < 2) return identity;

  return (
    <Combobox
      items={repositories}
      value={current}
      autoHighlight
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={({ repository }) => repository.name}
      isItemEqualToValue={(option, selected) =>
        option.repository.repositoryId === selected.repository.repositoryId
      }
      filter={({ repository }, search) => matchesWorkflowRepository(repository, search)}
      onValueChange={(option) => {
        if (option && option.repository.repositoryId !== repositoryId) {
          onSelect(option.repository.repositoryId);
        }
      }}
    >
      <ComboboxTrigger
        aria-label={`Switch workflow repository. Current repository is ${name}${remote ? `, ${remote}` : ""}.`}
        render={<SelectButton />}
      >
        {identity}
      </ComboboxTrigger>
      <ComboboxPopup className="w-80">
        <ComboboxSearchInput
          aria-label="Search repositories by name or remote path"
          placeholder="Search repositories"
          autoComplete="off"
          spellCheck={false}
        />
        <ComboboxEmpty>{noMatches}</ComboboxEmpty>
        <ComboboxList>
          {(option: RelayRepositorySummary) => {
            const { repository } = option;
            return (
              <ComboboxItem key={repository.repositoryId} value={option}>
                <FolderGit2Icon aria-hidden />
                <RepositoryIdentity
                  name={repository.name}
                  remote={workflowRepositoryRemote(repository, query)}
                />
                {repository.repositoryId === repositoryId ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <CheckIcon aria-hidden className="size-3" /> Current
                  </span>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
