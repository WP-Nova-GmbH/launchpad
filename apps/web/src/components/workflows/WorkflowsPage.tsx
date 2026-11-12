import type { ReactNode } from "react";
import { WorkflowAlert } from "./WorkflowAlert";
import { useAtomValue } from "@effect/atom-react";
import { workflowTriggerLabel } from "./WorkflowTriggerInspector";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CopyIcon,
  EllipsisIcon,
  ChevronRightIcon,
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
  replaceNewWorkflowDraft,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useManagedRelayOrganizationCatalog } from "../../cloud/managedRelayState";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Spinner } from "../ui/spinner";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { WorkflowCopyDialog } from "./WorkflowCopyDialog";
import { WorkflowCatalogEmpty, WorkflowTemplateDialog } from "./WorkflowTemplateDialog";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { WorkflowRun } from "./WorkflowRun";
import { WorkflowJob } from "./WorkflowJob";
import { WorkflowJobs } from "./WorkflowJobs";
import { WorkflowRepositoryChooser, WorkflowRepositorySwitcher } from "./WorkflowRepositoryPicker";
import {
  useWorkflowClient,
  useWorkflowDrafts,
  workflowError,
  savedWorkflowDraft,
  restoreCheckoutIssue,
  newWorkflowDraft,
  copiedWorkflowDraft,
  workflowCopyNeedsCheckout,
  workflowTemplateNeedsCheckout,
  type WorkflowTemplate,
  openNewWorkflowDraft,
  useActiveWorkflowView,
  confirmWorkflow,
  saveWorkflowDraft,
} from "./workflowState";
import { updateWorkflowDrafts } from "@t3tools/client-runtime/relay/workflow-session";

type WorkflowView = "catalog" | "builder" | "run" | "job";

// Create and Edit share the mounted editor when the first save promotes the route.
export function WorkflowEditorPage() {
  return <WorkflowsPage view="builder" />;
}

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
  const emptyChooser = !repositoryId && catalog.data?.repositories.length === 0;
  if (
    !isLoaded ||
    (isSignedIn &&
      (catalog.accountId !== userId || (catalog.isPending && (!catalog.data || emptyChooser))))
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
  if (!catalog.data || (emptyChooser && catalog.error))
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
            <WorkflowRepositoryChooser
              key={catalog.data.membership.organization.organizationId}
              repositories={catalog.data.repositories}
              canManageRepositories={catalog.data.membership.role === "admin"}
              onManageRepositories={() => {
                void navigate({
                  to: "/settings/organization",
                  hash: searchableSetting("organization-repositories").id,
                });
              }}
              onSelect={(repositoryId) => {
                void navigate({
                  to: "/workflows/$repositoryId",
                  params: { repositoryId },
                  search: { tab: "workflows" },
                });
              }}
            />
          </WorkspacePageContainer>
        </div>
      </div>
    );
  const { membership } = catalog.data;
  const organizationAdmin =
    membership.userId === scope.accountId &&
    membership.organization.organizationId === scope.organizationId &&
    membership.role === "admin";
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
      organizationAdmin={organizationAdmin}
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

