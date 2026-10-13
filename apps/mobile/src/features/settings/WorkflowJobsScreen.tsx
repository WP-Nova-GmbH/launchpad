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
  recentWorkflowJobs,
  type WorkflowScope,
} from "@t3tools/client-runtime/relay/workflow-session";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAuth } from "@clerk/expo";
import { useNavigation, useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  workflowManualControlState,
  workflowManualSubmission,
} from "@t3tools/client-runtime/relay/workflow-responses";
import type {
  RelayRepositorySummary,
  RelayOrganizationMembership,
  RelayOrganizationProject,
} from "@t3tools/contracts/relay";
import {
  isTerminalWorkflowJob,
  workflowZones,
  type RepositoryWorkflowJobSummary,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { useCallback, useEffect, useState, useMemo } from "react";
import { Alert, AppState, View, TextInput } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { runtime } from "../../lib/runtime";
import { uuidv4 } from "../../lib/uuid";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsRow } from "./components/SettingsRow";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { setReviewSelectedSectionId } from "../review/reviewState";

type Client = ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];

type Props = StaticScreenProps<{ repositoryId?: string; jobId?: string } | undefined>;
export function WorkflowJobsScreen(props: Props) {
  return hasCloudPublicConfig() ? (
    <ConfiguredWorkflowJobsScreen {...props} />
  ) : (
    <SettingsScreen title="Workflow jobs">
      <Text className="text-foreground-muted">Launchpad Connect is not configured.</Text>
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
  const navigation = useNavigation();
  const focused = useIsFocused();
  const [repositories, setRepositories] = useState<ReadonlyArray<RelayRepositorySummary>>([]);
  const [membership, setMembership] = useState<RelayOrganizationMembership | null>(null);
  const [selectedRepository, setSelectedRepository] = useState<RelayRepositorySummary | null>(null);
  const [recent, setRecent] = useState<{
    key: string;
    jobs: ReadonlyArray<RepositoryWorkflowJobSummary> | null;
    loading: boolean;
    error: string | null;
  }>({ key: "", jobs: null, loading: false, error: null });
  const [listRefresh, setListRefresh] = useState(0);
  const [projects, setProjects] = useState<ReadonlyArray<RelayOrganizationProject>>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    props.route.params?.jobId ?? null,
  );
  const drafts = useAtomValue(workflowDraftAtom);
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
  const listKey = scope ? workflowSessionKey(scope, "recent") : "";
  const jobs = recent.key === listKey ? recent.jobs : null;
  const read = reads.jobs[jobKey] ?? emptyWorkflowJobRead;
  const selectedJob = read.job;
  const manualState = workflowManualControlState(selectedJob);
  const terminal = !!selectedJob && isTerminalWorkflowJob(selectedJob.status);
  const responseDrafts = drafts.responses[jobKey] ?? {};
  const [feedbackOpen, setFeedbackOpen] = useState(false);
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
  const call = useCallback(
    async <A,>(
      operation: (
        client: Client,
        clerkToken: string,
      ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
    ) => {
      const token = await getToken(resolveRelayClerkTokenOptions());
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
    [getToken, userId],
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
    if (!isSignedIn) return;
    let disposed = false;
    void Promise.all([
      call((client, clerkToken) => client.listRepositories({ clerkToken })),
      call((client, clerkToken) => client.getOrganization({ clerkToken })),
      call((client, clerkToken) => client.listOrganizationProjects({ clerkToken })),
    ]).then(
      ([entries, member, organizationProjects]) => {
        if (!disposed) {
          setRepositories(entries);
          setMembership(member);
          setProjects(organizationProjects);
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
          setError(cause instanceof Error ? cause.message : "Could not load repository jobs.");
      },
    );
    return () => {
      disposed = true;
    };
  }, [isSignedIn, call, props.route.params?.repositoryId]);
  useEffect(() => {
    if (!scope || !focused) return;
    let disposed = false;
    // oxlint-disable-next-line react/set-state-in-effect -- Mark this external relay read pending before its asynchronous result.
    setRecent((previous) =>
      previous.key === listKey
        ? { ...previous, loading: true, error: null }
        : { key: listKey, jobs: null, loading: true, error: null },
    );
    void call((client, clerkToken) =>
      client.listWorkflowJobs({ clerkToken, repositoryId: scope.repositoryId }),
    ).then(
      (list) => {
        if (!disposed) setRecent({ key: listKey, jobs: list, loading: false, error: null });
      },
      (cause) => {
        if (!disposed)
          setRecent((previous) => ({
            key: listKey,
            jobs: previous.key === listKey ? previous.jobs : null,
            loading: false,
            error: cause instanceof Error ? cause.message : "Could not load recent runs.",
          }));
      },
    );
    return () => {
      disposed = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit Refresh starts a new read without changing repository selection.
  }, [scope, focused, listKey, call, listRefresh]);
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
      );
    }
  }, [call, scope, selectedJobId]);
  useEffect(() => {
    if (scope && selectedJobId && focused)
      activateWorkflowJobView(appAtomRegistry, scope, selectedJobId);
  }, [scope, selectedJobId, focused]);
  useEffect(() => {
    if (!scope || !selectedJobId || read.mutation || !focused) return;
    void refreshJob();
    if (terminal) return;
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refreshJob();
    }, 5000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshJob();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
      invalidateWorkflowJobRead(appAtomRegistry, scope, selectedJobId);
    };
  }, [refreshJob, terminal, read.mutation, scope, selectedJobId, focused]);
  const target = selectedJob?.workflow
    ? projects.find(
        (project) =>
          project.environmentId === selectedJob.environmentId &&
          project.projectId === selectedJob.workflow?.definition.projectId,
      )
    : undefined;
  const canRespond = membership?.role === "admin" || selectedRepository?.role === "maintainer";
  const respond = (
    operation:
      | "approve"
      | "input"
      | "request_changes"
      | "cancel"
      | "retry_preparation"
      | "retry_cancellation"
      | "pause"
      | "resume",
  ) =>
    void perform(async () => {
      if (!selectedJob || !selectedRepository || !scope) return;
      const checkpoint = selectedJob.progress?.checkpoint;
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
        operation === "pause" || operation === "resume"
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
  const openResult = (diff: boolean) => {
    if (!selectedJob?.progress || selectedJob.progress.hasThread === false || !scope) return;
    const params = {
      environmentId: selectedJob.environmentId,
      threadId: selectedJob.progress.threadId,
      workflowOrigin: { ...scope, jobId: selectedJob.jobId },
    };
    if (
      diff &&
      selectedJob.progress.checkpoint &&
      selectedJob.progress.checkpoint.kind !== "input"
    ) {
      setReviewSelectedSectionId(
        scopedThreadKey(params.environmentId, params.threadId),
        `turn:${selectedJob.progress.checkpoint.checkpointTurnCount}`,
      );
      navigation.navigate("ThreadReview", params);
    } else navigation.navigate("Thread", params);
  };
  return (
    <SettingsScreen title="Workflow jobs">
      {error ? (
        <Text accessibilityRole="alert" className="mb-3 text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {read.error ? (
        <Text accessibilityRole="alert" className="mb-3 text-danger-foreground">
          {read.error}
        </Text>
      ) : null}
      {!isSignedIn ? (
        <Text className="text-foreground-muted">Sign in to view repository jobs.</Text>
      ) : selectedJob ? (
        <View className="gap-4">
          <SettingsSection title={selectedJob.workflow?.definition.name ?? "Workflow job"}>
            <View className="gap-2 p-4">
              <Text className="text-foreground">{selectedJob.instruction}</Text>
              <Text className="font-semibold text-foreground">
                {workflowStatusLabel(selectedJob.status)} ·{" "}
                {target
                  ? target.machineLabel + " · " + target.title
                  : "Organization execution target"}
              </Text>
              {manualState.message ? (
                <Text className="text-foreground-muted">{manualState.message}</Text>
              ) : null}
              {selectedJob.progress?.manualPause?.state === "paused" ? (
                <Text className="text-foreground-muted">
                  Next: {manualState.status?.replaceAll("_", " ")}
                </Text>
              ) : null}
              {selectedJob.detail ? (
                <Text className="text-foreground-muted">{selectedJob.detail}</Text>
              ) : null}
            </View>
          </SettingsSection>
          <SettingsSection title="Current task">
            {selectedJob.progress && selectedJob.progress.hasThread !== false ? (
              <SettingsActionRow
                icon="text.bubble"
                label="Inspect agent result"
                onPress={() => openResult(false)}
              />
            ) : null}
            {selectedJob.progress?.checkpoint &&
            selectedJob.progress.checkpoint.kind !== "input" ? (
              <SettingsActionRow
                icon="doc.text"
                label="Inspect saved diff"
                onPress={() => openResult(true)}
              />
            ) : null}
            {!terminal &&
            selectedJob.progress?.checkpoint &&
            (canRespond || selectedJob.progress?.checkpoint?.role === "member") &&
            (manualState.status === "awaiting_review" ||
              (canRespond &&
                selectedJob.status === "finishing" &&
                selectedJob.progress?.retryableApproval)) ? (
              <SettingsActionRow
                icon="checkmark.circle"
                label={
                  selectedJob.progress?.approvalPending
                    ? "Approval pending"
                    : selectedJob.progress?.retryableApproval
                      ? selectedJob.status === "finishing"
                        ? "Retry completion"
                        : "Retry approval"
                      : "Approve result"
                }
                disabled={
                  busy || manualState.checkpointBlocked || selectedJob.progress?.approvalPending
                }
                onPress={() => respond("approve")}
              />
            ) : null}
            {manualState.status === "awaiting_review" &&
            (canRespond || selectedJob.progress?.checkpoint?.role === "member") &&
            !selectedJob.progress?.approvalPending ? (
              <SettingsActionRow
                icon="pencil"
                label="Request changes"
                onPress={() => setFeedbackOpen(true)}
              />
            ) : null}
          </SettingsSection>
          {!terminal &&
          (manualState.status === "awaiting_input" || manualState.status === "awaiting_review") &&
          (canRespond || selectedJob.progress?.checkpoint?.role === "member") &&
          selectedJob.progress?.checkpoint &&
          !selectedJob.progress.approvalPending &&
          (manualState.status === "awaiting_input" ||
            feedbackOpen ||
            !!responseDrafts[selectedJob.progress.checkpoint.checkpointId]) ? (
            <SettingsSection
              title={manualState.status === "awaiting_input" ? "Required input" : "Request changes"}
            >
              <View className="gap-2 p-4">
                <Text className="text-foreground">
                  {selectedJob.progress?.checkpoint?.kind === "input"
                    ? selectedJob.progress.checkpoint.question
                    : "Feedback for the agent"}
                </Text>
                <TextInput
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
                  Your draft is kept until the environment acknowledges it.
                </Text>
              </View>
              <SettingsActionRow
                icon="checkmark.circle"
                label={
                  manualState.status === "awaiting_input" ? "Submit answer" : "Request changes"
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
            </SettingsSection>
          ) : null}
          {Object.entries(responseDrafts).some(
            ([id, text]) =>
              (terminal ||
                selectedJob.progress?.approvalPending ||
                !["awaiting_review", "awaiting_input"].includes(manualState.status ?? "") ||
                id !== selectedJob.progress?.checkpoint?.checkpointId) &&
              !!text.trim(),
          ) ? (
            <SettingsSection title="Retained checkpoint drafts">
              {Object.entries(responseDrafts)
                .filter(
                  ([id, text]) =>
                    (terminal ||
                      selectedJob.progress?.approvalPending ||
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
          <SettingsSection title="Run controls">
            {canRespond &&
            manualState.status === "paused" &&
            selectedJob.progress?.retryablePreparation ? (
              <SettingsActionRow
                icon="arrow.clockwise"
                label="Retry preparation"
                disabled={busy || manualState.checkpointBlocked}
                onPress={() => respond("retry_preparation")}
              />
            ) : null}
            {canRespond && (manualState.canPause || manualState.canResume) ? (
              <SettingsActionRow
                icon={manualState.canResume ? "play" : "pause"}
                label={manualState.canResume ? "Resume workflow" : "Pause workflow"}
                disabled={busy}
                onPress={() => respond(manualState.canResume ? "resume" : "pause")}
              />
            ) : null}
            {canRespond && !isTerminalWorkflowJob(selectedJob.status) ? (
              <SettingsActionRow
                icon="xmark.circle.fill"
                label={
                  selectedJob.status === "cancelling"
                    ? selectedJob.progress?.retryableCancellation
                      ? "Retry cancellation"
                      : "Cancellation pending"
                    : "Cancel job"
                }
                tone="danger"
                disabled={
                  busy ||
                  (selectedJob.status === "cancelling" &&
                    !selectedJob.progress?.retryableCancellation)
                }
                onPress={() =>
                  selectedJob.status === "cancelling"
                    ? void respond("retry_cancellation")
                    : Alert.alert("Cancel run?", selectedJob.instruction, [
                        { text: "Keep run", style: "cancel" },
                        {
                          text: "Cancel run",
                          style: "destructive",
                          onPress: () => void respond("cancel"),
                        },
                      ])
                }
              />
            ) : null}
            <SettingsActionRow
              icon="chevron.left"
              label="Back to jobs"
              onPress={() => {
                setSelectedJobId(null);
                setListRefresh((version) => version + 1);
              }}
            />
          </SettingsSection>
          {selectedJob.workflow ? (
            <View className="gap-3">
              {workflowZones(selectedJob.workflow.definition.steps).map((zone) => (
                <View
                  key={zone[0]!.id}
                  className={
                    zone[0]!.kind === "agent"
                      ? "gap-2 border-l-2 border-outline pl-3"
                      : "gap-2 border-l-2 border-amber-500/40 pl-3"
                  }
                >
                  <Text className="text-xs text-foreground-muted">
                    {zone[0]!.kind === "agent"
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
                          ? step.kind === "agent"
                            ? "gap-1 rounded-lg bg-grouped-card p-2"
                            : "gap-1 rounded-lg bg-amber-500/5 p-2"
                          : "gap-1 p-2"
                      }
                    >
                      <Text className="font-semibold text-foreground">{step.title}</Text>
                      <Text className="text-foreground-muted">
                        {workflowStepState(selectedJob, step.id)}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          ) : null}
          {selectedJob.progress?.responses?.length ? (
            <SettingsSection title="Recent checkpoint history">
              {selectedJob.progress.responses.map((response) => (
                <View key={response.checkpointId} className="gap-1 p-4">
                  <Text className="text-foreground">
                    {selectedJob.workflow?.definition.steps.find(
                      (step) => step.id === response.stepId,
                    )?.title ?? response.stepId}{" "}
                    · {response.operation.replaceAll("_", " ")} · attempt {response.generation + 1}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {response.userId} · {new Date(response.createdAt).toLocaleString()}
                  </Text>
                  {response.text ? <Text className="text-foreground">{response.text}</Text> : null}
                </View>
              ))}
            </SettingsSection>
          ) : null}
        </View>
      ) : selectedJobId && selectedRepository ? (
        <SettingsSection title="Workflow run">
          <Text className="p-4 text-foreground-muted">{read.error ?? "Loading run…"}</Text>
          <SettingsActionRow
            icon="chevron.left"
            label="Back to jobs"
            onPress={() => {
              setSelectedJobId(null);
              setListRefresh((version) => version + 1);
            }}
          />
        </SettingsSection>
      ) : selectedRepository ? (
        <SettingsSection title={selectedRepository.repository.name + " · Recent runs"}>
          <Text className="p-4 text-xs text-foreground-muted">
            Shows up to the latest 100 runs. Older waiting checkpoints may be outside this view.
          </Text>
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Refresh jobs"
            disabled={recent.key === listKey && recent.loading}
            onPress={() => setListRefresh((version) => version + 1)}
          />
          {recent.key === listKey && recent.error ? (
            <Text accessibilityRole="alert" className="p-4 text-danger-foreground">
              {recent.error}
              {jobs ? " Showing the last available recent runs." : " Refresh to retry."}
            </Text>
          ) : null}
          {jobs === null ? (
            recent.key !== listKey || !recent.error ? (
              <Text className="p-4 text-foreground-muted">Loading recent runs…</Text>
            ) : null
          ) : jobs.length === 0 ? (
            <Text className="p-4 text-foreground-muted">
              No recent runs. Create and run workflows from Workflows on web or desktop.
            </Text>
          ) : (
            recentWorkflowJobs(jobs).map((job) => (
              <SettingsRow
                key={job.jobId}
                icon="arrow.triangle.branch"
                label={job.instruction}
                value={workflowStatusLabel(job.status)}
                disabled={busy}
                onPress={() => setSelectedJobId(job.jobId)}
              />
            ))
          )}
          <SettingsActionRow
            icon="chevron.left"
            label="Back to repositories"
            onPress={() => setSelectedRepository(null)}
          />
        </SettingsSection>
      ) : (
        <SettingsSection title="Repositories">
          {repositories.length === 0 ? (
            <Text className="p-4 text-foreground-muted">No repositories available.</Text>
          ) : (
            repositories.map((entry) => (
              <SettingsRow
                key={entry.repository.repositoryId}
                icon="folder"
                label={entry.repository.name}
                disabled={busy}
                onPress={() => {
                  setSelectedJobId(null);
                  setSelectedRepository(entry);
                }}
              />
            ))
          )}
        </SettingsSection>
      )}
    </SettingsScreen>
  );
}
