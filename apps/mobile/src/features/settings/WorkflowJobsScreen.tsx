import { useAuth } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { ManagedRelay, ManagedRelayTenancy } from "@t3tools/client-runtime/relay";
import {
  clearAcknowledgedWorkflowDraft,
  workflowManualControlState,
  workflowManualSubmission,
  type WorkflowManualSubmission,
} from "@t3tools/client-runtime/relay/workflow-responses";
import type { RelayRepositorySummary, RelayOrganizationMembership } from "@t3tools/contracts/relay";
import {
  isTerminalWorkflowJob,
  workflowZones,
  type RepositoryWorkflowJob,
  type RepositoryWorkflowJobSummary,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View, TextInput } from "react-native";
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

export function WorkflowJobsScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredWorkflowJobsScreen />
  ) : (
    <SettingsScreen title="Workflow jobs">
      <Text className="text-foreground-muted">Launchpad Connect is not configured.</Text>
    </SettingsScreen>
  );
}

function ConfiguredWorkflowJobsScreen() {
  const { getToken, isSignedIn, userId } = useAuth();
  const navigation = useNavigation();
  const [repositories, setRepositories] = useState<ReadonlyArray<RelayRepositorySummary>>([]);
  const [membership, setMembership] = useState<RelayOrganizationMembership | null>(null);
  const [selectedRepository, setSelectedRepository] = useState<RelayRepositorySummary | null>(null);
  const [jobs, setJobs] = useState<ReadonlyArray<RepositoryWorkflowJobSummary>>([]);
  const [selectedJob, setSelectedJob] = useState<RepositoryWorkflowJob | null>(null);
  const manualIntent = useRef<WorkflowManualSubmission | null>(null);
  const manualState = workflowManualControlState(selectedJob);
  const [responseDrafts, setResponseDrafts] = useState<Record<string, string>>({});
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
      if (!token) throw new Error("Sign in to Launchpad to view repository jobs.");
      const result = await runtime.runPromiseExit(
        ManagedRelayTenancy.ManagedRelayTenancyClient.pipe(
          Effect.flatMap((client) => operation(client, token)),
        ),
      );
      if (Exit.isFailure(result)) throw Cause.squash(result.cause);
      return result.value;
    },
    [getToken],
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
    ]).then(
      ([entries, member]) => {
        if (!disposed) {
          setRepositories(entries);
          setMembership(member);
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
  }, [isSignedIn, call]);
  const selectedJobId = selectedJob?.jobId;
  const selectedJobStatus = selectedJob?.status;
  useEffect(() => {
    if (
      !selectedJobId ||
      !selectedJobStatus ||
      isTerminalWorkflowJob(selectedJobStatus) ||
      !selectedRepository
    )
      return;
    let disposed = false;
    let pending = false;
    const timer = setInterval(() => {
      if (pending || AppState.currentState !== "active") return;
      pending = true;
      void call((client, clerkToken) =>
        client.getWorkflowJob({
          clerkToken,
          repositoryId: selectedRepository.repository.repositoryId,
          jobId: selectedJobId,
        }),
      )
        .then((next) => {
          if (!disposed) {
            setSelectedJob(next);
            setJobs((previous) => previous.map((job) => (job.jobId === next.jobId ? next : job)));
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selectedJobId, selectedJobStatus, selectedRepository, call]);
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
      if (!selectedJob || !selectedRepository) return;
      const checkpoint = selectedJob.progress?.checkpoint;
      if (["approve", "input", "request_changes"].includes(operation) && !checkpoint) return;
      if (operation === "pause" || operation === "resume")
        manualIntent.current = workflowManualSubmission(
          manualIntent.current,
          selectedJob,
          operation,
          uuidv4,
        );
      const payload =
        operation === "pause" || operation === "resume"
          ? manualIntent.current!.control
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
      const next = await call((client, clerkToken) =>
        client.respondToWorkflowJob({
          clerkToken,
          repositoryId: selectedRepository.repository.repositoryId,
          jobId: selectedJob.jobId,
          payload,
        }),
      );
      setSelectedJob(next);
      setResponseDrafts((previous) =>
        clearAcknowledgedWorkflowDraft(previous, submitted, next.progress),
      );
    });
  const openResult = (diff: boolean) => {
    if (!selectedJob?.progress || selectedJob.progress.hasThread === false) return;
    const params = {
      environmentId: selectedJob.environmentId,
      threadId: selectedJob.progress.threadId,
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
      {!isSignedIn ? (
        <Text className="text-foreground-muted">Sign in to view repository jobs.</Text>
      ) : selectedJob ? (
        <View className="gap-4">
          <SettingsSection title={selectedJob.workflow?.definition.name ?? "Workflow job"}>
            <View className="gap-2 p-4">
              <Text className="text-foreground">{selectedJob.instruction}</Text>
              <Text className="font-semibold text-foreground">
                {selectedJob.status.replaceAll("_", " ")}
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
          {selectedJob.workflow ? (
            <View className="gap-3">
              {workflowZones(selectedJob.workflow.definition.steps).map((zone) => (
                <View
                  key={zone[0]!.id}
                  className={
                    zone[0]!.kind === "agent"
                      ? "gap-2 rounded-xl border border-outline bg-grouped-card p-4"
                      : "gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
                  }
                >
                  <Text className="text-xs text-foreground-muted">
                    {zone[0]!.kind === "agent" ? "AUTOMATIC WORK" : "HUMAN INTERVENTION"}
                  </Text>
                  {zone.map((step) => (
                    <View key={step.id}>
                      <Text className="font-semibold text-foreground">{step.title}</Text>
                      <Text className="text-foreground-muted">
                        {selectedJob.progress?.steps?.find((entry) => entry.stepId === step.id)
                          ?.status ??
                          (step.kind === "agent"
                            ? "Agent work"
                            : step.role === "member"
                              ? "Any repository member"
                              : "Repository maintainer")}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          ) : null}
          {(manualState.status === "awaiting_input" || manualState.status === "awaiting_review") &&
          (canRespond || selectedJob.progress?.checkpoint?.role === "member") &&
          selectedJob.progress?.checkpoint &&
          !selectedJob.progress.approvalPending ? (
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
          <SettingsSection title="Job controls">
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
            {(canRespond || selectedJob.progress?.checkpoint?.role === "member") &&
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
                  respond(selectedJob.status === "cancelling" ? "retry_cancellation" : "cancel")
                }
              />
            ) : null}
            <SettingsActionRow
              icon="chevron.left"
              label="Back to jobs"
              onPress={() => setSelectedJob(null)}
            />
          </SettingsSection>
        </View>
      ) : selectedRepository ? (
        <SettingsSection title={selectedRepository.repository.name}>
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Refresh jobs"
            disabled={busy}
            onPress={() =>
              void perform(async () => {
                setJobs(
                  await call((client, clerkToken) =>
                    client.listWorkflowJobs({
                      clerkToken,
                      repositoryId: selectedRepository.repository.repositoryId,
                    }),
                  ),
                );
              })
            }
          />
          {jobs.length === 0 ? (
            <Text className="p-4 text-foreground-muted">
              No jobs yet. Create and run workflows in Organization settings on web or desktop.
            </Text>
          ) : (
            jobs.map((job) => (
              <SettingsRow
                key={job.jobId}
                icon="arrow.triangle.branch"
                label={job.instruction}
                value={job.status.replaceAll("_", " ")}
                disabled={busy}
                onPress={() =>
                  void perform(async () => {
                    setSelectedJob(
                      await call((client, clerkToken) =>
                        client.getWorkflowJob({
                          clerkToken,
                          repositoryId: selectedRepository.repository.repositoryId,
                          jobId: job.jobId,
                        }),
                      ),
                    );
                  })
                }
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
                onPress={() =>
                  void perform(async () => {
                    const list = await call((client, clerkToken) =>
                      client.listWorkflowJobs({
                        clerkToken,
                        repositoryId: entry.repository.repositoryId,
                      }),
                    );
                    setJobs(list);
                    setSelectedRepository(entry);
                  })
                }
              />
            ))
          )}
        </SettingsSection>
      )}
    </SettingsScreen>
  );
}
