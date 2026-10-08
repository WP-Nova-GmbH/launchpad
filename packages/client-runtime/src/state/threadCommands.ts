import * as Effect from "effect/Effect";
import { IssueTrackerClientRegistry } from "../relay/issueTrackerTurn.ts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";
import {
  WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import { canSnooze } from "./threadSettled.ts";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type ResolveThreadQueueInput,
  resolveThreadQueue,
  type RetryThreadPreparationInput,
  retryThreadPreparation,
  type EnqueueThreadPromptInput,
  enqueueThreadPrompt,
  type EditThreadPromptInput,
  editThreadPrompt,
  type RemoveThreadPromptInput,
  removeThreadPrompt,
  type SteerThreadPromptInput,
  steerThreadPrompt,
  type PauseThreadQueueInput,
  pauseThreadQueue,
  type ResumeThreadQueueInput,
  resumeThreadQueue,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type LinkThreadPullRequestInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type DismissThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type ReorderActiveThreadInput,
  type SetThreadAutoSettleInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnlinkThreadPullRequestInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  createThread,
  deleteThread,
  interruptThreadTurn,
  linkThreadPullRequest,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  setThreadAutoSettle,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  RetryThreadPreparationInput,
  EnqueueThreadPromptInput,
  EditThreadPromptInput,
  RemoveThreadPromptInput,
  SteerThreadPromptInput,
  PauseThreadQueueInput,
  ResumeThreadQueueInput,
  ResolveThreadQueueInput,
  ArchiveThreadInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  LinkThreadPullRequestInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  DismissThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  ReorderActiveThreadInput,
  SetThreadAutoSettleInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnlinkThreadPullRequestInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationShellSnapshot | null>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const commands = {
    retryPreparation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.preparation.retry",
      execute: (input: RetryThreadPreparationInput) => retryThreadPreparation(input),
      scheduler,
      concurrency,
    }),
    resolveQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.queue.resolve",
      execute: (input: ResolveThreadQueueInput) => resolveThreadQueue(input),
      scheduler,
      concurrency,
    }),
    enqueuePrompt: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.prompt.enqueue",
      execute: (input: EnqueueThreadPromptInput, registry) =>
        enqueueThreadPrompt(input).pipe(
          Effect.provideService(IssueTrackerClientRegistry, registry),
        ),
      scheduler,
      concurrency,
    }),
    editPrompt: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.prompt.edit",
      execute: (input: EditThreadPromptInput, registry) =>
        editThreadPrompt(input).pipe(Effect.provideService(IssueTrackerClientRegistry, registry)),
      scheduler,
      concurrency,
    }),
    removePrompt: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.prompt.remove",
      execute: (input: RemoveThreadPromptInput) => removeThreadPrompt(input),
      scheduler,
      concurrency,
    }),
    steerPrompt: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.prompt.steer",
      execute: (input: SteerThreadPromptInput) => steerThreadPrompt(input),
      scheduler,
      concurrency,
    }),
    pauseQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.queue.pause",
      execute: (input: PauseThreadQueueInput) => pauseThreadQueue(input),
      scheduler,
      concurrency,
    }),
    resumeQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread.queue.resume",
      execute: (input: ResumeThreadQueueInput) => resumeThreadQueue(input),
      scheduler,
      concurrency,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    setAutoSettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-auto-settle",
      execute: (input: SetThreadAutoSettleInput) => setThreadAutoSettle(input),
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: (input: ReorderActiveThreadInput) => reorderActiveThread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: (input: LinkThreadPullRequestInput) => linkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: (input: UnlinkThreadPullRequestInput) => unlinkThreadPullRequest(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput, registry) =>
        startThreadTurn(input).pipe(Effect.provideService(IssueTrackerClientRegistry, registry)),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput, registry) =>
        respondToThreadApproval(input).pipe(
          Effect.provideService(IssueTrackerClientRegistry, registry),
        ),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: (input: DismissThreadUserInputInput) => dismissThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    getCommandReceipt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:command-receipt",
      tag: ORCHESTRATION_WS_METHODS.getCommandReceipt,
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
  const optimistic = createOptimisticThreadLifecycle(snapshotAtom);
  return {
    ...commands,
    snapshotAtom: optimistic.snapshotAtom,
    settle: optimistic.wrap(commands.settle, (thread, _input, now, accepted) =>
      !accepted &&
      (!canSnooze(thread, { now }) ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running")
        ? thread
        : {
            ...thread,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            settledOverride: "settled",
            settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
            unsettledAt: null,
            activeOrderKey: null,
            pinnedAt: null,
            pinOrderKey: null,
            snoozedAt: null,
            snoozedUntil: null,
          },
    ),
    unsettle: optimistic.wrap(commands.unsettle, (thread, input, now) => ({
      ...thread,
      settledOverride: input.reason === "user" ? "active" : null,
      settledAt: null,
      unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now,
    })),
    snooze: optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
      (!accepted && !canSnooze(thread, { now })) ||
      !(Date.parse(input.snoozedUntil) > Date.parse(now))
        ? thread
        : {
            ...thread,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            snoozedUntil: input.snoozedUntil,
            snoozedAt: thread.snoozedUntil === input.snoozedUntil ? (thread.snoozedAt ?? now) : now,
          },
    ),
    unsnooze: optimistic.wrap(commands.unsnooze, (thread) => ({
      ...thread,
      snoozedUntil: null,
      snoozedAt: null,
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
  };
}
