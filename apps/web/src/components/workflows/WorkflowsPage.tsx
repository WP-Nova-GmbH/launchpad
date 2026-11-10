import type { ReactNode } from "react";
import { WorkflowAlert } from "./WorkflowAlert";
import { useAtomValue } from "@effect/atom-react";
import { workflowTriggerLabel } from "./WorkflowTriggerInspector";
import {
  ArrowLeftIcon,
  CopyIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  CloudIcon,
  MonitorIcon,
  GitBranchIcon,
} from "lucide-react";
import { RepositorySourcesButton } from "./WorkflowSources";
import { ClerkFailed, ClerkLoaded, ClerkLoading, useAuth } from "@clerk/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import {
  RelayRepositoryId,
  type RelayRepositorySummary,
  type RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import type {
  RepositoryWorkflow,
  WorkflowAutomationSummary,
  WorkflowCatalog,
} from "@t3tools/contracts/workflows";
import {
  workflowDraftAtom,
  workflowCatalogRevisionAtom,
  normalizeWorkflowAutomation,
  workflowSessionKey,
  workflowEditorDirty,
  workflowDraftAutomationResolved,
  clearWorkflowScope,
  startNewWorkflowDraft,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useManagedRelayOrganizationCatalog } from "../../cloud/managedRelayState";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { DiscoveryList, DiscoveryListRow } from "../ui/discovery-list";
import { Spinner } from "../ui/spinner";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Select, SelectPopup, SelectTrigger, SelectValue, SelectItem } from "../ui/select";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { WorkflowRun } from "./WorkflowRun";
import { WorkflowJob } from "./WorkflowJob";
import { WorkflowJobs } from "./WorkflowJobs";
import {
  useWorkflowClient,
  useWorkflowDrafts,
  workflowError,
  savedWorkflowDraft,
  newWorkflowDraft,
  copiedWorkflowDraft,
  openNewWorkflowDraft,
  useActiveWorkflowView,
  confirmWorkflow,
  saveWorkflowDraft,
} from "./workflowState";
import { updateWorkflowDrafts } from "@t3tools/client-runtime/relay/workflow-session";

type WorkflowView = "catalog" | "builder" | "run" | "job";

export function WorkflowsPage({ view = "catalog" }: { view?: WorkflowView }) {
  return hasCloudPublicConfig() ? (
    <>
      <ClerkLoading>
        <div className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center">
          <Spinner />
        </div>
      </ClerkLoading>
      <ClerkFailed>
        <WorkflowNotice
          title="Could not load Launchpad Connect sign-in"
          message="Reload Launchpad to try again."
          actions={
            <Button variant="outline" onClick={() => window.location.reload()}>
              Retry
            </Button>
          }
        />
      </ClerkFailed>
      <ClerkLoaded>
        <ConfiguredWorkflowsPage view={view} />
      </ClerkLoaded>
    </>
  ) : (
    <WorkflowNotice
      title="Workflows unavailable"
      message="Launchpad Connect is not configured."
      variant="info"
    />
  );
}

function WorkflowNotice({
  title,
  message,
  actions,
  variant = "error",
}: {
  title: string;
  message: string;
  actions?: ReactNode;
  variant?: "error" | "warning" | "info";
}) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Workflows</h1>
      </WorkspacePageHeader>
      <WorkspacePageContainer>
        <WorkflowAlert
          title={title}
          variant={variant}
          actions={
            actions ?? (
              <Button variant="outline" onClick={() => navigate({ to: "/" })}>
                Back to projects
              </Button>
            )
          }
        >
          {message}
        </WorkflowAlert>
      </WorkspacePageContainer>
    </div>
  );
}

