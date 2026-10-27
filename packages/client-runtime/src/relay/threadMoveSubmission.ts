import {
  ThreadMoveEnqueueCommand,
  CommandId,
  EnvironmentId,
  ProjectId,
  type ThreadId,
  type ThreadMoveDestination,
  type ThreadQueueEntry,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { RelayPortableThreadPlacement, RelayThreadVmStatus } from "@t3tools/contracts/relay";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";
import { threadCommandAcceptance, type CommandSubmission } from "../operations/commands.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { projectKey } from "../state/entities.ts";
import type { ConnectionTarget } from "../connection/model.ts";
import { threadRunOnTargetAvailability } from "./threadRunOn.ts";
export { createThreadMoveCancellation } from "./threadMoveCancellation.ts";

const ExecutionProof = Schema.Struct({
  commandId: CommandId,
  environmentId: EnvironmentId,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ThreadMoveExecutionProof = typeof ExecutionProof.Type;
const Submission = Schema.Struct({
  command: ThreadMoveEnqueueCommand,
  originEnvironmentId: EnvironmentId,
  accepted: Schema.optional(Schema.Literal(true)),
  acceptedSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  acceptedViaRelay: Schema.optional(Schema.Literal(true)),
  sourceGeneration: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  executionProof: Schema.optional(ExecutionProof),
  rejection: Schema.optional(Schema.String),
});
const codec = Schema.fromJsonString(Submission);
const decode = Schema.decodeSync(codec),
  encode = Schema.encodeSync(codec);
export type ThreadMoveSubmission = typeof Submission.Type;
export interface ThreadMoveSubmissionScope {
  readonly accountId: string;
  readonly relayUrl: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sourceGeneration?: number;
}
export interface ThreadMoveSubmissionStorage {
  readonly read: (key: string) => Promise<string | null>;
  readonly write: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  /** Platform lock spans the read and write, including other browser tabs. */
  readonly withLock: <A>(key: string, action: () => Promise<A>) => Promise<A>;
}
export interface ThreadMoveSubmissionObservation {
  readonly entries: ReadonlyArray<ThreadQueueEntry>;
  /** Cursor paired with this environment's thread detail, never the shell cursor. */
  readonly projection?: {
    readonly environmentId: string;
    readonly generation: number;
    readonly snapshotSequence: number;
  };
  /** An exact command receipt read directly from the confirmed current environment. */
  readonly executionProof?: ThreadMoveExecutionProof;
  /** Fresh relay placement identifies the owner whose receipt and detail can be compared. */
  readonly placement?: {
    readonly environmentId: string;
    readonly generation: number;
    readonly operationId: string | null;
  };
}
const storageKey = (scope: ThreadMoveSubmissionScope) => {
  const relayUrl = normalizeSecureRelayUrl(scope.relayUrl);
  if (!relayUrl) throw new Error("Configure Launchpad Connect before moving this thread.");
  return `launchpad.thread-move.v2:${JSON.stringify([scope.accountId, relayUrl, scope.threadId])}`;
};

/** Retain the intent through admission until the queue or a completed move takes over. */
export function createThreadMoveSubmissionJournal(storage: ThreadMoveSubmissionStorage) {
  const read = async (scope: ThreadMoveSubmissionScope) => {
    const raw = await storage.read(storageKey(scope));
    if (raw === null) return null;
    const submission = decode(raw);
    if (submission.command.threadId !== scope.threadId)
      throw new Error("Saved move belongs to another thread.");
    return submission;
  };
  const reconcile = async (
    scope: ThreadMoveSubmissionScope,
    submission: ThreadMoveSubmission,
    receipt: Parameters<typeof threadCommandAcceptance>[0],
  ) =>
    storage.withLock(storageKey(scope), async () => {
      if ("relay" in receipt && receipt.relay.commandId !== submission.command.commandId)
        throw new Error("Relay acknowledged a different move.");
      const current = await read(scope);
      const outcome = threadCommandAcceptance(receipt);
      // Another tab may already have observed this exact move in the queue.
      if (current === null && outcome.status === "accepted") return outcome;
      if (current?.command.commandId !== submission.command.commandId)
        throw new Error("Saved move changed while checking acceptance.");
      // A late admission reply cannot erase an already confirmed rejection.
      if (current.rejection) return { status: "rejected" as const, detail: current.rejection };
      if (outcome.status === "accepted") {
        const acceptedSequence =
          current.acceptedSequence ??
          ("relay" in receipt
            ? receipt.relay.receipt?.status === "accepted"
              ? receipt.relay.receipt.sequence
              : undefined
            : receipt.sequence);
        const acceptedViaRelay =
          current.acceptedSequence !== undefined
            ? current.acceptedViaRelay === true
            : "relay" in receipt;
        if (
          !current.accepted ||
          acceptedSequence !== current.acceptedSequence ||
          acceptedViaRelay !== (current.acceptedViaRelay === true)
        )
          await storage.write(
            storageKey(scope),
            encode({
              ...current,
              accepted: true,
              ...(acceptedSequence !== undefined ? { acceptedSequence } : {}),
              acceptedViaRelay: acceptedViaRelay ? true : undefined,
            }),
          );
      } else if (outcome.status === "rejected")
        await storage.write(
          storageKey(scope),
          encode({
            command: current.command,
            originEnvironmentId: current.originEnvironmentId,
            ...(current.sourceGeneration !== undefined
              ? { sourceGeneration: current.sourceGeneration }
              : {}),
            rejection: outcome.detail ?? "The server rejected this move.",
          }),
        );
      return outcome;
    });
  return {
    read,
    reconcile,
    observe: (
      scope: ThreadMoveSubmissionScope,
      submitted: ThreadMoveSubmission,
      observation: ThreadMoveSubmissionObservation,
    ) =>
      storage.withLock(storageKey(scope), async () => {
        const stored = await read(scope);
        if (!stored || stored.command.commandId !== submitted.command.commandId) return stored;
        let current = stored;
        const queued = observation.entries.some(
          (entry) => entry.kind === "move" && entry.messageId === stored.command.messageId,
        );
        const placement = observation.placement;
        const incomingProof = observation.executionProof;
        if (
          !current.rejection &&
          incomingProof?.commandId === current.command.commandId &&
          placement?.operationId === null &&
          incomingProof.environmentId === placement.environmentId &&
          incomingProof.generation === placement.generation &&
          incomingProof.generation >= (current.sourceGeneration ?? 1) &&
          (!current.executionProof ||
            incomingProof.generation > current.executionProof.generation ||
            (incomingProof.generation === current.executionProof.generation &&
              incomingProof.environmentId === current.executionProof.environmentId &&
              incomingProof.sequence === current.executionProof.sequence))
        )
          current = { ...current, accepted: true, executionProof: incomingProof };
        const proof = current.executionProof;
        const projection = observation.projection;
        const caughtUp =
          proof !== undefined &&
          proof.commandId === current.command.commandId &&
          placement?.operationId === null &&
          proof.environmentId === placement.environmentId &&
          proof.generation === placement.generation &&
          projection?.environmentId === proof.environmentId &&
          projection.generation === proof.generation &&
          projection.snapshotSequence >= proof.sequence;
        if (queued || (!current.rejection && caughtUp)) {
          await storage.remove(storageKey(scope));
          return null;
        }
        if (encode(current) !== encode(stored))
          await storage.write(storageKey(scope), encode(current));
        return encode(current) === encode(submitted) ? submitted : current;
      }),
    discardRejected: (scope: ThreadMoveSubmissionScope) =>
      storage.withLock(storageKey(scope), async () => {
        const current = await read(scope);
        if (!current?.rejection)
          throw new Error("Check the outcome before discarding an uncertain move.");
        await storage.remove(storageKey(scope));
      }),
    submit: async (
      scope: ThreadMoveSubmissionScope,
      create: () => typeof ThreadMoveEnqueueCommand.Type,
      send: (command: typeof ThreadMoveEnqueueCommand.Type) => Promise<CommandSubmission>,
      receipt: (
        command: typeof ThreadMoveEnqueueCommand.Type,
      ) => Promise<Parameters<typeof threadCommandAcceptance>[0]>,
      isCurrent: () => boolean,
      options?: { readonly allowExisting?: boolean },
    ) => {
      const submission = await storage.withLock<ThreadMoveSubmission>(
        storageKey(scope),
        async () => {
          const previous = await read(scope);
          if (previous) {
            if (options?.allowExisting === false)
              throw new Error(
                "Another move is already saved. Check it before choosing a destination.",
              );
            return previous;
          }
          const next = {
            command: create(),
            originEnvironmentId: scope.environmentId,
            ...(scope.sourceGeneration !== undefined
              ? { sourceGeneration: scope.sourceGeneration }
              : {}),
          };
          if (next.command.threadId !== scope.threadId)
            throw new Error("Move targets another thread.");
          await storage.write(storageKey(scope), encode(next));
          return next;
        },
      );
      if (!isCurrent()) throw new Error("Sign in again before sending this saved move.");
      if (submission.rejection)
        return { status: "rejected" as const, detail: submission.rejection };
      if (submission.accepted) return { status: "accepted" as const };
      let result: Parameters<typeof threadCommandAcceptance>[0];
      try {
        const accepted = await send(submission.command);
        result =
          "relay" in accepted ? accepted : { status: "accepted", sequence: accepted.sequence };
      } catch {
        if (!isCurrent()) throw new Error("Your account changed. The move remains saved.");
        result = await receipt(submission.command);
      }
      return reconcile(scope, submission, result);
    },
  };
}

/** Fresh private guests have one default Codex instance; ordinary environments may share named ones. */
export function threadMoveProviderSupported(
  provider: { readonly instanceId: string; readonly driver: string } | undefined,
  destination: ThreadMoveDestination["kind"],
) {
  return (
    provider?.driver === "codex" &&
    (destination === "environment" || provider.instanceId === "codex")
  );
}

/** Uploaded/reset VM checkouts need no Git remote; the relay retains their repository binding. */
export function threadMoveRepositoryCanonicalKey(
  source: EnvironmentProject,
  thread: Pick<OrchestrationThreadShell, "id" | "relayRouting">,
  environment: Pick<ExecutionEnvironmentDescriptor, "environmentId" | "threadVm"> | undefined,
  status: Pick<RelayThreadVmStatus, "threadId" | "generation" | "repository"> | null | undefined,
) {
  if (!environment?.threadVm) return source.repositoryIdentity?.canonicalKey;
  return environment.environmentId === source.environmentId &&
    environment.threadVm.threadId === thread.id &&
    source.id === `vm:${thread.id}` &&
    status?.threadId === thread.id &&
    status.generation === thread.relayRouting?.generation
    ? status.repository?.canonicalKey
    : undefined;
}

/** A VM must resolve its original location before a new destination can be chosen. */
export function threadMoveOriginalLocationBlocker(
  isVm: boolean,
  placement: Pick<RelayPortableThreadPlacement, "originalLocation"> | null,
  error?: string | null,
) {
  return !isVm
    ? null
    : !placement
      ? error
        ? "Could not check the original project. Reopen Run on to retry."
        : "Checking thread location…"
      : placement.originalLocation === undefined
        ? "Original project could not be determined."
        : null;
}

/** Prefer the exact original project; other machines still offer the same registered repository. */
export function threadMoveProjectTargets(
  source: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
  environments: ReadonlyArray<{
    readonly entry: { readonly target: ConnectionTarget };
    readonly serverConfig?: {
      readonly environment: { readonly threadVm?: { readonly threadId: ThreadId } };
    } | null;
  }>,
  canonicalKey: string | undefined,
  originalLocation?: RelayPortableThreadPlacement["originalLocation"],
) {
  const targets = projects
    .filter(
      (project) =>
        !!canonicalKey &&
        project.environmentId !== source.environmentId &&
        // VM checkout IDs are enforced by the importer. Keep cached VM projects
        // excluded even after deletion or while an older runner is disconnected.
        !project.id.startsWith("vm:") &&
        project.repositoryIdentity?.canonicalKey === canonicalKey &&
        environments.some(
          ({ entry: { target }, serverConfig }) =>
            target.environmentId === project.environmentId &&
            serverConfig?.environment.threadVm === undefined,
        ),
    )
    .map((project) => ({
      key: projectKey({ environmentId: project.environmentId, projectId: project.id }),
      project,
      original: false,
      destination: {
        kind: "environment" as const,
        environmentId: project.environmentId,
        projectId: project.id,
      },
    }));
  if (!originalLocation || originalLocation.environmentId === source.environmentId) return targets;
  const environmentId = EnvironmentId.make(originalLocation.environmentId);
  const projectId = ProjectId.make(originalLocation.projectId);
  return [
    {
      key: projectKey({ environmentId, projectId }),
      project:
        projects.find(
          (project) => project.environmentId === environmentId && project.id === projectId,
        ) ?? null,
      original: true,
      destination: { kind: "environment" as const, environmentId, projectId },
    },
    ...targets.filter((target) => target.destination.environmentId !== environmentId),
  ];
}

/** A cached or missing project list cannot establish that the original project is gone. */
export function threadMoveProjectTargetAvailability(
  target: Pick<ReturnType<typeof threadMoveProjectTargets>[number], "original" | "project">,
  input: Parameters<typeof threadRunOnTargetAvailability>[0] & {
    readonly registered: boolean;
    readonly enabled: boolean;
    readonly projectsReady: boolean;
  },
) {
  if (target.original) {
    if (!input.registered)
      return { action: null, detail: "Original machine is unavailable" } as const;
    if (!input.enabled)
      return { action: null, detail: "Enable this machine in Connections" } as const;
  }
  const availability = threadRunOnTargetAvailability(input);
  if (!target.original || availability.action !== "select") return availability;
  if (!input.projectsReady) return { action: null, detail: "Loading projects…" } as const;
  if (!target.project) return { action: null, detail: "Original project is unavailable" } as const;
  return availability;
}

/** Ownership is released durably; a terminal-looking status alone is not cleanup proof. */
export function threadWorkflowMoveBlocker(
  thread: Pick<OrchestrationThreadShell, "workflowJob"> | null | undefined,
) {
  return thread?.workflowJob
    ? "This thread belongs to a workflow. Finish or cancel the workflow before moving it."
    : null;
}
