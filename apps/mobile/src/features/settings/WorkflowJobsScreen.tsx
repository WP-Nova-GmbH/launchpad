import { SavedWorkflowResults } from "./SavedWorkflowResults";
import { ErrorBanner } from "../../components/ErrorBanner";
import { MaterialButton } from "../../components/MaterialButton";
import { StatusPill } from "../../components/StatusPill";
import { SymbolView } from "../../components/AppSymbol";
import { SegmentedControl } from "../../components/SegmentedControl";
import { WorkflowIssueDetails } from "./WorkflowIssueDetails";
import { WorkflowSourceHealth } from "./WorkflowSourceHealth";
import { useAtomValue } from "@effect/atom-react";
import {
  workflowDraftAtom,
  workflowJobReadAtom,
  workflowSessionKey,
  updateWorkflowDrafts,
  activateWorkflowJobView,
  beginWorkflowJobRequest,
  recordWorkflowResponse,
  settleWorkflowJobRequest,
  invalidateWorkflowJobRead,
  emptyWorkflowJobRead,
  workflowStepState,
  workflowStatusLabel,
  workflowJobAccessLost,
  beginWorkflowReview,
  bindWorkflowReviewPlacement,
  requireFreshWorkflowReviewRead,
  workflowReviewApprovalState,
  emptyWorkflowJobPageRead,
  beginWorkflowJobPage,
  settleWorkflowJobPage,
  readWorkflowJobPages,
  type WorkflowJobPageRequest,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAuth } from "@clerk/expo";