function workflowCopyCheckouts(
  projects: ReadonlyArray<RelayOrganizationProject>,
  destination: RelayRepositorySummary,
) {
  return projects.filter(
    (project) =>
      project.repositoryCanonicalKey !== null &&
      destination.repository.canonicalKeys.includes(project.repositoryCanonicalKey),
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
  organizationAdmin,
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
  organizationAdmin: boolean;
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
  const [vmAutomationAvailable, setVmAutomationAvailable] = useState(false);
  const [vmAuthoring, setVmAuthoring] = useState<WorkflowCatalog["vmAuthoring"] | null>(null);
  const [vmExecutionAvailable, setVmExecutionAvailable] = useState(false);
  const [summaries, setSummaries] = useState<ReadonlyArray<WorkflowAutomationSummary>>([]);
  const [listedWorkflows, setWorkflows] = useState<ReadonlyArray<RepositoryWorkflow>>([]);
  const workflows = listedWorkflows.map((workflow) => {
    const baseline = drafts.editors[workflowSessionKey(scope, workflow.workflowId)]?.baseline;
    return baseline && baseline.revision > workflow.revision ? baseline : workflow;
  });
  const archivedWorkflows = workflows.filter((workflow) => workflow.archived);
  const archivedOnly =
    archivedWorkflows.length > 0 && archivedWorkflows.length === workflows.length;
  const [archiveExpanded, setArchiveExpanded] = useState<boolean | null>(null);
  const archiveOpen = archiveExpanded ?? archivedOnly;
  const [restoreNotice, setRestoreNotice] = useState("");
  const [restoreFocusId, setRestoreFocusId] = useState<string | null>(null);
  const restoreFocus = useRef<HTMLButtonElement | null>(null);
  const restoredWorkflowEdit = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [codexRefreshVersion, setCodexRefreshVersion] = useState(0);
  const active = useActiveWorkflowView();
  const canChooseTemplate = canConfigure && view === "catalog" && tab === "workflows";
  useLayoutEffect(() => {
    if (!restoreFocusId) return;
    const source = restoreFocus.current;
    restoreFocus.current = null;
    if (!source || !canChooseTemplate) return;
    const { activeElement, body } = source.ownerDocument;
    if (activeElement === source || activeElement === body) restoredWorkflowEdit.current?.focus();
  }, [restoreFocusId, canChooseTemplate]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const templateRequest = useRef<object | null>(null);
  const closeTemplates = useCallback(() => {
    templateRequest.current = null;
    setTemplateOpen(false);
    setTemplateBusy(false);
    setTemplateError(null);
  }, []);
  const templateCatalog = useRef({ canChooseTemplate, projects, projectsUnavailable, vmAuthoring });
  useLayoutEffect(() => {
    templateCatalog.current = { canChooseTemplate, projects, projectsUnavailable, vmAuthoring };
    // oxlint-disable-next-line react/set-state-in-effect -- Cancel pending confirmation when its catalog view loses ownership.
    if (!canChooseTemplate && templateOpen) closeTemplates();
  }, [canChooseTemplate, projects, projectsUnavailable, vmAuthoring, templateOpen, closeTemplates]);
  const newWorkflowSlot = workflowSessionKey(scope, "new");
  const newWorkflowId = drafts.newWorkflowIds[newWorkflowSlot];
  const newWorkflow = newWorkflowId
    ? drafts.editors[workflowSessionKey(scope, newWorkflowId)]
    : undefined;
  const retainedDraft = newWorkflow?.baseline ? undefined : newWorkflow;
  const retainedDraftRecovery =
    canConfigure && retainedDraft && vmAuthoring === null
      ? "Your draft is kept. Retry to load workflow settings before resuming it."
      : null;
  const firstWorkflow = loaded && !error && workflows.length === 0;
  const [copy, setCopy] = useState<RepositoryWorkflow | null>(null);
  const listedCopySource =
    copy && workflows.find((workflow) => workflow.workflowId === copy.workflowId);
  const copySource =
    copy && listedCopySource && listedCopySource.revision > copy.revision ? listedCopySource : copy;
  const [copyDestination, setCopyDestination] = useState<RelayRepositoryId>(scope.repositoryId);
  const copyDestinationScope = { ...scope, repositoryId: copyDestination };
  const copyRepository = copyRepositories.find(
    (entry) => entry.repository.repositoryId === copyDestination,
  );
  const copyCheckoutIssue =
    copySource &&
    copyRepository &&
    workflowCopyNeedsCheckout(copySource, !!vmAuthoring) &&
    workflowCopyCheckouts(allProjects, copyRepository).length === 0
      ? projectsUnavailable
        ? "unavailable"
        : "missing"
      : null;
  const copyDraftId = drafts.newWorkflowIds[workflowSessionKey(copyDestinationScope, "new")];
  const copyDraft =
    copyRepository && copyDraftId
      ? drafts.editors[workflowSessionKey(copyDestinationScope, copyDraftId)]
      : undefined;
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyRequest = useRef<object | null>(null);
  const copyCatalog = useRef({
    allProjects,
    copyRepositories,
    copySource,
    vmAuthoring,
  });
  useLayoutEffect(() => {
    copyCatalog.current = {
      allProjects,
      copyRepositories,
      copySource,
      vmAuthoring,
    };
  }, [allProjects, copyRepositories, copySource, vmAuthoring]);
  useLayoutEffect(
    () => () => {
      copyRequest.current = null;
      templateRequest.current = null;
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
    if (!copySource || copyRequest.current || copyDraft?.operation || copyCheckoutIssue) return;
    if (!copyRepository) {
      setCopyError("Choose a repository you can configure.");
      return;
    }
    // A replacement only authorizes the draft shown when the user pressed the button.
    const expectedDraft = copyDraft;
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
      ).find((entry) => entry.workflowId === copySource.workflowId);
      if (!owns()) return;
      if (!saved) throw new Error("The saved source workflow is no longer available.");
      const current = copyCatalog.current;
      if (saved.revision < (current.copySource?.revision ?? copySource.revision))
        throw new Error("The saved workflow changed while loading. Try again.");
      setCopy(saved);
      if (saved.definition.target.kind !== copySource.definition.target.kind)
        throw new Error(
          "The saved workflow’s execution target changed. Review the copy before continuing.",
        );
      const currentDestination = current.copyRepositories.find(
        (entry) => entry.repository.repositoryId === copyDestination,
      );
      if (!currentDestination) throw new Error("Choose a repository you can configure.");
      if (saved.definition.target.kind === "vm" && !current.vmAuthoring)
        throw new Error("Update the relay to copy a VM workflow.");
      const targets = workflowCopyCheckouts(current.allProjects, currentDestination);
      // The dialog will show the checkout requirement for the newly read source and catalog.
      if (workflowCopyNeedsCheckout(saved, !!current.vmAuthoring) && targets.length === 0) return;
      const draft = copiedWorkflowDraft(
        saved,
        targets,
        copyDestination === scope.repositoryId,
        !!current.vmAuthoring,
      );
      if (!draft) throw new Error("Could not prepare a draft for the destination repository.");
      if (!replaceNewWorkflowDraft(appAtomRegistry, copyDestinationScope, expectedDraft, draft))
        throw new Error(
          "The destination draft changed while copying. Review it before continuing.",
        );
      closeCopy();
      void navigate({
        to: "/workflows/$repositoryId/new",
        params: { repositoryId: copyDestination },
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
  const openDraft = () =>
    void navigate({
      to: "/workflows/$repositoryId/new",
      params: { repositoryId: scope.repositoryId },
    });
  const resumeDraft = () => {
    const state = appAtomRegistry.get(workflowDraftAtom);
    const currentId = state.newWorkflowIds[newWorkflowSlot];
    const current = currentId ? state.editors[workflowSessionKey(scope, currentId)] : undefined;
    if (
      templateCatalog.current.canChooseTemplate &&
      templateCatalog.current.vmAuthoring !== null &&
      state.accountId === scope.accountId &&
      current === retainedDraft &&
      current &&
      !current.baseline
    )
      openDraft();
  };
  const openTemplates = () => {
    setTemplateError(null);
    setTemplateOpen(true);
  };
  const useTemplate = async (template: WorkflowTemplate) => {
    if (!canChooseTemplate || vmAuthoring === null || templateRequest.current) return;
    const request = {};
    templateRequest.current = request;
    setTemplateBusy(true);
    setTemplateError(null);
    const owns = () => active.current && templateRequest.current === request;
    try {
      const id = await openNewWorkflowDraft(scope, () => {
        const current = templateCatalog.current;
        if (!owns() || !current.canChooseTemplate || current.vmAuthoring === null) return null;
        if (
          workflowTemplateNeedsCheckout(template, !!current.vmAuthoring) &&
          !current.projects.length
        )
          throw new Error(
            current.projectsUnavailable
              ? "Machine checkouts could not be loaded. Retry loading checkouts."
              : "This template requires a Machine checkout in this repository.",
          );
        return newWorkflowDraft(current.projects, template, !!current.vmAuthoring);
      });
      if (!owns() || !templateCatalog.current.canChooseTemplate || !id) return;
      closeTemplates();
      openDraft();
    } catch (cause) {
      if (owns() && templateCatalog.current.canChooseTemplate)
        setTemplateError(workflowError(cause));
    } finally {
      if (owns()) {
        templateRequest.current = null;
        setTemplateBusy(false);
      }
    }
  };
  const creationActions = canChooseTemplate ? (
    <div className="flex flex-wrap gap-2">
      {retainedDraft && !retainedDraft.operation ? (
        <Button variant="outline" disabled={vmAuthoring === null} onClick={openTemplates}>
          Start another workflow
        </Button>
      ) : null}
      <Button disabled={vmAuthoring === null} onClick={retainedDraft ? resumeDraft : openTemplates}>
        {retainedDraft ? "Resume new workflow" : "Create workflow"}
      </Button>
    </div>
  ) : null;
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
      setVmAutomationAvailable(result.vmAutomationAvailable === true);
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
  const selectRepository = (repositoryId: RelayRepositoryId) => {
    void navigate({
      to: "/workflows/$repositoryId",
      params: { repositoryId },
      search: { tab },
    });
  };
  const workflow =
    workflows.find((workflow) => workflow.workflowId === workflowId) ??
    (workflowId
      ? (drafts.editors[workflowSessionKey(scope, workflowId)]?.baseline ?? undefined)
      : undefined);
  const restore = async (workflow: RepositoryWorkflow, button: HTMLButtonElement) => {
    const hadFocus = button.ownerDocument.activeElement === button;
    const key = workflowSessionKey(scope, workflow.workflowId);
    const state = appAtomRegistry.get(workflowDraftAtom);
    const existing = state.editors[key];
    if (state.accountId !== scope.accountId || existing?.operation?.state === "pending") return;
    const canRestore = () => {
      const catalog = templateCatalog.current;
      return (
        active.current &&
        catalog.canChooseTemplate &&
        (!!existing?.operation ||
          !restoreCheckoutIssue(workflow, catalog.projects, catalog.projectsUnavailable))
      );
    };
    if (!canRestore()) return;
    if (!existing?.operation) {
      if (
        existing &&
        workflowEditorDirty(existing) &&
        !(await confirmWorkflow("Discard your unsaved edits before restoring this workflow?"))
      )
        return;
      const current = appAtomRegistry.get(workflowDraftAtom);
      if (
        !canRestore() ||
        current.accountId !== scope.accountId ||
        current.editors[key] !== existing
      )
        return;
      updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
        ...state,
        editors: { ...state.editors, [key]: savedWorkflowDraft(workflow, automationSupported) },
      }));
    }
    if (hadFocus) {
      restoreFocus.current = button;
      setRestoreFocusId(null);
    }
    setRestoreNotice("");
    const saved = await saveWorkflowDraft(
      scope,
      workflow.workflowId,
      (payload) =>
        call((client, token) =>
          client.saveWorkflow({ clerkToken: token, repositoryId: scope.repositoryId, payload }),
        ),
      existing?.operation ? undefined : false,
      {
        automationSupported,
        read: () =>
          call((client, token) =>
            client.readWorkflowCatalog({ clerkToken: token, repositoryId: scope.repositoryId }),
          ),
      },
    );
    if (!active.current) return;
    if (saved && !saved.archived) {
      setArchiveExpanded((expanded) => expanded ?? true);
      if (hadFocus && restoreFocus.current === button) setRestoreFocusId(saved.workflowId);
      setRestoreNotice(`${saved.definition.name} restored. Automatic triggering is off.`);
    } else if (restoreFocus.current === button) {
      restoreFocus.current = null;
    }
    if (saved || existing?.operation) void refresh();
    if (!saved) refreshOrganizationCatalog();
  };
  const canEnableTarget = (
    workflow: RepositoryWorkflow,
    draft?: RepositoryWorkflow["definition"],
  ) =>
    vmAutomationAvailable ||
    (workflow.definition.target.kind === "machine" && draft?.target.kind !== "vm");
  const setupTrigger = (workflow: RepositoryWorkflow, enabled?: boolean) => {
    const key = workflowSessionKey(scope, workflow.workflowId);
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => {
      const draft = state.editors[key] ?? savedWorkflowDraft(workflow, automationSupported);
      if (draft.operation || (enabled !== false && !canEnableTarget(workflow, draft.definition)))
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
    if (!automationSupported || error || workflow.archived) return;
    const current =
      appAtomRegistry.get(workflowDraftAtom).editors[
        workflowSessionKey(scope, workflow.workflowId)
      ];
    if (
      current?.operation?.state === "pending" ||
      (!workflow.automation?.enabled && !canEnableTarget(workflow, current?.definition)) ||
      (current?.baseline && current.baseline.revision > workflow.revision)
    )
      return;
    setupTrigger(workflow, !workflow.automation?.enabled);
  };
  const rows = (archived: boolean) => {
    const entries = workflows.filter((workflow) => workflow.archived === archived);
    if (!entries.length) return null;

    return (
      <div className="grid gap-x-4 @min-[34rem]/workflow-catalog:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_12rem]">
        <div
          aria-hidden
          className="col-span-full hidden grid-cols-subgrid border-b pb-2 text-xs text-muted-foreground @min-[34rem]/workflow-catalog:grid"
        >
          <span>Workflow</span>
          <span>Trigger</span>
        </div>
        <ul
          role="list"
          aria-label={archived ? "Archived workflows" : "Workflows"}
          className="col-span-full grid grid-cols-subgrid"
        >
          {entries.map((workflow) => {
            const key = workflowSessionKey(scope, workflow.workflowId);
            const local = drafts.editors[key];
            const editorDirty = !!local && workflowEditorDirty(local);
            const runDraft = drafts.runs[key];
            const { name, steps, target } = workflow.definition;
            const machineProject =
              target.kind === "machine"
                ? projects.find(
                    (project) =>
                      project.environmentId === target.environmentId &&
                      project.projectId === target.projectId,
                  )
                : undefined;
            const restoreIssue =
              archived && restoreCheckoutIssue(workflow, projects, projectsUnavailable);
            const restoreBlocked = !!restoreIssue && !local?.operation;
            const canRecoverInVm =
              restoreIssue === "missing" &&
              projects.length === 0 &&
              !!vmAuthoring &&
              vmExecutionAvailable &&
              !steps.some((step) => step.kind === "action");
            const restoreHint = `workflow-restore-${workflow.workflowId}`;
            const vmUnavailable = target.kind === "vm" && !vmExecutionAvailable;
            const canStartRun = !archived && !vmUnavailable;
            const hasRunSubmission =
              runDraft?.operation?.targetKind === "vm" ||
              (!canStartRun && runDraft?.operation?.state === "uncertain");
            const hasRetainedInstructions = !canStartRun && !!runDraft?.instruction.trim();
            const runLabel = hasRunSubmission
              ? "View run submission"
              : hasRetainedInstructions
                ? "View retained instructions"
                : "Run";
            const summary = summaries.find(
              (item) =>
                item.workflowId === workflow.workflowId && item.revision === workflow.revision,
            );
            const trigger = workflow.automation?.trigger;
            const triggerState = automationSupported ? summary?.state : undefined;
            const triggerLabel = archived
              ? trigger
                ? "Automatic triggering off"
                : "Manual run"
              : !automationSupported
                ? "Automation state unavailable on this relay"
                : triggerState === "on"
                  ? "Automatic"
                  : triggerState === "off"
                    ? trigger
                      ? "Automatic triggering off"
                      : "Manual run"
                    : triggerState === "needs_attention"
                      ? "Needs attention"
                      : "Automation state unavailable";
            const triggerIssue = local?.error ?? summary?.reason;
            const canToggle =
              canConfigure &&
              automationSupported &&
              !archived &&
              (!!workflow.automation?.enabled || canEnableTarget(workflow, local?.definition));
            const canCopy =
              copyRepositories.length > 0 && (target.kind === "machine" || !!vmAuthoring);

            return (
              <li
                key={workflow.workflowId}
                className="col-span-full grid grid-cols-subgrid items-start gap-y-3 border-b py-3 last:border-b-0"
              >
                <div className="min-w-0 space-y-1 wrap-anywhere">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <p className="text-sm font-medium">{name}</p>
                    {editorDirty ? (
                      <span className="text-xs text-muted-foreground">Unsaved changes</span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {steps.length} {steps.length === 1 ? "step" : "steps"}
                    </span>
                    {target.kind === "vm" ? (
                      <>
                        <span className="inline-flex items-center gap-1.5">
                          <CloudIcon aria-hidden className="size-3.5 shrink-0" />
                          VM
                        </span>
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
                          <span>
                            <span className="sr-only">Base branch: </span>
                            {target.baseBranch ?? "Repository default"}
                          </span>
                        </span>
                      </>
                    ) : machineProject ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
                        <span>
                          {machineProject.machineLabel} / {machineProject.title}
                        </span>
                      </span>
                    ) : canConfigure && restoreBlocked ? (
                      <span className="inline-flex items-center gap-1.5">
                        <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
                        Machine
                      </span>
                    ) : (
                      <span>
                        {projectsUnavailable
                          ? "Machine target not verified"
                          : "Machine target unavailable"}
                      </span>
                    )}
                  </div>
                  {!archived && vmUnavailable && !hasRunSubmission && !hasRetainedInstructions ? (
                    <p className="text-xs text-muted-foreground">VM execution unavailable</p>
                  ) : null}
                </div>
                <div className="min-w-0 space-y-1 wrap-anywhere">
                  <div role="status" aria-atomic="true" className="space-y-1">
                    <p
                      className={
                        triggerState === "needs_attention"
                          ? "text-sm font-medium text-warning-foreground"
                          : "text-sm"
                      }
                    >
                      <span className="sr-only">{name}: </span>
                      {triggerLabel}
                    </p>
                    {trigger ? (
                      <p className="text-xs text-muted-foreground">
                        {workflowTriggerLabel(trigger)}
                      </p>
                    ) : null}
                    {!archived && triggerIssue && !local?.error ? (
                      <p className="text-xs text-muted-foreground">{triggerIssue}</p>
                    ) : null}
                  </div>
                  {!archived && local?.error ? (
                    <div role="alert" className="text-xs">
                      <p className="font-medium text-error-foreground">
                        Workflow change not confirmed
                      </p>
                      <p className="text-muted-foreground">{local.error}</p>
                    </div>
                  ) : null}
                  {!archived &&
                  canConfigure &&
                  (triggerIssue || triggerState === "needs_attention") ? (
                    <div className="pt-1">
                      <Button
                        variant="outline"
                        size="compact"
                        aria-label={`Trigger settings for ${name}`}
                        onClick={() => setupTrigger(workflow)}
                      >
                        Trigger settings
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1 pointer-coarse:gap-4 @min-[34rem]/workflow-catalog:justify-end">
                  {canConfigure ? (
                    <Button
                      variant="ghost"
                      size="compact"
                      aria-label={`${editorDirty ? "Resume editing" : "Edit"} ${name}`}
                      ref={
                        !archived && restoreFocusId === workflow.workflowId
                          ? restoredWorkflowEdit
                          : undefined
                      }
                      onClick={() =>
                        navigate({
                          to: "/workflows/$repositoryId/$workflowId/edit",
                          params: {
                            repositoryId: scope.repositoryId,
                            workflowId: workflow.workflowId,
                          },
                        })
                      }
                    >
                      <PencilIcon aria-hidden />
                      {editorDirty ? "Resume editing" : "Edit"}
                    </Button>
                  ) : null}
                  {archived && canConfigure ? (
                    <Button
                      variant="outline"
                      size="compact"
                      aria-label={
                        local?.operation?.state === "pending"
                          ? `Saving ${name}`
                          : local?.operation
                            ? `Retry save for ${name}`
                            : `Restore ${name}`
                      }
                      aria-describedby={restoreBlocked ? restoreHint : undefined}
                      disabled={restoreBlocked || local?.operation?.state === "pending"}
                      onClick={(event) => void restore(workflow, event.currentTarget)}
                    >
                      <ArchiveRestoreIcon aria-hidden />
                      {local?.operation?.state === "pending"
                        ? "Saving…"
                        : local?.operation
                          ? "Retry save"
                          : "Restore"}
                    </Button>
                  ) : null}
                  {hasRunSubmission || canStartRun || hasRetainedInstructions ? (
                    <Button
                      variant="outline"
                      size="compact"
                      aria-label={`${runLabel} for ${name}`}
                      onClick={() =>
                        navigate({
                          to: "/workflows/$repositoryId/$workflowId/run",
                          params: {
                            repositoryId: scope.repositoryId,
                            workflowId: workflow.workflowId,
                          },
                        })
                      }
                    >
                      {runLabel === "Run" ? (
                        <PlayIcon aria-hidden />
                      ) : (
                        <ChevronRightIcon aria-hidden />
                      )}
                      {runLabel}
                    </Button>
                  ) : null}
                  {canCopy || canToggle ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`More actions for ${name}`}
                          />
                        }
                      >
                        <EllipsisIcon aria-hidden />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {canCopy ? (
                          <MenuItem
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
                            <CopyIcon aria-hidden />
                            Copy workflow
                          </MenuItem>
                        ) : null}
                        {canToggle ? (
                          <MenuItem
                            disabled={
                              !!error ||
                              !summary ||
                              local?.operation?.state === "pending" ||
                              (!!local?.baseline && local.baseline.revision > workflow.revision)
                            }
                            onClick={() => toggleAutomation(workflow)}
                          >
                            {local?.operation?.state === "pending"
                              ? "Saving…"
                              : local?.operation
                                ? "Retry trigger change"
                                : workflow.automation?.enabled
                                  ? "Turn off automatic triggering"
                                  : trigger
                                    ? "Turn on automatic triggering"
                                    : "Set up automatic triggering"}
                          </MenuItem>
                        ) : null}
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </div>
                {archived && local?.error ? (
                  <div className="col-span-full">
                    <WorkflowAlert title="Workflow change not confirmed">
                      {local.error}
                    </WorkflowAlert>
                  </div>
                ) : null}
                {canConfigure && restoreBlocked ? (
                  <div id={restoreHint} className="col-span-full">
                    <WorkflowAlert
                      title={
                        restoreIssue === "unavailable"
                          ? "Could not load Machine checkouts"
                          : "Machine checkout unavailable"
                      }
                      variant="warning"
                      actions={
                        restoreIssue === "unavailable" ? (
                          <Button size="sm" variant="outline" onClick={refreshOrganizationCatalog}>
                            <RefreshCwIcon aria-hidden />
                            Retry loading checkouts
                          </Button>
                        ) : projects.length || canRecoverInVm ? (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={
                              canRecoverInVm
                                ? `Choose execution target for ${name}`
                                : `Choose checkout for ${name}`
                            }
                            onClick={() =>
                              void navigate({
                                to: "/workflows/$repositoryId/$workflowId/edit",
                                params: {
                                  repositoryId: scope.repositoryId,
                                  workflowId: workflow.workflowId,
                                },
                                search: { settings: "execution" },
                              })
                            }
                          >
                            {canRecoverInVm ? (
                              <CloudIcon aria-hidden />
                            ) : (
                              <MonitorIcon aria-hidden />
                            )}
                            {canRecoverInVm ? "Choose execution target" : "Choose checkout"}
                          </Button>
                        ) : organizationAdmin ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void navigate({
                                to: "/settings/organization",
                                hash: searchableSetting("organization-machines").id,
                              })
                            }
                          >
                            Machines settings
                          </Button>
                        ) : null
                      }
                    >
                      {restoreIssue === "unavailable"
                        ? "Reload the checkout list before restoring this workflow."
                        : projects.length
                          ? "Choose and save a checkout in Workflow settings before restoring."
                          : canRecoverInVm
                            ? "Choose VM in Workflow settings and save before restoring."
                            : organizationAdmin
                              ? "To keep this workflow on a Machine, connect one with a checkout of this repository."
                              : "To keep this workflow on a Machine, ask an organization admin to connect one with a checkout of this repository."}
                    </WorkflowAlert>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  };
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
              <WorkflowRepositorySwitcher
                compact
                current={entry}
                repositories={repositories}
                onSelect={selectRepository}
              />
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
              {error}{" "}
              {workflowId || vmAuthoring !== null
                ? "Showing the last available data. Your edits are kept."
                : (retainedDraftRecovery ??
                  "Retry to load workflow settings before creating a workflow.")}
            </WorkflowAlert>
          </div>
        ) : null}
        {!loaded ? (
          <Spinner />
        ) : !workflowId && vmAuthoring === null ? null : (
          <WorkflowBuilder
            scope={scope}
            repositoryName={entry.repository.name}
            automationSupported={automationSupported}
            vmAutomationAvailable={vmAutomationAvailable}
            automationReason={
              summaries.find(
                (item) =>
                  item.workflowId === workflow?.workflowId && item.revision === workflow?.revision,
              )?.reason
            }
            workflow={workflow}
            workflowId={workflowId}
            isNew={!workflowId}
            openExecutionSettings={"settings" in search && search.settings === "execution"}
            projects={projects}
            projectsUnavailable={projectsUnavailable}
            refreshProjects={refreshOrganizationCatalog}
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
      {copySource ? (
        <WorkflowCopyDialog
          source={copySource}
          sourceRepositoryId={scope.repositoryId}
          repositories={copyRepositories}
          destination={copyRepository}
          existingDraft={copyDraft}
          checkoutIssue={copyCheckoutIssue}
          onRefreshCheckouts={refreshOrganizationCatalog}
          busy={copyBusy}
          error={copyError}
          onSelectDestination={(id) => {
            if (copyRequest.current) return;
            setCopyDestination(id);
            setCopyError(null);
          }}
          onClose={closeCopy}
          onCopy={() => void copySaved()}
        />
      ) : null}
      {templateOpen && canChooseTemplate && vmAuthoring !== null ? (
        <WorkflowTemplateDialog
          repositoryName={entry.repository.name}
          vmAuthoring={!!vmAuthoring}
          hasMachineCheckout={projects.length > 0}
          projectsUnavailable={projectsUnavailable}
          busy={templateBusy}
          error={templateError}
          onRefreshCheckouts={() => {
            setTemplateError(null);
            refreshOrganizationCatalog();
          }}
          onOpenMachines={
            organizationAdmin
              ? () => {
                  closeTemplates();
                  void navigate({
                    to: "/settings/organization",
                    hash: searchableSetting("organization-machines").id,
                  });
                }
              : undefined
          }
          onCreate={(template) => void useTemplate(template)}
          onClose={closeTemplates}
        />
      ) : null}
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Workflows</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="expanded">
          {!(view === "job" && jobId && loaded) ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {view !== "catalog" ? (
                  <Button variant="ghost" onClick={back}>
                    {view === "job" ? "← Back to runs" : "← Workflows"}
                  </Button>
                ) : null}
                <div className="w-72 max-w-full">
                  <WorkflowRepositorySwitcher
                    current={entry}
                    repositories={repositories}
                    onSelect={selectRepository}
                  />
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
          ) : null}
          {error ? (
            <WorkflowAlert
              title="Could not refresh workflows"
              actions={
                <Button variant="outline" size="sm" onClick={refreshView}>
                  Retry
                </Button>
              }
            >
              {error}{" "}
              {(canChooseTemplate && retainedDraftRecovery) || "Showing the last available data."}
            </WorkflowAlert>
          ) : null}
          {!loaded ? (
            <Spinner />
          ) : view === "run" ? (
            workflow ? (
              <WorkflowRun
                canConfigure={canConfigure}
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
              organizationAdmin={organizationAdmin}
              refreshCatalog={refreshView}
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
                    <RepositorySourcesButton
                      repositoryId={scope.repositoryId}
                      repositoryName={entry.repository.name}
                    />
                    {firstWorkflow ? null : creationActions}
                  </div>
                ) : null}
              </div>
              {tab === "workflows" ? (
                <div className="@container/workflow-catalog">
                  {rows(false)}
                  {firstWorkflow ? (
                    <WorkflowCatalogEmpty
                      actions={creationActions}
                      draftName={
                        canChooseTemplate && retainedDraft
                          ? retainedDraft.definition.name || "New workflow"
                          : undefined
                      }
                    />
                  ) : archivedOnly ? (
                    <div className="flex items-start gap-3 rounded-lg border bg-card p-4 text-card-foreground">
                      <ArchiveIcon
                        aria-hidden
                        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                      />
                      <div className="space-y-1">
                        <h2 className="text-sm font-semibold">No active workflows</h2>
                        <p className="text-sm text-muted-foreground">
                          {canConfigure
                            ? "Restore an archived workflow to make it available again."
                            : "A repository maintainer or organization admin can restore a workflow."}
                        </p>
                      </div>
                    </div>
                  ) : null}
                  {archivedWorkflows.length ? (
                    <Collapsible
                      open={archiveOpen}
                      onOpenChange={setArchiveExpanded}
                      className="mt-6"
                    >
                      <CollapsibleTrigger
                        aria-label="Archived workflows"
                        aria-description={`${archivedWorkflows.length} archived`}
                        className="flex w-full items-center gap-2 rounded-md py-2 text-start text-sm font-medium"
                      >
                        <ChevronRightIcon
                          aria-hidden
                          className={archiveOpen ? "size-4 rotate-90" : "size-4"}
                        />
                        Archived workflows
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {archivedWorkflows.length}
                        </span>
                      </CollapsibleTrigger>
                      <CollapsiblePanel>
                        {canConfigure ? (
                          <p className="pb-3 text-xs text-muted-foreground">
                            Automatic triggering stays off when you restore a workflow.
                          </p>
                        ) : null}
                        {rows(true)}
                      </CollapsiblePanel>
                    </Collapsible>
                  ) : null}
                  <p
                    role="status"
                    className={restoreNotice ? "mt-3 text-sm text-muted-foreground" : "sr-only"}
                  >
                    {restoreNotice}
                  </p>
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
