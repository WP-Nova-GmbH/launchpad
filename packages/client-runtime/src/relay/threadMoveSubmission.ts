import {
  ThreadMoveEnqueueCommand,
  type EnvironmentId,
  type ThreadId,
  type ThreadMoveDestination,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { RelayThreadVmStatus } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import { threadCommandAcceptance, type CommandSubmission } from "../operations/commands.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { projectKey } from "../state/entities.ts";
import type { ConnectionTarget } from "../connection/model.ts";

const Submission = Schema.Struct({
  command: ThreadMoveEnqueueCommand,
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
}
export interface ThreadMoveSubmissionStorage {
  readonly read: (key: string) => Promise<string | null>;
  readonly write: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  /** Platform lock spans the read and write, including other browser tabs. */
  readonly withLock: <A>(key: string, action: () => Promise<A>) => Promise<A>;
}
const storageKey = (scope: ThreadMoveSubmissionScope) =>
  `launchpad.thread-move.v1:${JSON.stringify([scope.accountId, scope.relayUrl, scope.environmentId, scope.threadId])}`;

/** Persist before sending. Unknown replies retain the exact IDs, destination and timing across restart. */
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
      // Another tab may already have removed this exact, accepted intent.
      if (current === null && outcome.status === "accepted") return outcome;
      if (current?.command.commandId !== submission.command.commandId)
        throw new Error("Saved move changed while checking acceptance.");
      if (outcome.status === "accepted") await storage.remove(storageKey(scope));
      else if (outcome.status === "rejected")
        await storage.write(
          storageKey(scope),
          encode({
            ...current,
            rejection: outcome.detail ?? "The server rejected this move.",
          }),
        );
      return outcome;
    });
  return {
    read,
    reconcile,
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
    ) => {
      const submission = await storage.withLock<ThreadMoveSubmission>(
        storageKey(scope),
        async () => {
          const previous = await read(scope);
          if (previous) return previous;
          const next = { command: create() };
          if (next.command.threadId !== scope.threadId)
            throw new Error("Move targets another thread.");
          await storage.write(storageKey(scope), encode(next));
          return next;
        },
      );
      if (!isCurrent()) throw new Error("Sign in again before sending this saved move.");
      if (submission.rejection)
        return { status: "rejected" as const, detail: submission.rejection };
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

/** Offer the same registered repository on another known environment; admission still rechecks access. */
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
) {
  if (!canonicalKey) return [];
  return projects
    .filter(
      (project) =>
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
      destination: {
        kind: "environment" as const,
        environmentId: project.environmentId,
        projectId: project.id,
      },
    }));
}