function ConfiguredWorkflowsPage({ view }: { view: WorkflowView }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const catalog = useManagedRelayOrganizationCatalog({ allowMissingProjects: true });
  const { refresh: refreshCatalog } = catalog;
  useEffect(refreshCatalog, [refreshCatalog]);
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const repositoryId = "repositoryId" in params ? params.repositoryId : undefined;
  const entry = catalog.data?.repositories.find(
    (entry) => entry.repository.repositoryId === repositoryId,
  );
  const entryOrganizationId = entry?.repository.organizationId;
  const entryRepositoryId = entry?.repository.repositoryId;
  const scope =
    userId && entryOrganizationId && entryRepositoryId
      ? { accountId: userId, organizationId: entryOrganizationId, repositoryId: entryRepositoryId }
      : null;
  if (
    !isLoaded ||
    (isSignedIn && (catalog.accountId !== userId || (!catalog.data && catalog.isPending)))
  )
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  if (!isSignedIn || !userId)
    return (
      <WorkflowNotice
        title="Sign in to use workflows"
        variant="info"
        message="Sign in to Launchpad Connect to manage repository workflows."
        actions={<Button onClick={() => openAuthPrompt()}>Sign in</Button>}
      />
    );
  if (!catalog.data)
    return (
      <WorkflowNotice
        title={catalog.error ? "Could not load repositories" : "Organization required"}
        variant={catalog.error ? "error" : "info"}
        message={catalog.error ?? "Join or create an organization to use repository workflows."}
        actions={
          <>
            <Button variant="outline" onClick={catalog.refresh}>
              <RefreshCwIcon aria-hidden />
              Refresh
            </Button>
            <Button variant="ghost" onClick={() => navigate({ to: "/settings/organization" })}>
              Organization settings
            </Button>
          </>
        }
      />
    );
  if (repositoryId && !entry)
    return (
      <UnavailableWorkflowRepository
        scope={{
          accountId: userId,
          organizationId: catalog.data.membership.organization.organizationId,
          repositoryId: RelayRepositoryId.make(repositoryId),
        }}
        confirmed={!catalog.isPending && !catalog.error}
      />
    );
  if (!entry || !scope)
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-medium">Workflows</h1>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            <p className="text-sm text-muted-foreground">Choose a repository.</p>
            {catalog.data.repositories.length ? (
              <DiscoveryList>
                {catalog.data.repositories.map(({ repository }) => (
                  <DiscoveryListRow
                    key={repository.repositoryId}
                    icon={
                      <FolderGit2Icon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    }
                    title={repository.name}
                    description={repository.canonicalKeys.join(" · ")}
                    action={
                      <ChevronRightIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    }
                    onClick={() =>
                      void navigate({
                        to: "/workflows/$repositoryId",
                        params: { repositoryId: repository.repositoryId },
                        search: { tab: "workflows" },
                      })
                    }
                  />
                ))}
              </DiscoveryList>
            ) : (
              <p>No repositories available. Add one in Organization settings.</p>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    );
  return (
    <WorkflowRepositoryView
      key={workflowSessionKey(scope, "repository")}
      scope={scope}
      entry={entry}
      repositories={catalog.data.repositories}
      allProjects={catalog.data.projects}
      refreshOrganizationCatalog={refreshCatalog}
      projectsUnavailable={catalog.data.projectsUnavailable === true}
      copyRepositories={catalog.data.repositories.filter(
        (destination) =>
          catalog.data!.membership.role === "admin" || destination.role === "maintainer",
      )}
      projects={catalog.data.projects.filter(
        (project) =>
          project.repositoryCanonicalKey !== null &&
          entry.repository.canonicalKeys.includes(project.repositoryCanonicalKey),
      )}
      canConfigure={catalog.data.membership.role === "admin" || entry.role === "maintainer"}
      view={view}
    />
  );
}

function UnavailableWorkflowRepository({
  scope,
  confirmed,
}: {
  scope: WorkflowScope;
  confirmed: boolean;
}) {
  const { accountId, organizationId, repositoryId } = scope;
  const navigate = useNavigate();
  useEffect(() => {
    if (confirmed) clearWorkflowScope(appAtomRegistry, { accountId, organizationId, repositoryId });
  }, [confirmed, accountId, organizationId, repositoryId]);
  return (
    <WorkflowNotice
      title="Repository unavailable"
      message="This repository is unavailable or you no longer have access."
      actions={
        <>
          <Button variant="outline" onClick={() => navigate({ to: "/workflows" })}>
            Choose a repository
          </Button>
          <Button variant="ghost" onClick={() => navigate({ to: "/settings/organization" })}>
            Organization settings
          </Button>
        </>
      }
    />
  );
}

function WorkflowRepositoryView({
  scope,
  entry,
  repositories,
  allProjects,
  copyRepositories,
  projects,
  projectsUnavailable,
  refreshOrganizationCatalog,
  canConfigure,
  view,
}: {
  scope: WorkflowScope;
  entry: RelayRepositorySummary;
  repositories: ReadonlyArray<RelayRepositorySummary>;
  copyRepositories: ReadonlyArray<RelayRepositorySummary>;
  allProjects: ReadonlyArray<RelayOrganizationProject>;
  projects: ReadonlyArray<RelayOrganizationProject>;
  projectsUnavailable: boolean;
  refreshOrganizationCatalog: () => void;
  canConfigure: boolean;
  view: WorkflowView;
}) {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const tab = "tab" in search && search.tab === "runs" ? "runs" : "workflows";
  const workflowId = "workflowId" in params ? params.workflowId : undefined;
  const jobId = "jobId" in params ? params.jobId : undefined;
  const call = useWorkflowClient(scope);
  const drafts = useWorkflowDrafts();
  const catalogRevision = useAtomValue(workflowCatalogRevisionAtom);
  const [automationSupported, setAutomationSupported] = useState(false);
  const [vmAuthoring, setVmAuthoring] = useState<WorkflowCatalog["vmAuthoring"] | null>(null);
  const [vmExecutionAvailable, setVmExecutionAvailable] = useState(false);
  const [summaries, setSummaries] = useState<ReadonlyArray<WorkflowAutomationSummary>>([]);
  const [listedWorkflows, setWorkflows] = useState<ReadonlyArray<RepositoryWorkflow>>([]);
  const workflows = listedWorkflows.map((workflow) => {
    const baseline = drafts.editors[workflowSessionKey(scope, workflow.workflowId)]?.baseline;
    return baseline && baseline.revision > workflow.revision ? baseline : workflow;
  });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [codexRefreshVersion, setCodexRefreshVersion] = useState(0);
  const active = useActiveWorkflowView();
  const [copy, setCopy] = useState<RepositoryWorkflow | null>(null);
  const [copyDestination, setCopyDestination] = useState<string>(scope.repositoryId);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyRequest = useRef<object | null>(null);
  const copyCatalog = useRef({ allProjects, copyRepositories, vmAuthoring });
  useLayoutEffect(() => {
    copyCatalog.current = { allProjects, copyRepositories, vmAuthoring };
  }, [allProjects, copyRepositories, vmAuthoring]);
  useLayoutEffect(
    () => () => {
      copyRequest.current = null;
    },
    [],
  );
  const closeCopy = () => {
    copyRequest.current = null;
    setCopy(null);
    setCopyBusy(false);
    setCopyError(null);
  };
  const copySaved = async () => {
    if (!copy || copyBusy) return;
    const destination = copyRepositories.find(
      (entry) => entry.repository.repositoryId === copyDestination,
    );
    if (!destination) {
      setCopyError("Choose a repository you can configure.");
      return;
    }
    const request = {};
    copyRequest.current = request;
    setCopyBusy(true);
    setCopyError(null);
    const owns = () => active.current && copyRequest.current === request;
    try {
      const saved = (
        await call((client, token) =>
          client.listWorkflows({ clerkToken: token, repositoryId: scope.repositoryId }),
        )
      ).find((entry) => entry.workflowId === copy.workflowId);
      if (!owns()) return;
      if (!saved) throw new Error("The saved source workflow is no longer available.");
      const destinationScope = { ...scope, repositoryId: destination.repository.repositoryId };
      const readCopyOptions = () => {
        const current = copyCatalog.current;
        const currentDestination = current.copyRepositories.find(
          (entry) => entry.repository.repositoryId === destinationScope.repositoryId,
        );
        if (!currentDestination) throw new Error("Choose a repository you can configure.");
        if (saved.definition.target.kind === "vm" && !current.vmAuthoring)
          throw new Error("Update the relay to copy a VM workflow.");
        return { current, currentDestination };
      };
      readCopyOptions();
      const id = await openNewWorkflowDraft(destinationScope, () => {
        if (!owns()) return null;
        // A draft replacement confirmation can outlive another refresh.
        const { current, currentDestination } = readCopyOptions();
        const targets = current.allProjects.filter(
          (project) =>
            project.repositoryCanonicalKey !== null &&
            currentDestination.repository.canonicalKeys.includes(project.repositoryCanonicalKey),
        );
        return copiedWorkflowDraft(
          saved,
          targets,
          destinationScope.repositoryId === scope.repositoryId,
          !!current.vmAuthoring,
        );
      });
      if (!owns() || !id) return;
      closeCopy();
      void navigate({
        to: "/workflows/$repositoryId/new",
        params: { repositoryId: destinationScope.repositoryId },
      });
    } catch (cause) {
      if (owns()) setCopyError(workflowError(cause));
    } finally {
      if (owns()) {
        copyRequest.current = null;
        setCopyBusy(false);
      }
    }
  };
  const useTemplate = async (template: "review" | "publish") => {
    if (vmAuthoring === null) return;
    try {
      const id = await openNewWorkflowDraft(scope, () =>
        active.current ? newWorkflowDraft(projects, template, !!vmAuthoring) : null,
      );
      if (active.current && id)
        void navigate({
          to: "/workflows/$repositoryId/new",
          params: { repositoryId: scope.repositoryId },
        });
    } catch (cause) {
      if (active.current) setError(workflowError(cause));
    }
  };
  const loadGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const result = await call((client, token) =>
        client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
      );
      if (generation !== loadGeneration.current) return;
      setWorkflows(result.workflows);
      setVmAuthoring(result.vmAuthoring);
      setVmExecutionAvailable(result.vmExecutionAvailable === true);
      setAutomationSupported(result.automationSupported === true);
      setSummaries(result.automationSummaries ?? []);
      setLoaded(true);
      setError(null);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setError(workflowError(cause));
      setLoaded(true);
    }
  }, [call, scope.repositoryId]);
  const refreshView = () => {
    refreshOrganizationCatalog();
    void refresh();
    if (view === "builder") setCodexRefreshVersion((version) => version + 1);
  };
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The relay read settles asynchronously; this effect owns the initial request.
    void refresh();
    const onFocus = () => void refresh();
    if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
    return () => {
      loadGeneration.current++;
      if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Canonical write receipts invalidate the repository catalog, including detached Save completions.
  }, [refresh, catalogRevision]);
  const back = () =>
    navigate({
      to: "/workflows/$repositoryId",
      params: { repositoryId: scope.repositoryId },
      search: { tab: view === "job" ? "runs" : "workflows" },
    });
  const workflow =
    workflows.find((workflow) => workflow.workflowId === workflowId) ??
    (workflowId
      ? (drafts.editors[workflowSessionKey(scope, workflowId)]?.baseline ?? undefined)
      : undefined);
  const archive = async (workflow: RepositoryWorkflow) => {
    const key = workflowSessionKey(scope, workflow.workflowId);
    const existing = appAtomRegistry.get(workflowDraftAtom).editors[key];
    if (existing?.operation?.state === "pending") return;
    if (existing?.operation) {
      await saveWorkflowDraft(
        scope,
        workflow.workflowId,
        (payload) =>
          call((client, token) =>
            client.saveWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
          ),
        undefined,
        {
          automationSupported,
          read: () =>
            call((client, token) =>
              client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
            ),
        },
      );
      if (active.current) void refresh();
      return;
    }
    if (
      existing &&
      workflowEditorDirty(existing) &&
      !(await confirmWorkflow(
        "Discard your unsaved edits before changing this workflow's archive state?",
      ))
    )
      return;
    if (appAtomRegistry.get(workflowDraftAtom).editors[key] !== existing) return;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      editors: { ...state.editors, [key]: savedWorkflowDraft(workflow, automationSupported) },
    }));
    if (
      await saveWorkflowDraft(
        scope,
        workflow.workflowId,
        (payload) =>
          call((client, token) =>
            client.saveWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
          ),
        !workflow.archived,
        {
          automationSupported,
          read: () =>
            call((client, token) =>
              client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
            ),
        },
      )
    )
      refresh();
  };
  const setupTrigger = (workflow: RepositoryWorkflow, enabled?: boolean) => {
    const key = workflowSessionKey(scope, workflow.workflowId);
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const draft = state.editors[key] ?? savedWorkflowDraft(workflow, automationSupported);
      if (
        draft.operation ||
        draft.definition.target.kind === "vm" ||
        workflow.definition.target.kind === "vm"
      )
        return { ...state, editors: { ...state.editors, [key]: { ...draft, triggerSetup: true } } };
      const automation = normalizeWorkflowAutomation(
        workflowDraftAutomationResolved(draft) ? draft.automation : workflow.automation,
      );
      return {
        ...state,
        editors: {
          ...state.editors,
          [key]: {
            ...draft,
            triggerSetup: true,
            ...(!workflowDraftAutomationResolved(draft) &&
            draft.baseline?.revision === workflow.revision
              ? { baseline: workflow }
              : {}),
            automationResolved: true,
            automation: {
              ...automation,
              ...(enabled !== undefined ? { enabled: enabled && !!automation.trigger } : {}),
            },
          },
        },
      };
    });
    void navigate({
      to: "/workflows/$repositoryId/$workflowId/edit",
      params: { repositoryId: scope.repositoryId, workflowId: workflow.workflowId },
    });
  };
  const toggleAutomation = (workflow: RepositoryWorkflow) => {
    if (
      !automationSupported ||
      error ||
      workflow.archived ||
      workflow.definition.target.kind === "vm"
    )
      return;
    const current =
      appAtomRegistry.get(workflowDraftAtom).editors[
        workflowSessionKey(scope, workflow.workflowId)
      ];
    if (
      current?.operation?.state === "pending" ||
      current?.definition.target.kind === "vm" ||
      (current?.baseline && current.baseline.revision > workflow.revision)
    )
      return;
    setupTrigger(workflow, !workflow.automation?.enabled);
  };
  const rows = (archived: boolean) =>
    workflows
      .filter((workflow) => workflow.archived === archived)
      .map((workflow) => {
        const key = workflowSessionKey(scope, workflow.workflowId);
        const local = drafts.editors[key];
        const editorDirty = !!local && workflowEditorDirty(local);
        const runDraft = drafts.runs[key];
        const target = workflow.definition.target;
        const machineProject =
          target.kind === "machine"
            ? projects.find(
                (project) =>
                  project.environmentId === target.environmentId &&
                  project.projectId === target.projectId,
              )
            : undefined;
        const vmUnavailable = target.kind === "vm" && !vmExecutionAvailable;
        const canStartRun = !archived && !vmUnavailable;
        const hasRunSubmission =
          runDraft?.operation?.targetKind === "vm" ||
          (!canStartRun && runDraft?.operation?.state === "uncertain");
        const hasRetainedInstructions = !canStartRun && !!runDraft?.instruction.trim();
        const summary = summaries.find(
          (item) => item.workflowId === workflow.workflowId && item.revision === workflow.revision,
        );
        return (
          <div
            key={workflow.workflowId}
            className="flex flex-wrap items-center justify-between gap-3 border-b py-4 last:border-b-0"
          >
            <div className="min-w-0 flex-1 basis-64 space-y-1 wrap-anywhere">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-medium">{workflow.definition.name}</p>
                {editorDirty ? <span className="text-xs font-medium">Unsaved changes</span> : null}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{workflow.definition.steps.length} steps</span>
                {workflow.definition.target.kind === "vm" ? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <CloudIcon aria-hidden className="size-3.5 shrink-0" />
                      VM
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
                      <span>
                        <span className="sr-only">Base branch: </span>
                        {workflow.definition.target.baseBranch ?? "Repository default"}
                      </span>
                    </span>
                  </>
                ) : machineProject ? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
                      {machineProject.machineLabel}
                    </span>
                    <span>{machineProject.title}</span>
                  </>
                ) : (
                  <span>
                    {projectsUnavailable
                      ? "Machine target not verified"
                      : "Machine target unavailable"}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{workflowTriggerLabel(workflow.automation?.trigger)}</span>
                {canConfigure ? <span>Trigger changes apply after Save.</span> : null}
                <span>
                  {automationSupported
                    ? `Automatic triggering ${summary?.state === "on" ? "On" : summary?.state === "off" ? "Off" : summary?.state === "needs_attention" ? "needs attention" : "state unavailable"}`
                    : "Automation state unavailable on this relay"}
                </span>
              </div>
              {summary?.reason || local?.error ? (
                <div className="mt-2">
                  <WorkflowAlert
                    title={
                      local?.error
                        ? "Workflow change not confirmed"
                        : "Automatic triggering needs attention"
                    }
                    variant={local?.error ? "error" : "warning"}
                    actions={
                      canConfigure ? (
                        <Button variant="outline" size="sm" onClick={() => setupTrigger(workflow)}>
                          Review workflow settings
                        </Button>
                      ) : undefined
                    }
                  >
                    {local?.error ?? summary?.reason}
                  </WorkflowAlert>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {canConfigure &&
              automationSupported &&
              !archived &&
              workflow.definition.target.kind === "machine" &&
              local?.definition.target.kind !== "vm" ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Turn automatic triggering ${workflow.automation?.enabled ? "off" : "on"} for ${workflow.definition.name}`}
                  disabled={
                    !!error ||
                    !summary ||
                    local?.operation?.state === "pending" ||
                    (!!local?.baseline && local.baseline.revision > workflow.revision)
                  }
                  onClick={() => void toggleAutomation(workflow)}
                >
                  {local?.operation?.state === "pending"
                    ? "Saving…"
                    : local?.operation
                      ? "Retry"
                      : workflow.automation?.enabled
                        ? "Turn Off"
                        : "Turn On"}
                </Button>
              ) : null}
              {canConfigure &&
              automationSupported &&
              (summary?.state === "needs_attention" || local?.error) ? (
                <Button variant="ghost" size="sm" onClick={() => setupTrigger(workflow)}>
                  Trigger settings
                </Button>
              ) : null}
              {copyRepositories.length &&
              (workflow.definition.target.kind === "machine" || vmAuthoring) ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCopyDestination(
                      copyRepositories.some(
                        (entry) => entry.repository.repositoryId === scope.repositoryId,
                      )
                        ? scope.repositoryId
                        : copyRepositories[0]!.repository.repositoryId,
                    );
                    setCopyError(null);
                    setCopy(workflow);
                  }}
                >
                  <CopyIcon /> Copy
                </Button>
              ) : null}
              {canConfigure ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size={editorDirty ? "default" : "icon"}
                        aria-label={`${editorDirty ? "Resume editing" : "Edit"} ${workflow.definition.name}`}
                        onClick={() =>
                          navigate({
                            to: "/workflows/$repositoryId/$workflowId/edit",
                            params: {
                              repositoryId: scope.repositoryId,
                              workflowId: workflow.workflowId,
                            },
                          })
                        }
                      />
                    }
                  >
                    <PencilIcon aria-hidden />
                    {editorDirty ? "Resume editing" : null}
                  </TooltipTrigger>
                  <TooltipPopup>{editorDirty ? "Resume editing" : "Edit workflow"}</TooltipPopup>
                </Tooltip>
              ) : null}
              {archived ? (
                canConfigure ? (
                  <Button
                    variant="outline"
                    disabled={local?.operation?.state === "pending"}
                    onClick={() => void archive(workflow)}
                  >
                    {local?.operation ? "Retry save" : "Restore"}
                  </Button>
                ) : null
              ) : null}
              {!archived && vmUnavailable && !hasRunSubmission && !hasRetainedInstructions ? (
                <span className="self-center text-xs text-muted-foreground">
                  VM execution unavailable
                </span>
              ) : null}
              {hasRunSubmission || canStartRun || hasRetainedInstructions ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    navigate({
                      to: "/workflows/$repositoryId/$workflowId/run",
                      params: { repositoryId: scope.repositoryId, workflowId: workflow.workflowId },
                    })
                  }
                >
                  {hasRunSubmission || hasRetainedInstructions ? (
                    <ChevronRightIcon aria-hidden />
                  ) : (
                    <PlayIcon aria-hidden />
                  )}
                  {hasRunSubmission
                    ? "View run submission"
                    : hasRetainedInstructions
                      ? "View retained instructions"
                      : "Run"}
                </Button>
              ) : null}
            </div>
          </div>
        );
      });
  if (view === "builder")
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Back to workflows"
              onClick={back}
            >
              <ArrowLeftIcon />
            </Button>
            <div className="min-w-0 flex-1 max-w-64">
              <Select
                value={scope.repositoryId}
                onValueChange={(id) => {
                  if (id)
                    void navigate({
                      to: "/workflows/$repositoryId",
                      params: { repositoryId: id },
                      search: { tab },
                    });
                }}
              >
                <SelectTrigger aria-label="Workflow repository">
                  <SelectValue>{entry.repository.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {repositories.map((entry) => (
                    <SelectItem
                      key={entry.repository.repositoryId}
                      value={entry.repository.repositoryId}
                    >
                      {entry.repository.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Refresh workflows"
                    onClick={refreshView}
                  />
                }
              >
                <RefreshCwIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>Refresh workflows</TooltipPopup>
            </Tooltip>
          </div>
        </WorkspacePageHeader>
        {error ? (
          <div className="px-4 py-2">
            <WorkflowAlert
              title="Could not refresh workflows"
              actions={
                <Button variant="outline" size="sm" onClick={refreshView}>
                  Retry
                </Button>
              }
            >
              {error} Showing the last available data. Your edits are kept.
            </WorkflowAlert>
          </div>
        ) : null}
        {!loaded ? (
          <Spinner />
        ) : !workflowId && vmAuthoring === null ? (
          <p className="px-4 py-2 text-sm text-muted-foreground">
            Refresh the workflow catalog before creating a workflow.
          </p>
        ) : (
          <WorkflowBuilder
            scope={scope}
            automationSupported={automationSupported}
            automationReason={
              summaries.find(
                (item) =>
                  item.workflowId === workflow?.workflowId && item.revision === workflow?.revision,
              )?.reason
            }
            workflow={workflow}
            workflowId={workflowId}
            isNew={!workflowId}
            projects={projects}
            projectsUnavailable={projectsUnavailable}
            vmAuthoring={vmAuthoring ?? undefined}
            vmExecutionAvailable={vmExecutionAvailable}
            codexRefreshVersion={codexRefreshVersion}
            canConfigure={canConfigure}
            call={call}
            refresh={refresh}
          />
        )}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {copy ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeCopy();
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Copy workflow</DialogTitle>
              <DialogDescription>
                Copy the latest saved version into an independent, unsaved draft. Your source edits
                and run history stay here.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Select
                value={copyDestination}
                onValueChange={(id) => {
                  if (id) setCopyDestination(id);
                }}
                disabled={copyBusy}
              >
                <SelectTrigger aria-label="Copy destination repository">
                  <SelectValue>
                    {copyRepositories.find(
                      (entry) => entry.repository.repositoryId === copyDestination,
                    )?.repository.name ?? "Choose a repository"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {copyRepositories.map((entry) => (
                    <SelectItem
                      key={entry.repository.repositoryId}
                      value={entry.repository.repositoryId}
                    >
                      {entry.repository.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {copyError ? (
                <WorkflowAlert
                  title="Could not copy workflow"
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={copyBusy}
                      onClick={() => void copySaved()}
                    >
                      Retry copy
                    </Button>
                  }
                >
                  {copyError}
                </WorkflowAlert>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" onClick={closeCopy}>
                Cancel
              </Button>
              <Button disabled={copyBusy} onClick={() => void copySaved()}>
                {copyBusy ? "Reading saved workflow…" : "Copy saved workflow"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Workflows</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="expanded">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {view !== "catalog" ? (
                <Button variant="ghost" onClick={back}>
                  ← Workflows
                </Button>
              ) : null}
              <div className="w-64 max-w-full">
                <Select
                  value={scope.repositoryId}
                  onValueChange={(id) => {
                    if (id)
                      void navigate({
                        to: "/workflows/$repositoryId",
                        params: { repositoryId: id },
                        search: { tab },
                      });
                  }}
                >
                  <SelectTrigger aria-label="Workflow repository">
                    <SelectValue>{entry.repository.name}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {repositories.map((entry) => (
                      <SelectItem
                        key={entry.repository.repositoryId}
                        value={entry.repository.repositoryId}
                      >
                        {entry.repository.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            {view !== "catalog" || tab !== "runs" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Refresh workflows"
                      onClick={refreshView}
                    />
                  }
                >
                  <RefreshCwIcon aria-hidden />
                </TooltipTrigger>
                <TooltipPopup>Refresh workflows</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          {error ? (
            <WorkflowAlert
              title="Could not refresh workflows"
              actions={
                <Button variant="outline" size="sm" onClick={refreshView}>
                  Retry
                </Button>
              }
            >
              {error} Showing the last available data.
            </WorkflowAlert>
          ) : null}
          {!loaded ? (
            <Spinner />
          ) : view === "run" ? (
            workflow ? (
              <WorkflowRun
                scope={scope}
                workflow={workflow}
                projects={projects}
                call={call}
                vmExecutionAvailable={vmExecutionAvailable}
              />
            ) : (
              <WorkflowAlert
                title="Workflow unavailable"
                actions={
                  <>
                    <Button variant="outline" onClick={refreshView}>
                      <RefreshCwIcon aria-hidden />
                      Refresh workflows
                    </Button>
                    <Button variant="ghost" onClick={back}>
                      Back to workflows
                    </Button>
                  </>
                }
              >
                This workflow may have been removed or your access may have changed. Refresh or
                return to the list.
              </WorkflowAlert>
            )
          ) : view === "job" && jobId ? (
            <WorkflowJob
              scope={scope}
              jobId={jobId}
              projects={projects}
              canConfigure={canConfigure}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-2" role="tablist" aria-label="Workflow catalog">
                  <Button
                    role="tab"
                    aria-selected={tab === "workflows"}
                    variant={tab === "workflows" ? "secondary" : "ghost"}
                    onClick={() =>
                      navigate({
                        to: "/workflows/$repositoryId",
                        params: { repositoryId: scope.repositoryId },
                        search: { tab: "workflows" },
                      })
                    }
                  >
                    Workflows
                  </Button>
                  <Button
                    role="tab"
                    aria-selected={tab === "runs"}
                    variant={tab === "runs" ? "secondary" : "ghost"}
                    onClick={() =>
                      navigate({
                        to: "/workflows/$repositoryId",
                        params: { repositoryId: scope.repositoryId },
                        search: { tab: "runs" },
                      })
                    }
                  >
                    Runs
                  </Button>
                </div>
                {canConfigure && tab === "workflows" ? (
                  <div className="flex flex-wrap gap-2">
                    <RepositorySourcesButton repositoryId={scope.repositoryId} />
                    <Menu>
                      <MenuTrigger
                        render={<Button variant="outline" disabled={vmAuthoring === null} />}
                      >
                        Use template <ChevronDownIcon />
                      </MenuTrigger>
                      <MenuPopup>
                        <MenuItem onClick={() => void useTemplate("review")}>
                          Agent → Review
                        </MenuItem>
                        <MenuItem
                          disabled={!projects.length}
                          onClick={() => void useTemplate("publish")}
                        >
                          Reviewed implementation → PR (Machine)
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                    <Button
                      disabled={vmAuthoring === null}
                      onClick={() => {
                        if (vmAuthoring === null) return;
                        startNewWorkflowDraft(
                          appAtomRegistry,
                          scope,
                          () => newWorkflowDraft(projects, "review", !!vmAuthoring),
                          true,
                        );
                        navigate({
                          to: "/workflows/$repositoryId/new",
                          params: { repositoryId: scope.repositoryId },
                        });
                      }}
                    >
                      {drafts.newWorkflowIds[workflowSessionKey(scope, "new")] &&
                      !drafts.editors[
                        workflowSessionKey(
                          scope,
                          drafts.newWorkflowIds[workflowSessionKey(scope, "new")]!,
                        )
                      ]?.baseline
                        ? "Resume new workflow"
                        : "Create workflow"}
                    </Button>
                  </div>
                ) : null}
              </div>
              {tab === "workflows" ? (
                <div>
                  {rows(false)}
                  {!workflows.some((workflow) => !workflow.archived) ? (
                    <p className="py-6 text-sm text-muted-foreground">No workflows yet.</p>
                  ) : null}
                  {workflows.some((workflow) => workflow.archived) ? (
                    <details className="mt-6">
                      <summary className="cursor-pointer text-sm text-muted-foreground">
                        Archived workflows
                      </summary>
                      {rows(true)}
                    </details>
                  ) : null}
                </div>
              ) : (
                <WorkflowJobs scope={scope} workflows={workflows} refreshWorkflows={refresh} />
              )}
            </>
          )}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