import { useNavigation, useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import {
  ManagedRelay,
  ManagedRelayTenancy,
  matchesWorkflowRepository,
  workflowRepositoryRemote,
} from "@t3tools/client-runtime/relay";
import {
  workflowManualControlState,
  workflowActionState,
  workflowManualSubmission,
  workflowViewerControls,
  workflowApprovalPending,
} from "@t3tools/client-runtime/relay/workflow-responses";
import { workflowResultCheckpoint } from "@t3tools/client-runtime/relay/workflow-result";
import type {
  RelayRepositorySummary,
  RelayOrganizationMembership,
  RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import {
  isTerminalWorkflowJob,
  workflowZones,
  type WorkflowJobListView,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import {
  useCallback,
  useEffect,
  useState,
  useMemo,
  useRef,
  useLayoutEffect,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Linking,
  Alert,
  AppState,
  Platform,
  Pressable,
  View,
  TextInput,
  type HostInstance,
  type ScrollView,
} from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { openPortableThreadChat } from "../../state/threads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsRow } from "./components/SettingsRow";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { setReviewSelectedSectionId } from "../review/reviewState";

type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
const NO_REPOSITORY_MATCHES_MESSAGE = "No repositories match your search.";

function RunDetailsDisclosure({
  label,
  expandedLabel,
  icon,
  children,
}: {
  label: string;
  expandedLabel?: string;
  icon: "ellipsis" | "text.alignleft" | "clock";
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <SettingsSection>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="min-h-11 flex-row items-center gap-3 px-4 py-2"
        onPress={() => setExpanded((open) => !open)}
      >
        <SymbolView name={icon} size={18} tintColorClassName="accent-foreground-muted" />
        <Text className="flex-1 text-foreground">
          {expanded && expandedLabel ? expandedLabel : label}
        </Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={14}
          tintColorClassName="accent-foreground-muted"
        />
      </Pressable>
      {expanded ? <View className="border-t border-outline">{children}</View> : null}
    </SettingsSection>
  );
}

type Props = StaticScreenProps<
  | {
      repositoryId?: string;
      jobId?: string;
    }
  | undefined
>;
export function WorkflowJobsScreen(props: Props) {
  const navigation = useNavigation();
  return hasCloudPublicConfig() ? (
    <ConfiguredWorkflowJobsScreen {...props} />
  ) : (
    <SettingsScreen title="Workflow jobs">
      <ErrorBanner
        title="Workflows unavailable"
        message="Launchpad Connect is not configured."
        tone="warning"
      >
        <MaterialButton label="Back to settings" onPress={() => navigation.goBack()} />
      </ErrorBanner>
    </SettingsScreen>
  );
}

function ConfiguredWorkflowJobsScreen(props: Props) {
  const { userId } = useAuth();
  return (
    <WorkflowJobsContent
      key={
        (userId ?? "signed-out") +
        ":" +
        (props.route.params?.repositoryId ?? "") +
        ":" +
        (props.route.params?.jobId ?? "")
      }
      {...props}
    />
  );
}

function WorkflowJobsContent(props: Props) {
  const { getToken, isSignedIn, userId } = useAuth();
  const latestGetToken = useRef(getToken);
  useLayoutEffect(() => {
    latestGetToken.current = getToken;
  }, [getToken]);
  const navigation = useNavigation();
  const openPortableResult = useAtomCommand(openPortableThreadChat, { reportFailure: false });
  const focused = useIsFocused();
  const [repositories, setRepositories] = useState<ReadonlyArray<RelayRepositorySummary>>([]);
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const matchingRepositories = useMemo(
    () =>
      repositories.filter(({ repository }) =>
        matchesWorkflowRepository(repository, repositoryQuery),
      ),
    [repositories, repositoryQuery],
  );
  const [membership, setMembership] = useState<RelayOrganizationMembership | null>(null);
  const [selectedRepository, setSelectedRepository] = useState<RelayRepositorySummary | null>(null);
  const [recent, setRecent] = useState(emptyWorkflowJobPageRead);
  const [listView, setListView] = useState<WorkflowJobListView>("active");
  const listRequest = useRef<WorkflowJobPageRequest | null>(null);
  const latestList = useRef(recent);
  useLayoutEffect(() => {
    latestList.current = recent;
  }, [recent]);
  const [projects, setProjects] = useState<ReadonlyArray<RelayOrganizationProject>>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    props.route.params?.jobId ?? null,
  );
  const drafts = useAtomValue(workflowDraftAtom);
  const workflowAccountReady = !!userId && drafts.accountId === userId;
  const reads = useAtomValue(workflowJobReadAtom);
  const organizationId = selectedRepository?.repository.organizationId;
  const repositoryId = selectedRepository?.repository.repositoryId;
  const scope: WorkflowScope | null = useMemo(
    () =>
      userId && organizationId && repositoryId
        ? { accountId: userId, organizationId, repositoryId }
        : null,
    [userId, organizationId, repositoryId],
  );
  const jobKey = scope && selectedJobId ? workflowSessionKey(scope, selectedJobId) : "";
  const resultRequest = useRef<{ key: string } | null>(null);
  const [openingResult, setOpeningResult] = useState<string | null>(null);
  useLayoutEffect(
    () => () => {
      if (resultRequest.current?.key !== jobKey) return;
      resultRequest.current = null;
      setOpeningResult(null);
    },
    [jobKey],
  );
  const listKey = scope ? workflowSessionKey(scope, `runs:${listView}`) : "";
  const jobs = recent.key === listKey ? recent.jobs : null;
  const read = reads.jobs[jobKey] ?? emptyWorkflowJobRead;
  const reviewApproval = workflowReviewApprovalState(drafts.reviews[jobKey], read);
  const checkingReturnedReview = reviewApproval === "checking";
  const selectedJob = read.job;
  const manualState = workflowManualControlState(selectedJob);
  const approvalPending = workflowApprovalPending(selectedJob);
  const actionState = workflowActionState(selectedJob);
  const detail = selectedJob?.detail ?? selectedJob?.progress?.detail ?? actionState.action?.detail;
  const terminal = !!selectedJob && isTerminalWorkflowJob(selectedJob.status);
  const responseDrafts = drafts.responses[jobKey] ?? {};
  const [reviewingCurrentResult, setReviewingCurrentResult] = useState(true);
  const runScrollRef = useRef<ScrollView & { getInnerViewRef?: () => HostInstance | null }>(null);
  const checkReviewVisibility = useRef<(() => void) | null>(null);
  const reviewViewport = useMemo(
    () => ({ scroll: runScrollRef, check: checkReviewVisibility }),
    [],
  );
  const checkReviewViewport = useCallback(() => checkReviewVisibility.current?.(), []);
  const feedbackInputRef = useRef<TextInput>(null);
  const feedbackFocusRequest = useRef<{ key: string } | null>(null);
  const [feedbackView, setFeedbackView] = useState<{ key: string; open: boolean } | null>(null);
  const [openedVmReviewKey, setOpenedVmReviewKey] = useState<string | null>(null);
  const checkpoint = selectedJob?.progress?.checkpoint;
  const feedbackKey = `${jobKey}:${checkpoint?.checkpointId ?? ""}`;
  const feedbackOpen =
    feedbackView?.key === feedbackKey
      ? feedbackView.open
      : !!(checkpoint && responseDrafts[checkpoint.checkpointId]);
  const setResponseDrafts = (
    update: (previous: Record<string, string>) => Record<string, string>,
  ) => {
    if (!scope) return;
    updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
      ...state,
      responses: { ...state.responses, [jobKey]: update(state.responses[jobKey] ?? {}) },
    }));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [catalogRead, setCatalogRead] = useState<
    { status: "loading" | "loaded" } | { status: "error"; message: string }
  >({ status: "loading" });
  const noRepositoryMatches =
    catalogRead.status === "loaded" && repositories.length > 0 && matchingRepositories.length === 0;
  useEffect(() => {
    if (
      Platform.OS === "ios" &&
      focused &&
      isSignedIn &&
      workflowAccountReady &&
      !selectedRepository &&
      noRepositoryMatches
    )
      AccessibilityInfo.announceForAccessibility(NO_REPOSITORY_MATCHES_MESSAGE);
  }, [focused, isSignedIn, workflowAccountReady, noRepositoryMatches, selectedRepository]);
  const refreshRepositories = () => {
    setCatalogRead({ status: "loading" });
    setCatalogRefresh((version) => version + 1);
    setError(null);
  };
  const call = useCallback(
    async <A,>(
      operation: (
        client: Client,
        clerkToken: string,
      ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
    ) => {
      const token = await latestGetToken.current(resolveRelayClerkTokenOptions());
      if (!token || appAtomRegistry.get(workflowDraftAtom).accountId !== userId)
        throw new Error("Sign in to Launchpad to view repository jobs.");
      const result = await runtime.runPromiseExit(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) => operation(client, token)),
        ),
      );
      if (Exit.isFailure(result)) throw Cause.squash(result.cause);
      return result.value;
    },
    [userId],
  );
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The job request failed. Try refreshing.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!isSignedIn || !workflowAccountReady) return;
    let disposed = false;
    void Promise.all([
      call((client, clerkToken) => client.listRepositories({ clerkToken })),
      call((client, clerkToken) => client.getOrganization({ clerkToken })),
      call((client, clerkToken) =>
        client.listOrganizationProjects({ clerkToken }).pipe(Effect.orElseSucceed(() => [])),
      ),
    ]).then(
      ([entries, member, organizationProjects]) => {
        if (!disposed) {
          setRepositories(entries);
          setMembership(member);
          setProjects(organizationProjects);
          setCatalogRead({ status: "loaded" });
          const requested = entries.find(
            (entry) => entry.repository.repositoryId === props.route.params?.repositoryId,
          );
          if (requested) setSelectedRepository(requested);
          else if (props.route.params?.repositoryId)
            setError("This repository is unavailable or you no longer have access.");
        }
      },
      (cause) => {
        if (!disposed)
          setCatalogRead({
            status: "error",
            message:
              cause instanceof Error ? cause.message : "Check your connection and try again.",
          });
      },
    );
    return () => {
      disposed = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- An explicit recovery action increments catalogRefresh to retry this external read.
  }, [isSignedIn, workflowAccountReady, call, props.route.params?.repositoryId, catalogRefresh]);
  const loadJobs = useCallback(
    async (cursor: string | null = null, minimumCount = 0) => {
      if (!scope || !focused || listRequest.current?.key === listKey) return;
      const request = { key: listKey, cursor };
      listRequest.current = request;
      setRecent((previous) => beginWorkflowJobPage(previous, request));
      try {
        const page = await readWorkflowJobPages(
          (pageCursor) =>
            call((client, clerkToken) =>
              client.pageWorkflowJobs({
                clerkToken,
                repositoryId: scope.repositoryId,
                query: { view: listView, ...(pageCursor ? { cursor: pageCursor } : {}) },
              }),
            ),
          { cursor, minimumCount, isCurrent: () => listRequest.current === request },
        );
        if (listRequest.current === request)
          setRecent((previous) => settleWorkflowJobPage(previous, request, page));
      } catch (cause) {
        if (listRequest.current === request)
          setRecent((previous) =>
            settleWorkflowJobPage(
              previous,
              request,
              cause instanceof Error ? cause.message : "Could not load runs.",
              workflowJobAccessLost(cause),
            ),
          );
      } finally {
        if (listRequest.current === request) listRequest.current = null;
      }
    },
    [scope, focused, listKey, listView, call],
  );
  useEffect(() => {
    void loadJobs();
    return () => {
      listRequest.current = null;
    };
  }, [loadJobs]);
  useEffect(() => {
    if (!scope || !focused || selectedJobId) return;
    const refreshVisible = () => {
      if (AppState.currentState !== "active" || listRequest.current) return;
      const previous = latestList.current;
      void loadJobs(null, previous.key === listKey ? (previous.jobs?.length ?? 0) : 0);
    };
    const timer = setInterval(refreshVisible, 5000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshVisible();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [scope, focused, selectedJobId, loadJobs, listKey]);
  const refreshJob = useCallback(async () => {
    if (!scope || !selectedJobId) return;
    const request = beginWorkflowJobRequest(appAtomRegistry, scope, selectedJobId);
    if (!request) return;
    try {
      settleWorkflowJobRequest(
        appAtomRegistry,
        request,
        await call((client, token) =>
          client.getWorkflowJob({
            clerkToken: token,
            repositoryId: scope.repositoryId,
            jobId: selectedJobId,
          }),
        ),
      );
    } catch (cause) {
      settleWorkflowJobRequest(
        appAtomRegistry,
        request,
        cause instanceof Error ? cause.message : "Could not refresh this run.",
        workflowJobAccessLost(cause),
      );
    }
  }, [call, scope, selectedJobId]);
  useLayoutEffect(() => {
    if (scope && selectedJobId && focused) {
      activateWorkflowJobView(appAtomRegistry, scope, selectedJobId);
      requireFreshWorkflowReviewRead(appAtomRegistry, scope, selectedJobId);
    }
  }, [scope, selectedJobId, focused]);
  useEffect(() => {
    if (!scope || !selectedJobId || read.mutation || !focused) return;
    void refreshJob();
    if (terminal && selectedJob?.progress?.resultSaving?.state !== "saving") return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refreshJob();
    }, 5000);
    const subscription = AppState.addEventListener("change", (state) => {
      requireFreshWorkflowReviewRead(appAtomRegistry, scope, selectedJobId);
      if (state === "active") {
        checkReviewViewport();
        void refreshJob();
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
      invalidateWorkflowJobRead(appAtomRegistry, scope, selectedJobId);
    };
  }, [
    checkReviewViewport,
    refreshJob,
    terminal,
    selectedJob?.progress?.resultSaving?.state,
    read.mutation,
    scope,
    selectedJobId,
    focused,
  ]);
  const machine = selectedJob?.runtime?.kind === "machine" ? selectedJob.runtime : null;
  const target = machine
    ? projects.find(
        (project) =>
          project.environmentId === machine.environmentId &&
          project.projectId === machine.projectId,
      )
    : undefined;
  const canConfigure = membership?.role === "admin" || selectedRepository?.role === "maintainer";
  const viewerControls = workflowViewerControls(selectedJob, canConfigure);
  const composingFeedback =
    !terminal &&
    manualState.status === "awaiting_review" &&
    feedbackOpen &&
    viewerControls.canRespond &&
    !approvalPending;
  useLayoutEffect(() => {
    if (
      !focused ||
      !composingFeedback ||
      busy ||
      manualState.checkpointBlocked ||
      feedbackFocusRequest.current?.key !== feedbackKey
    ) {
      feedbackFocusRequest.current = null;
    }
  }, [focused, composingFeedback, busy, manualState.checkpointBlocked, feedbackKey]);
  const focusFeedbackInput = () => {
    const request = feedbackFocusRequest.current;
    const input = feedbackInputRef.current;
    const scroll = runScrollRef.current;
    if (request?.key !== feedbackKey || !input || !scroll) return;
    const focusAt = (y: number) => {
      if (feedbackFocusRequest.current !== request || feedbackInputRef.current !== input) return;
      feedbackFocusRequest.current = null;
      scroll.scrollTo({ y: Math.max(0, y - 16), animated: false });
      input.focus();
      AccessibilityInfo.sendAccessibilityEvent(input, "focus");
    };
    const content = scroll.getInnerViewRef?.();
    if (content)
      input.measureLayout(
        content,
        (_x, y) => focusAt(y),
        () => focusAt(0),
      );
    else focusAt(0);
  };
  const completed = selectedJob?.status === "done";
  const issue = selectedJob?.issueSnapshot ?? selectedJob?.event;
  const running = selectedJob?.status === "running";
  const needsInput = selectedJob?.status === "awaiting_input";
  const needsReview = selectedJob?.status === "awaiting_review";
  const vm = selectedJob?.runtime?.kind === "vm";
  const steps = selectedJob?.workflow?.definition.steps;
  const stepIndex =
    steps?.findIndex((step) => step.id === (checkpoint?.stepId ?? selectedJob?.progress?.stepId)) ??
    -1;
  const step = steps?.[stepIndex];
  const nextStep = running && stepIndex >= 0 ? steps?.[stepIndex + 1] : undefined;
  const manualHold =
    selectedJob?.status === "paused" && selectedJob.progress?.manualPause?.state === "paused";
  const pausedBeforeStep = manualHold && manualState.status === "waiting_capacity" && !checkpoint;
  const canOpenMachineResult =
    !composingFeedback &&
    !vm &&
    !!selectedJob?.progress &&
    selectedJob.progress.hasThread !== false;
  const reviewKey =
    checkpoint && checkpoint.kind !== "input"
      ? JSON.stringify([
          jobKey,
          selectedJob?.progress?.threadId,
          checkpoint.checkpointId,
          checkpoint.turnId,
          checkpoint.checkpointRef,
          checkpoint.checkpointTurnCount,
        ])
      : null;
  const primaryMachineDiff = needsReview && canOpenMachineResult && !!machine && reviewKey !== null;
  const vmReviewCollapsed =
    vm && needsReview && reviewKey !== null && openedVmReviewKey !== reviewKey;
  const canResume = canConfigure && manualState.canResume;
  const canPause = canConfigure && manualState.canPause;
  const canCancel = viewerControls.canCancel && !terminal;
  const cancelling = selectedJob?.status === "cancelling";
  const retryCancellation =
    selectedJob?.progress?.retryableCancellation && !manualState.responsePending;
  const conversationInRunActions = canOpenMachineResult && !terminal && !running;
  const confirmationPending =
    approvalPending || manualState.responsePending || !!selectedJob?.pendingManualControl;
  const reviewChanged = reviewApproval === "inspect";
  const respond = (
    operation:
      | "approve"
      | "input"
      | "request_changes"
      | "cancel"
      | "retry_action"
      | "retry_saving"
      | "retry_preparation"
      | "retry_cancellation"
      | "pause"
      | "resume",
  ) =>
    void perform(async () => {
      if (
        !selectedJob ||
        !selectedRepository ||
        !scope ||
        (manualState.responsePending && operation !== "cancel")
      )
        return;
      if (
        operation === "retry_saving" &&
        (!canConfigure || !selectedJob.progress?.resultSaving?.retryable)
      )
        return;
      const checkpoint = selectedJob.progress?.checkpoint;
      const currentRead =
        appAtomRegistry.get(workflowJobReadAtom).jobs[jobKey] ?? emptyWorkflowJobRead;
      const currentReview = appAtomRegistry.get(workflowDraftAtom).reviews[jobKey];
      if (
        (operation === "approve" &&
          (!viewerControls.canApprove ||
            currentRead.job !== selectedJob ||
            workflowReviewApprovalState(currentReview, currentRead) !== "allowed")) ||
        ((operation === "input" || operation === "request_changes") &&
          !viewerControls.canRespond) ||
        ((operation === "cancel" || operation === "retry_cancellation") &&
          !viewerControls.canCancel)
      )
        return;
      if (["approve", "input", "request_changes"].includes(operation) && !checkpoint) return;
      const request = beginWorkflowJobRequest(appAtomRegistry, scope, selectedJob.jobId, uuidv4());
      if (!request) return;
      let intent = appAtomRegistry.get(workflowDraftAtom).manual[jobKey];
      if (operation === "pause" || operation === "resume") {
        intent = workflowManualSubmission(intent ?? null, selectedJob, operation, uuidv4);
        updateWorkflowDrafts(appAtomRegistry, scope.accountId, (state) => ({
          ...state,
          manual: { ...state.manual, [jobKey]: intent! },
        }));
      }
      const payload =
        operation === "retry_saving"
          ? {
              operation,
              publicationId: selectedJob.progress!.resultSaving!.publicationId,
              expectedRevision: selectedJob.progress!.revision,
            }
          : operation === "pause" || operation === "resume"
            ? intent!.control
            : operation === "input" || operation === "request_changes"
              ? {
                  operation,
                  checkpointId: checkpoint!.checkpointId,
                  expectedRevision: selectedJob.progress!.revision,
                  text: responseDrafts[checkpoint!.checkpointId] ?? "",
                }
              : operation === "approve"
                ? ({
                    operation,
                    checkpointId: checkpoint!.checkpointId,
                    expectedRevision: selectedJob.progress!.revision,
                  } as const)
                : operation === "retry_action"
                  ? {
                      operation,
                      actionId: actionState.action!.actionId,
                      expectedRevision: selectedJob.progress!.revision,
                    }
                  : operation === "retry_preparation" || operation === "retry_cancellation"
                    ? { operation, expectedRevision: selectedJob.progress!.revision }
                    : { operation };
      const submitted = {
        checkpointId: checkpoint?.checkpointId ?? null,
        operation,
        userId,
        text: "text" in payload ? (payload.text ?? null) : null,
      };
      recordWorkflowResponse(appAtomRegistry, scope, selectedJob.jobId, submitted);
      try {
        const next = await call((client, clerkToken) =>
          client.respondToWorkflowJob({
            clerkToken,
            repositoryId: selectedRepository.repository.repositoryId,
            jobId: selectedJob.jobId,
            payload,
          }),
        );
        settleWorkflowJobRequest(appAtomRegistry, request, next);
      } catch (cause) {
        settleWorkflowJobRequest(
          appAtomRegistry,
          request,
          cause instanceof Error ? cause.message : "Could not confirm response.",
        );
      }
    });
  const openResult = async (diff: boolean) => {
    if (
      !selectedJob?.progress ||
      selectedJob.progress.hasThread === false ||
      !scope ||
      resultRequest.current ||
      (diff && checkingReturnedReview)
    )
      return;
    const request = { key: jobKey };
    resultRequest.current = request;
    setOpeningResult(jobKey);
    setError(null);
    const session = appAtomRegistry.get(managedRelaySessionAtom);
    try {
      const runtime = selectedJob.runtime;
      if (!runtime) throw new Error("This run has no available execution binding.");
      const checkpoint = workflowResultCheckpoint(selectedJob.progress.checkpoint);
      const exactReview = diff && runtime.kind === "vm" ? checkpoint : undefined;
      const reviewVisitId = exactReview ? uuidv4() : undefined;
      if (exactReview && reviewVisitId)
        beginWorkflowReview(appAtomRegistry, scope, selectedJob.jobId, reviewVisitId, exactReview);
      const result = await openPortableResult({
        threadId: selectedJob.progress.threadId,
        title: selectedJob.workflow?.definition.name ?? "Workflow result",
        workflowResult:
          runtime.kind === "vm"
            ? { ...scope, jobId: selectedJob.jobId }
            : { ...scope, originalEnvironmentId: runtime.environmentId },
      });
      if (
        resultRequest.current !== request ||
        appAtomRegistry.get(managedRelaySessionAtom) !== session
      )
        return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const { environmentId, threadId, workflowVmGeneration } = result.value;
      if (reviewVisitId && workflowVmGeneration !== undefined)
        bindWorkflowReviewPlacement(appAtomRegistry, scope, selectedJob.jobId, reviewVisitId, {
          environmentId,
          threadId,
          generation: workflowVmGeneration,
        });
      const params = {
        environmentId,
        threadId,
        workflowOrigin: {
          ...scope,
          jobId: selectedJob.jobId,
          threadId: result.value.threadId,
          ...(workflowVmGeneration === undefined ? {} : { workflowVmResultReader: true as const }),
          ...(exactReview && reviewVisitId ? { reviewCheckpoint: exactReview, reviewVisitId } : {}),
        },
      };
      if (diff && checkpoint) {
        if (!exactReview)
          setReviewSelectedSectionId(
            scopedThreadKey(params.environmentId, params.threadId),
            `turn:${checkpoint.checkpointTurnCount}`,
          );
        navigation.navigate("ThreadReview", params);
      } else navigation.navigate("Thread", params);
    } catch (cause) {
      if (
        resultRequest.current === request &&
        appAtomRegistry.get(managedRelaySessionAtom) === session
      )
        setError(cause instanceof Error ? cause.message : "Could not open this result. Try again.");
    } finally {
      if (resultRequest.current === request) {
        resultRequest.current = null;
        setOpeningResult(null);
      }
    }
  };
  const backToJobs = () => {
    setSelectedJobId(null);
    void loadJobs();
  };
  const requestError = error ? (
    <View className={selectedJob ? "mx-5 mb-3" : "mb-3"}>
      <ErrorBanner title="Workflow request failed" message={error}>
        <MaterialButton
          label={
            selectedJobId && scope
              ? "Refresh run"
              : selectedRepository
                ? "Refresh jobs"
                : "Retry repositories"
          }
          disabled={busy || read.reading}
          onPress={() => {
            setError(null);
            if (selectedJobId && scope) void refreshJob();
            else if (selectedRepository) void loadJobs();
            else refreshRepositories();
          }}
        />
        <MaterialButton label="Dismiss" tone="text" onPress={() => setError(null)} />
      </ErrorBanner>
    </View>
  ) : null;
  return (
    <SettingsScreen title="Workflow jobs">
      {requestError}
      {read.error && selectedJob ? (
        <View className="mx-5 mb-3">
          <ErrorBanner
            title="Could not refresh this run"
            message={`${read.error} Showing the last acknowledged state.`}
          >
            <MaterialButton
              label="Retry refresh"
              disabled={read.reading}
              onPress={() => void refreshJob()}
            />
          </ErrorBanner>
        </View>
      ) : null}
      {!isSignedIn ? (
        <Text className="text-foreground-muted">Sign in to view repository jobs.</Text>
      ) : selectedJob ? (
        <ScreenScrollView
          key={jobKey}
          ref={runScrollRef}
          className="flex-1"
          contentContainerClassName="gap-3 px-5 pt-2 pb-8"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          onLayout={checkReviewViewport}
          onContentSizeChange={checkReviewViewport}
          onScroll={checkReviewViewport}
          onScrollEndDrag={checkReviewViewport}
          onMomentumScrollEnd={checkReviewViewport}
          scrollEventThrottle={64}
        >
          <View className="gap-2 px-1">
            <Pressable
              accessibilityRole="button"
              className="min-h-11 flex-row items-center gap-1 self-start"
              onPress={backToJobs}
            >
              <SymbolView name="chevron.left" size={16} tintColorClassName="accent-primary-text" />
              <Text className="font-t3-medium text-primary-text">Back to jobs</Text>
            </Pressable>
            <Text accessibilityRole="header" className="text-2xl font-t3-bold text-foreground">
              {selectedJob.workflow?.definition.name ?? "Workflow job"}
            </Text>
            <Text numberOfLines={2} className="text-foreground">
              {selectedJob.origin?.kind === "automation" && issue
                ? `${issue.identifier}: ${issue.title}`
                : selectedJob.instruction}
            </Text>
            <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
              <View className="min-w-0 shrink flex-row items-center gap-1.5">
                <SymbolView
                  name={!target && (selectedJob.vmAdmission || vm) ? "cloud" : "desktopcomputer"}
                  size={14}
                  tintColorClassName="accent-foreground-muted"
                />
                <Text className="shrink text-xs text-foreground-muted">
                  {target
                    ? `${target.machineLabel} / ${target.title}`
                    : selectedJob.vmAdmission || vm
                      ? "Workflow VM"
                      : "Organization execution target"}
                </Text>
              </View>
              <Text className="text-xs text-foreground-muted">
                Submitted {new Date(selectedJob.createdAt).toLocaleString()}
              </Text>
            </View>
          </View>
          <SettingsSection {...(terminal ? { title: "Result" } : {})}>
            <View className="gap-2 p-4">
              <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <StatusPill
                  label={workflowStatusLabel(selectedJob.status)}
                  pillClassName={
                    needsInput || needsReview ? "bg-warning" : running ? "bg-update" : "bg-card"
                  }
                  textClassName={
                    needsInput || needsReview
                      ? "text-warning-foreground"
                      : running
                        ? "text-update-foreground"
                        : "text-foreground"
                  }
                />
                {!terminal && step && steps ? (
                  <Text className="text-xs text-foreground-muted">
                    {pausedBeforeStep ? "Next step" : "Step"} {stepIndex + 1} of {steps.length}
                  </Text>
                ) : null}
              </View>
              {!terminal && step && step.title !== selectedJob.workflow?.definition.name ? (
                <Text accessibilityRole="header" className="text-lg font-t3-bold text-foreground">
                  {step.title}
                </Text>
              ) : null}
              {nextStep ? (
                <Text className="text-sm text-foreground-muted">Up next is {nextStep.title}.</Text>
              ) : null}
              {selectedJob.status === "queued" && !selectedJob.vmAdmission ? (
                <Text className="text-foreground-muted">
                  Waiting for an execution target. No steps have started.
                </Text>
              ) : null}
              {manualHold && !confirmationPending ? (
                <Text className="text-sm text-foreground-muted">
                  Setup and previews remain running.
                </Text>
              ) : manualState.message && confirmationPending ? (
                <Text className="text-foreground-muted">{manualState.message}</Text>
              ) : manualState.message ? (
                <ErrorBanner
                  title="Run needs attention"
                  message={manualState.message}
                  tone="warning"
                />
              ) : null}
              {selectedJob.status === "failed" ? (
                <ErrorBanner
                  title="Run failed"
                  message={
                    detail ??
                    "This run stopped before completing. Inspect the agent result for details."
                  }
                />
              ) : detail && !(pausedBeforeStep && detail === "Waiting for executor capacity.") ? (
                <Text className="text-foreground-muted">{detail}</Text>
              ) : null}
              {canResume ? (
                <MaterialButton
                  tone={selectedJob.status === "paused" ? "primary" : "secondary"}
                  fullWidth
                  label="Resume workflow"
                  disabled={busy}
                  onPress={() => respond("resume")}
                />
              ) : null}
              {running && canOpenMachineResult ? (
                <MaterialButton
                  tone="secondary"
                  fullWidth
                  label="Inspect agent result"
                  disabled={busy || openingResult === jobKey}
                  onPress={() => void openResult(false)}
                />
              ) : null}
              {primaryMachineDiff ? (
                <MaterialButton
                  tone="primary"
                  fullWidth
                  label="Inspect saved diff"
                  disabled={busy || openingResult === jobKey || checkingReturnedReview}
                  onPress={() => void openResult(true)}
                />
              ) : null}
              {vmReviewCollapsed && reviewKey && !composingFeedback ? (
                <MaterialButton
                  tone="primary"
                  fullWidth
                  label="Inspect saved diff"
                  onPress={() => setOpenedVmReviewKey(reviewKey)}
                />
              ) : null}
            </View>
            {!terminal &&
            (manualState.status === "awaiting_input" || manualState.status === "awaiting_review") &&
            viewerControls.canRespond &&
            selectedJob.progress?.checkpoint &&
            !approvalPending &&
            (manualState.status === "awaiting_input" || feedbackOpen) ? (
              <View className="gap-2 px-4 pb-4">
                {manualState.status === "awaiting_review" ? (
                  <Text accessibilityRole="header" className="font-t3-medium text-foreground">
                    Request changes
                  </Text>
                ) : null}
                {selectedJob.progress?.checkpoint?.kind === "input" ? (
                  <Text className="text-foreground">
                    {selectedJob.progress.checkpoint.question}
                  </Text>
                ) : null}
                <TextInput
                  ref={composingFeedback ? feedbackInputRef : undefined}
                  onLayout={composingFeedback ? focusFeedbackInput : undefined}
                  accessibilityLabel={
                    manualState.status === "awaiting_input"
                      ? "Checkpoint answer"
                      : "Rework feedback"
                  }
                  multiline
                  maxLength={8000}
                  className="min-h-24 rounded-lg border border-outline p-3 text-foreground"
                  value={responseDrafts[selectedJob.progress!.checkpoint!.checkpointId] ?? ""}
                  onChangeText={(text) =>
                    setResponseDrafts((previous) => ({
                      ...previous,
                      [selectedJob.progress!.checkpoint!.checkpointId]: text,
                    }))
                  }
                />
                <Text className="text-xs text-foreground-muted">
                  Draft kept until acknowledged.
                </Text>
                <MaterialButton
                  tone="primary"
                  fullWidth
                  label={
                    manualState.responsePending
                      ? "Response pending"
                      : manualState.status === "awaiting_input"
                        ? "Submit answer"
                        : "Send changes"
                  }
                  disabled={
                    busy ||
                    manualState.checkpointBlocked ||
                    !(responseDrafts[selectedJob.progress!.checkpoint!.checkpointId] ?? "").trim()
                  }
                  onPress={() =>
                    respond(manualState.status === "awaiting_input" ? "input" : "request_changes")
                  }
                />
                {manualState.status === "awaiting_review" ? (
                  <MaterialButton
                    tone="text"
                    label="Back to review"
                    onPress={() => setFeedbackView({ key: feedbackKey, open: false })}
                  />
                ) : null}
              </View>
            ) : null}
            {canCancel && cancelling ? (
              <SettingsActionRow
                icon="arrow.clockwise"
                label={retryCancellation ? "Retry cancellation" : "Cancellation pending"}
                tone="danger"
                disabled={busy || !retryCancellation}
                onPress={() => respond("retry_cancellation")}
              />
            ) : null}
            {canConfigure && actionState.canRetry ? (
              <SettingsActionRow
                icon="arrow.clockwise"
                label="Retry publishing action"
                disabled={busy}
                onPress={() => respond("retry_action")}
              />
            ) : null}
            {canConfigure &&
            manualState.status === "paused" &&
            selectedJob.progress?.retryablePreparation ? (
              <SettingsActionRow
                icon="arrow.clockwise"
                label="Retry preparation"
                disabled={busy || manualState.checkpointBlocked}
                onPress={() => respond("retry_preparation")}
              />
            ) : null}
            {completed && selectedJob.progress?.pullRequestUrl ? (
              <View className="p-4">
                <MaterialButton
                  tone="primary"
                  label="Open pull request"
                  onPress={() => void Linking.openURL(selectedJob.progress!.pullRequestUrl!)}
                />
              </View>
            ) : null}
            {checkingReturnedReview && read.error ? (
              <SettingsActionRow
                icon="arrow.clockwise"
                label="Refresh run"
                disabled={read.reading}
                onPress={() => void refreshJob()}
              />
            ) : null}
            {(reviewChanged && selectedJob.runtime?.kind !== "vm") ||
            (checkingReturnedReview && reviewingCurrentResult && !read.error) ? (
              <View className="p-4">
                <ErrorBanner
                  title={reviewChanged ? "Review changed" : "Checking the current review"}
                  tone="warning"
                  message={
                    reviewChanged
                      ? "Review changed. Inspect the current diff before approving."
                      : "Checking the current review…"
                  }
                />
              </View>
            ) : null}
            {selectedJob.progress?.resultSaving ? (
              <View className="p-4">
                <Text accessibilityRole="header" className="font-t3-medium text-sm text-foreground">
                  {selectedJob.progress.resultSaving.state === "failed"
                    ? "Couldn’t save result"
                    : "Saving result"}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {selectedJob.progress.resultSaving.detail ??
                    "The next step starts after this result is saved."}
                </Text>
                {canConfigure && selectedJob.progress.resultSaving.retryable ? (
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label="Retry saving"
                    disabled={busy}
                    onPress={() => respond("retry_saving")}
                  />
                ) : null}
              </View>
            ) : null}
            {!composingFeedback && scope && vm ? (
              <SavedWorkflowResults
                key={`${scope.accountId}:${scope.repositoryId}:${selectedJob.jobId}`}
                scope={scope}
                job={selectedJob}
                call={call}
                refresh={refreshJob}
                canConfigure={canConfigure}
                collapsed={vmReviewCollapsed}
                openReviewKey={needsReview && openedVmReviewKey === reviewKey ? reviewKey : null}
                reviewViewport={reviewViewport}
                focused={focused}
                onReviewTargetChange={setReviewingCurrentResult}
              />
            ) : null}
            {canOpenMachineResult &&
            completed &&
            selectedJob.progress &&
            !selectedJob.progress.pullRequestUrl ? (
              <View className="p-4">
                <MaterialButton
                  tone="primary"
                  label={
                    checkpoint && checkpoint.kind !== "input"
                      ? "Inspect result"
                      : "Inspect agent result"
                  }
                  disabled={busy || openingResult === jobKey}
                  onPress={() => openResult(!!checkpoint && checkpoint.kind !== "input")}
                />
              </View>
            ) : null}
            {canOpenMachineResult &&
            !running &&
            !conversationInRunActions &&
            selectedJob.progress &&
            (!completed ||
              !!selectedJob.progress.pullRequestUrl ||
              (!!checkpoint && checkpoint.kind !== "input")) ? (
              <SettingsActionRow
                icon="text.bubble"
                label="Inspect agent result"
                disabled={busy || openingResult === jobKey}
                onPress={() => openResult(false)}
              />
            ) : null}
            {canOpenMachineResult &&
            !primaryMachineDiff &&
            (!completed || !!selectedJob.progress?.pullRequestUrl) &&
            checkpoint &&
            checkpoint.kind !== "input" ? (
              <SettingsActionRow
                icon="doc.text"
                label={completed ? "Inspect result" : "Inspect saved diff"}
                disabled={busy || openingResult === jobKey || checkingReturnedReview}
                onPress={() => openResult(true)}
              />
            ) : null}
            {!terminal &&
            !composingFeedback &&
            !vmReviewCollapsed &&
            (!vm || reviewingCurrentResult) &&
            selectedJob.progress?.checkpoint &&
            viewerControls.canApprove &&
            (manualState.status === "awaiting_review" ||
              (canConfigure &&
                selectedJob.status === "finishing" &&
                selectedJob.progress?.retryableApproval)) ? (
              <SettingsActionRow
                icon="checkmark.circle"
                label={
                  approvalPending
                    ? "Approval pending"
                    : manualState.responsePending
                      ? "Response pending"
                      : selectedJob.progress?.retryableApproval
                        ? selectedJob.status === "finishing"
                          ? "Retry completion"
                          : "Retry approval"
                        : "Approve result"
                }
                disabled={
                  busy ||
                  reviewChanged ||
                  checkingReturnedReview ||
                  manualState.checkpointBlocked ||
                  approvalPending
                }
                onPress={() => respond("approve")}
              />
            ) : null}
            {!terminal &&
            !composingFeedback &&
            !vmReviewCollapsed &&
            (!vm || reviewingCurrentResult) &&
            manualState.status === "awaiting_review" &&
            viewerControls.canRespond &&
            !approvalPending ? (
              <SettingsActionRow
                icon="pencil"
                label="Request changes"
                disabled={busy || manualState.checkpointBlocked}
                onPress={() => {
                  feedbackFocusRequest.current = { key: feedbackKey };
                  setFeedbackView({ key: feedbackKey, open: true });
                }}
              />
            ) : null}
          </SettingsSection>
          {canPause ||
          (canCancel && !cancelling) ||
          conversationInRunActions ||
          (!completed && selectedJob.progress?.pullRequestUrl) ? (
            <RunDetailsDisclosure key={jobKey + ":actions"} label="Run actions" icon="ellipsis">
              {conversationInRunActions ? (
                <SettingsActionRow
                  icon="text.bubble"
                  label="Inspect agent result"
                  disabled={busy || openingResult === jobKey}
                  onPress={() => void openResult(false)}
                />
              ) : null}
              {!completed && selectedJob.progress?.pullRequestUrl ? (
                <SettingsRow
                  icon="link"
                  label="Pull request"
                  value={selectedJob.progress.pullRequestUrl}
                  onPress={() => void Linking.openURL(selectedJob.progress!.pullRequestUrl!)}
                />
              ) : null}
              {canPause ? (
                <SettingsActionRow
                  icon="pause"
                  label={
                    ["preparing", "running", "waiting_capacity"].includes(manualState.status ?? "")
                      ? "Pause after current step"
                      : "Pause workflow"
                  }
                  disabled={busy}
                  onPress={() => respond("pause")}
                />
              ) : null}
              {canCancel && !cancelling ? (
                <SettingsActionRow
                  icon="xmark.circle.fill"
                  label="Cancel run"
                  tone="danger"
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(
                      "Cancel run?",
                      issue?.identifier ?? selectedJob.instruction.slice(0, 140),
                      [
                        { text: "Keep run", style: "cancel" },
                        {
                          text: "Cancel run",
                          style: "destructive",
                          onPress: () => void respond("cancel"),
                        },
                      ],
                    )
                  }
                />
              ) : null}
            </RunDetailsDisclosure>
          ) : null}
          {steps ? (
            <View className="gap-2">
              <Text
                accessibilityRole="header"
                className="px-2 text-sm font-t3-medium text-foreground-muted"
              >
                Run progress
              </Text>
              <RunDetailsDisclosure
                key={jobKey + ":steps"}
                label={terminal ? "View completed workflow steps" : "View workflow steps"}
                expandedLabel="Hide workflow steps"
                icon="text.alignleft"
              >
                <View className="gap-3 p-4">
                  {workflowZones(steps).map((zone) => (
                    <View
                      key={zone[0]!.id}
                      className={
                        zone[0]!.kind === "agent" || zone[0]!.kind === "action"
                          ? "gap-2 border-l-2 border-outline pl-3"
                          : "gap-2 border-l-2 border-amber-500/40 pl-3"
                      }
                    >
                      <Text className="text-xs text-foreground-muted">
                        {zone[0]!.kind === "agent" || zone[0]!.kind === "action"
                          ? "Automatic work"
                          : zone[0]!.kind === "input"
                            ? "Human input"
                            : "Human review"}
                      </Text>
                      {zone.map((step) => (
                        <View
                          key={step.id}
                          className={
                            selectedJob.progress?.stepId === step.id ||
                            selectedJob.progress?.checkpoint?.stepId === step.id
                              ? step.kind === "agent" || step.kind === "action"
                                ? "gap-1 rounded-lg bg-grouped-card p-2"
                                : "gap-1 rounded-lg bg-amber-500/5 p-2"
                              : "gap-1 p-2"
                          }
                        >
                          <Text className="font-semibold text-foreground">{step.title}</Text>
                          <Text className="text-foreground-muted">
                            {workflowStepState(selectedJob, step.id) === "completed"
                              ? "Completed"
                              : !terminal &&
                                  (selectedJob.progress?.stepId === step.id ||
                                    checkpoint?.stepId === step.id)
                                ? workflowStatusLabel(selectedJob.status)
                                : workflowStepState(selectedJob, step.id) === "pending"
                                  ? "Upcoming"
                                  : workflowStatusLabel(workflowStepState(selectedJob, step.id))}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              </RunDetailsDisclosure>
            </View>
          ) : null}
          {selectedJob.progress?.responses?.length ? (
            <RunDetailsDisclosure label="Checkpoint history" icon="clock">
              {selectedJob.progress.responses.map((response) => (
                <View key={`${response.checkpointId}:${response.operation}`} className="gap-1 p-4">
                  <View className="flex-row flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <Text className="shrink font-semibold text-foreground">
                      {selectedJob.workflow?.definition.steps.find(
                        (step) => step.id === response.stepId,
                      )?.title ?? response.stepId}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      Attempt {response.generation + 1}
                    </Text>
                  </View>
                  <Text className="text-foreground">{response.operation.replaceAll("_", " ")}</Text>
                  <View className="flex-row flex-wrap justify-between gap-x-4 gap-y-1">
                    <Text className="text-xs text-foreground-muted">{response.userId}</Text>
                    <Text className="text-xs text-foreground-muted">
                      {new Date(response.createdAt).toLocaleString()}
                    </Text>
                  </View>
                  {response.text ? <Text className="text-foreground">{response.text}</Text> : null}
                </View>
              ))}
            </RunDetailsDisclosure>
          ) : null}
          {Object.entries(responseDrafts).some(
            ([id, text]) =>
              (terminal ||
                !viewerControls.canRespond ||
                approvalPending ||
                !["awaiting_review", "awaiting_input"].includes(manualState.status ?? "") ||
                id !== selectedJob.progress?.checkpoint?.checkpointId) &&
              !!text.trim(),
          ) ? (
            <SettingsSection title="Retained checkpoint drafts">
              {Object.entries(responseDrafts)
                .filter(
                  ([id, text]) =>
                    (terminal ||
                      !viewerControls.canRespond ||
                      approvalPending ||
                      !["awaiting_review", "awaiting_input"].includes(manualState.status ?? "") ||
                      id !== selectedJob.progress?.checkpoint?.checkpointId) &&
                    !!text.trim(),
                )
                .map(([id, text]) => (
                  <View key={id} className="gap-2 p-4">
                    <Text selectable className="text-foreground">
                      {text}
                    </Text>
                    <SettingsActionRow
                      icon="trash"
                      label="Discard previous draft"
                      onPress={() =>
                        Alert.alert("Discard this draft?", "This removes the unsent response.", [
                          { text: "Keep draft", style: "cancel" },
                          {
                            text: "Discard",
                            style: "destructive",
                            onPress: () =>
                              setResponseDrafts((previous) => {
                                const next = { ...previous };
                                delete next[id];
                                return next;
                              }),
                          },
                        ])
                      }
                    />
                  </View>
                ))}
            </SettingsSection>
          ) : null}
          <RunDetailsDisclosure label="Run context" icon="text.alignleft">
            <View className="gap-2 p-4">
              <WorkflowIssueDetails key={jobKey} job={selectedJob} />
              {selectedJob.origin?.kind === "automation" ? (
                <Text className="text-xs text-foreground-muted">Started by workflow</Text>
              ) : null}
            </View>
          </RunDetailsDisclosure>
        </ScreenScrollView>
      ) : selectedJobId && selectedRepository ? (
        <SettingsSection title="Workflow run">
          {read.error ? (
            <View className="p-4">
              <ErrorBanner title="Could not load this run" message={read.error}>
                <MaterialButton
                  label="Retry loading run"
                  disabled={read.reading}
                  onPress={() => void refreshJob()}
                />
              </ErrorBanner>
            </View>
          ) : (
            <Text className="p-4 text-foreground-muted">Loading run…</Text>
          )}
          <SettingsActionRow icon="chevron.left" label="Back to jobs" onPress={backToJobs} />
        </SettingsSection>
      ) : selectedRepository ? (
        <>
          <WorkflowSourceHealth
            key={(userId ?? "") + ":" + selectedRepository.repository.repositoryId}
            repositoryId={selectedRepository.repository.repositoryId}
            focused={focused}
          />
          <SettingsSection title="Runs">
            <View className="gap-1 px-4 pt-4">
              <Text className="text-sm font-t3-medium text-foreground">
                {selectedRepository.repository.name}
              </Text>
              {selectedRepository.repository.canonicalKeys[0] ? (
                <Text className="text-xs text-foreground-muted">
                  {selectedRepository.repository.canonicalKeys[0]}
                </Text>
              ) : null}
            </View>
            <View className="px-4 pt-3">
              <SegmentedControl
                role="tab"
                size="compact"
                options={[
                  { value: "active", label: "Active" },
                  { value: "attention", label: "Needs attention" },
                  { value: "history", label: "History" },
                ]}
                selected={listView}
                onSelect={setListView}
              />
            </View>
            <Text className="p-4 text-xs text-foreground-muted">
              {listView === "history"
                ? "Completed runs, newest first."
                : listView === "attention"
                  ? "Runs that need your attention, oldest first."
                  : "Active runs, oldest first."}
            </Text>
            <SettingsActionRow
              icon="arrow.clockwise"
              label="Refresh jobs"
              disabled={recent.key === listKey && !!recent.request}
              onPress={() => void loadJobs()}
            />
            {recent.key === listKey && recent.error ? (
              <View className="p-4">
                <ErrorBanner
                  title={jobs ? "Could not refresh runs" : "Could not load runs"}
                  message={
                    recent.error +
                    (jobs ? " Showing the last available runs." : " Refresh to retry.")
                  }
                >
                  <MaterialButton
                    label="Retry loading runs"
                    disabled={!!recent.request}
                    onPress={() => void loadJobs()}
                  />
                </ErrorBanner>
              </View>
            ) : null}
            {jobs === null ? (
              recent.key !== listKey || !recent.error ? (
                <Text className="p-4 text-foreground-muted">Loading runs…</Text>
              ) : null
            ) : jobs.length === 0 ? (
              <Text className="p-4 text-foreground-muted">
                No runs in this view. Create and run workflows from Workflows on web or desktop.
              </Text>
            ) : (
              jobs.map((job) => (
                <SettingsRow
                  key={job.jobId}
                  icon="arrow.triangle.branch"
                  label={job.instruction}
                  subtitle={`${job.originSummary?.workflowName ?? "Workflow run"}${job.originSummary?.kind === "automation" ? "\nStarted by workflow" : ""}${(job.targetKind ?? job.runtime?.kind) === "vm" ? "\nWorkflow VM" : ""}\nSubmitted ${new Date(job.createdAt).toLocaleString()}`}
                  value={workflowStatusLabel(job.status)}
                  valuePosition="trailing"
                  disabled={busy}
                  onPress={() => setSelectedJobId(job.jobId)}
                />
              ))
            )}
            {recent.key === listKey && recent.nextCursor ? (
              <SettingsActionRow
                icon="chevron.down"
                label="Load more runs"
                disabled={!!recent.request}
                onPress={() => void loadJobs(recent.nextCursor)}
              />
            ) : null}
            <SettingsActionRow
              icon="chevron.left"
              label="Back to repositories"
              onPress={() => setSelectedRepository(null)}
            />
          </SettingsSection>
        </>
      ) : (
        <ScreenScrollView
          className="flex-1"
          contentContainerClassName="px-5 pt-4 pb-6"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          <SettingsSection title="Choose a repository">
            {!workflowAccountReady || catalogRead.status === "loading" ? (
              <Text accessibilityLiveRegion="polite" className="p-4 text-foreground-muted">
                Loading repositories…
              </Text>
            ) : catalogRead.status === "error" ? (
              <View className="p-4">
                <ErrorBanner title="Couldn’t load repositories" message={catalogRead.message}>
                  <MaterialButton label="Retry" onPress={refreshRepositories} />
                </ErrorBanner>
              </View>
            ) : repositories.length === 0 ? (
              <View className="gap-2 p-4">
                <Text className="font-t3-medium text-foreground">No repositories available</Text>
                <Text className="text-sm text-foreground-muted">
                  {membership?.role === "admin"
                    ? "Add a repository in Organization settings on web or desktop."
                    : "Ask an organization admin to give you access to a repository."}
                </Text>
                <MaterialButton
                  label="Refresh repositories"
                  tone="text"
                  onPress={refreshRepositories}
                />
              </View>
            ) : (
              <>
                <View className="p-4">
                  <AppTextInput
                    accessibilityLabel="Search repositories"
                    autoCapitalize="none"
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                    onChangeText={setRepositoryQuery}
                    placeholder="Search repositories"
                    returnKeyType="search"
                    value={repositoryQuery}
                  />
                </View>
                {noRepositoryMatches ? (
                  <View className="gap-2 px-4 pb-4">
                    <Text accessibilityLiveRegion="polite" className="text-foreground-muted">
                      {NO_REPOSITORY_MATCHES_MESSAGE}
                    </Text>
                    <MaterialButton
                      label="Clear search"
                      tone="text"
                      onPress={() => setRepositoryQuery("")}
                    />
                  </View>
                ) : (
                  matchingRepositories.map((entry) => (
                    <SettingsRow
                      key={entry.repository.repositoryId}
                      icon="folder"
                      label={entry.repository.name}
                      subtitle={workflowRepositoryRemote(entry.repository, repositoryQuery)}
                      disabled={busy}
                      onPress={() => {
                        setError(null);
                        setSelectedJobId(null);
                        setSelectedRepository(entry);
                      }}
                    />
                  ))
                )}
              </>
            )}
          </SettingsSection>
        </ScreenScrollView>
      )}
    </SettingsScreen>
  );
}
