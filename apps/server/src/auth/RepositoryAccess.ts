import { authSessionAuthor } from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { markSharedThreadDatabase } from "../persistence/Migrations.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  OrganizationRepositoryPolicy,
  type AuthSessionUser,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  readInstalledMachineIdentity,
  readMachineEnrollmentConfiguration,
} from "../cloud/config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSecretStore } from "./ServerSecretStore.ts";

export interface RepositoryActor {
  readonly user?: AuthSessionUser;
}
const denied = () =>
  new EnvironmentAuthorizationError({
    message: "Repository access is unavailable or has been removed.",
    requiredScope: AuthOrchestrationReadScope,
  });
const StoredPolicy = Schema.Struct({
  policy: Schema.NullOr(OrganizationRepositoryPolicy),
  // A changed remote never silently rebinds a project to another repository.
  bindings: Schema.Record(Schema.String, Schema.String),
});
const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredPolicy));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredPolicy));

export interface RepositoryAccessShape {
  readonly status: Effect.Effect<{
    readonly enabled: boolean;
    readonly ready: boolean;
    readonly revision: number;
  }>;
  readonly requireMember: (
    actor: RepositoryActor,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  readonly projectIds: (
    actor: RepositoryActor,
  ) => Effect.Effect<ReadonlySet<ProjectId> | undefined, EnvironmentAuthorizationError>;
  readonly requireProject: (
    actor: RepositoryActor,
    projectId: ProjectId,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  /** Receipt scope survives project deletion; never derive a binding from replay input. */
  readonly requirePersistedProject: (
    actor: RepositoryActor,
    projectId: ProjectId,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  readonly requireThread: (
    actor: RepositoryActor,
    threadId: ThreadId,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  /** Bind a registered remote before its new checkout exists. Caller holds withFence. */
  readonly authorizeClone: (
    actor: RepositoryActor,
    input: { readonly projectId: ProjectId; readonly cloneUrl: string },
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  readonly requireCommand: (
    actor: RepositoryActor,
    command: OrchestrationCommand,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  readonly apply: (
    policy: OrganizationRepositoryPolicy,
    activate?: boolean,
  ) => Effect.Effect<number, EnvironmentAuthorizationError>;
  readonly withFence: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Closed and drained before a policy update is acknowledged. */
  readonly registerConnection: (close: Effect.Effect<void>) => Effect.Effect<() => void>;
}

// Reference keeps standalone personal-server fixtures usable; production always provides layer.
export class RepositoryAccess extends Context.Reference<RepositoryAccessShape>(
  "t3/auth/RepositoryAccess",
  {
    defaultValue: (): RepositoryAccessShape => ({
      status: Effect.succeed({ enabled: false, ready: true, revision: 0 }),
      requireMember: () => Effect.void,
      projectIds: () => Effect.undefined,
      requireProject: () => Effect.void,
      requirePersistedProject: () => Effect.void,
      requireThread: () => Effect.void,
      requireCommand: () => Effect.void,
      authorizeClone: () => Effect.void,
      apply: () => Effect.fail(denied()),
      withFence: (effect) => effect,
      registerConnection: () => Effect.succeed(() => {}),
    }),
  },
) {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const query = yield* ProjectionSnapshotQuery;
  const projects = yield* ProjectionProjectRepository;
  const identities = yield* RepositoryIdentityResolver;
  const lock = yield* Semaphore.make(1);
  const cached = yield* secrets.get("repository-access-policy").pipe(Effect.orDie);
  let stored = Option.isSome(cached)
    ? decodeStored(new TextDecoder().decode(cached.value))
    : ({ policy: null, bindings: {} } as typeof StoredPolicy.Type);
  // A process restart cannot serve its cached policy until the relay confirms it.
  let activated = false;
  let ready = false;
  const connections = new Set<Effect.Effect<void>>();
  const enrollment = yield* readMachineEnrollmentConfiguration(secrets).pipe(Effect.orDie);
  let currentOrganizationId =
    enrollment.outcome === "already-enrolled"
      ? enrollment.identity.organizationId
      : enrollment.outcome === "pending-enrollment"
        ? "pending-enrollment"
        : undefined;
  const organizationId = Effect.suspend(() =>
    currentOrganizationId !== "pending-enrollment"
      ? Effect.succeed(currentOrganizationId)
      : readInstalledMachineIdentity(secrets).pipe(
          // A temporarily unreadable enrollment result stays closed and can be retried.
          Effect.orElseSucceed(() => null),
          Effect.map((machine) => {
            currentOrganizationId = machine?.organizationId ?? "pending-enrollment";
            return currentOrganizationId;
          }),
        ),
  );
  const persist = () =>
    secrets
      .set("repository-access-policy", new TextEncoder().encode(encodeStored(stored)))
      .pipe(Effect.mapError(denied));
  const member = Effect.fn("RepositoryAccess.member")(function* (actor: RepositoryActor) {
    const org = yield* organizationId;
    if (org === undefined) return undefined;
    if (!ready || stored.policy?.organizationId !== org || actor.user === undefined)
      return yield* denied();
    const found = stored.policy.members.find((entry) => entry.userId === actor.user!.userId);
    if (found === undefined) return yield* denied();
    return found;
  });
  const allowedProject = (
    actor: RepositoryActor,
    role: "admin" | "member",
    projectId: ProjectId,
  ) => {
    if (role === "admin") return true;
    const id = stored.bindings[projectId];
    return (
      id !== undefined &&
      stored.policy?.repositories.some(
        (repo) => repo.repositoryId === id && repo.userIds.includes(actor.user!.userId),
      ) === true
    );
  };
  const bindProjects = Effect.fn("RepositoryAccess.bindProjects")(function* () {
    const projects = yield* query.getProjectShells().pipe(Effect.mapError(denied));
    const bindings = { ...stored.bindings };
    let changed = false;
    for (const project of projects) {
      if (bindings[project.id] !== undefined) continue;
      const key = project.repositoryIdentity?.canonicalKey;
      const repository = stored.policy?.repositories.find(
        (entry) => key !== undefined && entry.canonicalKeys.includes(key),
      );
      if (repository) {
        bindings[project.id] = repository.repositoryId;
        changed = true;
      }
    }
    if (changed) {
      stored = { ...stored, bindings };
      yield* persist();
    }
    return projects;
  });
  const projectIds = Effect.fn("RepositoryAccess.projectIds")(function* (actor: RepositoryActor) {
    const membership = yield* member(actor);
    if (membership === undefined) return undefined;
    const projects = yield* bindProjects();
    return new Set(
      projects
        .filter((project) => allowedProject(actor, membership.role, project.id))
        .map((project) => project.id),
    );
  });
  const requireProject = Effect.fn("RepositoryAccess.requireProject")(function* (
    actor: RepositoryActor,
    projectId: ProjectId,
  ) {
    const membership = yield* member(actor);
    if (membership === undefined) return;
    const project = yield* query.getProjectShellById(projectId).pipe(Effect.orDie);
    if (Option.isNone(project)) return yield* denied();
    if (stored.bindings[projectId] === undefined) {
      const key = project.value.repositoryIdentity?.canonicalKey;
      const repository = stored.policy?.repositories.find(
        (repo) => key !== undefined && repo.canonicalKeys.includes(key),
      );
      if (repository) {
        stored = {
          ...stored,
          bindings: { ...stored.bindings, [projectId]: repository.repositoryId },
        };
        yield* persist();
      }
    }
    if (!allowedProject(actor, membership.role, projectId)) return yield* denied();
  });
  const requireThread = Effect.fn("RepositoryAccess.requireThread")(function* (
    actor: RepositoryActor,
    threadId: ThreadId,
  ) {
    const membership = yield* member(actor);
    if (membership === undefined) return;
    const thread = yield* query.getThreadSubscriptionAnchor(threadId).pipe(Effect.orDie);
    if (Option.isNone(thread)) return yield* denied();
    yield* requireProject(actor, thread.value.projectId);
  });
  const authorizeExistingProject = Effect.fn("RepositoryAccess.authorizeExistingProject")(
    function* (actor: RepositoryActor, role: "admin" | "member", projectId: ProjectId) {
      const existing = yield* projects.getById({ projectId }).pipe(Effect.mapError(denied));
      if (Option.isNone(existing)) return false;
      // Include deleted records: the engine still owns receipt replay and duplicate-ID rejection.
      // A replacement request must never assign a binding to an existing unresolved project.
      if (!allowedProject(actor, role, projectId)) return yield* denied();
      return true;
    },
  );
  return RepositoryAccess.of({
    status: organizationId.pipe(
      Effect.map((org) => ({
        enabled: org !== undefined,
        ready: org === undefined || ready,
        revision: stored.policy?.revision ?? 0,
      })),
    ),
    requireMember: (actor) => member(actor).pipe(Effect.asVoid),
    projectIds,
    requireProject,
    requirePersistedProject: Effect.fn("RepositoryAccess.requirePersistedProject")(
      function* (actor, projectId) {
        const membership = yield* member(actor);
        if (membership === undefined) return;
        if (!(yield* authorizeExistingProject(actor, membership.role, projectId)))
          return yield* denied();
      },
    ),
    requireThread,
    authorizeClone: Effect.fn("RepositoryAccess.authorizeClone")(function* (actor, input) {
      const membership = yield* member(actor);
      if (membership === undefined) return;
      if (yield* authorizeExistingProject(actor, membership.role, input.projectId)) return;
      const key = normalizeGitRemoteUrl(input.cloneUrl);
      const repository = stored.policy?.repositories.find((repo) =>
        repo.canonicalKeys.includes(key),
      );
      if (
        !repository ||
        (membership.role !== "admin" && !repository.userIds.includes(actor.user!.userId))
      )
        return yield* denied();
      const previousBinding = stored.bindings[input.projectId];
      if (previousBinding !== undefined && previousBinding !== repository.repositoryId)
        return yield* denied();
      stored = {
        ...stored,
        bindings: { ...stored.bindings, [input.projectId]: repository.repositoryId },
      };
      yield* persist();
    }),
    requireCommand: Effect.fn("RepositoryAccess.requireCommand")(function* (actor, command) {
      const membership = yield* member(actor);
      if (membership === undefined) return;
      // External shared sends must enter the durable queue. Trusted queue/provider
      // work dispatches directly to the engine after its original acceptance.
      if (command.type === "thread.turn.start" || command.type === "thread.message.user.append")
        return yield* new EnvironmentAuthorizationError({
          message: "This shared environment requires a client with shared prompt queue support.",
          requiredScope: AuthOrchestrationReadScope,
        });
      if ("sourceProposedPlan" in command && command.sourceProposedPlan)
        yield* requireThread(actor, command.sourceProposedPlan.threadId);
      if (command.type === "thread.prompt.enqueue" && command.bootstrap?.createThread) {
        yield* requireProject(actor, command.bootstrap.createThread.projectId);
        return;
      }
      if (command.type === "thread.create") {
        yield* requireProject(actor, command.projectId);
        return;
      }
      if (
        command.type === "project.create" &&
        (yield* authorizeExistingProject(actor, membership.role, command.projectId))
      )
        return;
      if (
        command.type === "project.create" ||
        (command.type === "project.meta.update" && command.workspaceRoot !== undefined)
      ) {
        const identity = yield* identities.resolve(command.workspaceRoot!, { refresh: true });
        const repository = stored.policy?.repositories.find(
          (repo) => identity !== null && repo.canonicalKeys.includes(identity.canonicalKey),
        );
        if (
          !repository ||
          (membership.role !== "admin" && !repository.userIds.includes(actor.user!.userId))
        )
          return yield* denied();
        const previousBinding = stored.bindings[command.projectId];
        if (previousBinding !== undefined && previousBinding !== repository.repositoryId)
          return yield* denied();
        if (command.type === "project.create") {
          stored = {
            ...stored,
            bindings: { ...stored.bindings, [command.projectId]: repository.repositoryId },
          };
          yield* persist();
          return;
        }
      }
      if ("threadId" in command) yield* requireThread(actor, command.threadId);
      else if ("projectId" in command) yield* requireProject(actor, command.projectId);
      else if (membership.role !== "admin") return yield* denied();
    }),
    apply: (policy, activate = false) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (policy.organizationId !== (yield* organizationId)) return yield* denied();
          if (stored.policy && policy.revision < stored.policy.revision) return yield* denied();
          if (ready && stored.policy?.revision === policy.revision) return policy.revision;
          // Close every protected connection, including idle streams, before ACK.
          // The caller is a relay request, never an accepted agent execution fiber.
          ready = false;
          yield* Effect.all([...connections], { concurrency: "unbounded" });
          stored = { ...stored, policy };
          yield* persist();
          yield* bindProjects();
          yield* markSharedThreadDatabase.pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(denied),
          );
          activated ||= activate;
          ready = activated;
          return policy.revision;
        }),
      ),
    withFence: lock.withPermits(1),
    registerConnection: (close) =>
      Effect.sync(() => {
        connections.add(close);
        return () => {
          connections.delete(close);
        };
      }),
  });
});
export const layer = Layer.effect(RepositoryAccess, make);

/** Wire schemas omit author, and this also removes authors on anonymous personal sessions. */
export function stampCommandAuthor(
  command: OrchestrationCommand,
  actor: RepositoryActor,
): OrchestrationCommand {
  if (
    command.type === "thread.turn.start" ||
    command.type === "thread.message.user.append" ||
    command.type === "thread.user-input.respond" ||
    command.type === "thread.prompt.enqueue" ||
    command.type === "thread.prompt.edit" ||
    command.type === "thread.prompt.remove" ||
    command.type === "thread.prompt.steer" ||
    command.type === "thread.queue.pause" ||
    command.type === "thread.queue.resume"
  ) {
    const { author: _author, ...rest } = command;
    return {
      ...rest,
      ...(actor.user === undefined ? {} : { author: authSessionAuthor(actor.user) }),
    };
  }
  return command;
}
