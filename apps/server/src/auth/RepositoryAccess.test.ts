import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrganizationRepositoryPolicy,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as ConfigProvider from "effect/ConfigProvider";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MACHINE_IDENTITY,
  encodeCloudMachineIdentityJson,
} from "../cloud/config.ts";
import { SecretStorePersistError, ServerSecretStore } from "./ServerSecretStore.ts";
import { make } from "./RepositoryAccess.ts";

const user = { user: { userId: "vali", displayName: "Vali", imageUrl: null } };
const admin = { user: { userId: "admin", displayName: null, imageUrl: null } };
const projectA = ProjectId.make("a"),
  projectB = ProjectId.make("b"),
  threadA = ThreadId.make("ta"),
  threadB = ThreadId.make("tb");
const policy: OrganizationRepositoryPolicy = {
  organizationId: "org",
  revision: 1,
  members: [
    { userId: "vali", role: "member" },
    { userId: "admin", role: "admin" },
  ],
  repositories: [
    { repositoryId: "repo-a", canonicalKeys: ["github.com/a/a"], userIds: ["vali"] },
    { repositoryId: "repo-b", canonicalKeys: ["github.com/b/b"], userIds: [] },
  ],
};
const fixture = Effect.gen(function* () {
  const stored = new Map<string, Uint8Array>([
    [
      CLOUD_MACHINE_IDENTITY,
      new TextEncoder().encode(
        yield* encodeCloudMachineIdentityJson({
          machineId: "machine",
          organizationId: "org",
          role: "agent_executor",
        }),
      ),
    ],
  ]);
  const projects = [
    { id: projectA, repositoryIdentity: { canonicalKey: "github.com/a/a" } },
    { id: projectB, repositoryIdentity: { canonicalKey: "github.com/b/b" } },
  ] as OrchestrationProjectShell[];
  const threads = [
    { id: threadA, projectId: projectA },
    { id: threadB, projectId: projectB },
  ] as OrchestrationThreadShell[];
  const deletedProjects = new Set<ProjectId>();
  const failures = { policyWrite: false, projectQuery: false };
  const resolvedPaths: string[] = [];
  const secrets: ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
    set: (name, value) =>
      Effect.suspend(() => {
        if (name === "repository-access-policy" && failures.policyWrite)
          return Effect.fail(
            new SecretStorePersistError({ resource: name, cause: "disk unavailable" }),
          );
        return Effect.sync(() => {
          stored.set(name, value);
        });
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  };
  const query = {
    getProjectShells: () =>
      Effect.suspend(() =>
        failures.projectQuery
          ? Effect.fail(new PersistenceSqlError({ operation: "test.getProjectShells" }))
          : Effect.succeed(projects.filter((project) => !deletedProjects.has(project.id))),
      ),
    getProjectShellById: (id: ProjectId) =>
      Effect.succeed(
        Option.fromNullishOr(
          projects.find((project) => project.id === id && !deletedProjects.has(id)),
        ),
      ),
    getThreadShellById: (id: ThreadId) =>
      Effect.succeed(
        Option.fromNullishOr(threads.find((thread) => thread.id === id && !thread.archivedAt)),
      ),
    getThreadSubscriptionAnchor: (id: ThreadId) =>
      Effect.succeed(
        Option.fromNullishOr(threads.find((thread) => thread.id === id)).pipe(
          Option.map((thread) => ({
            projectId: thread.projectId,
            creationSequence: 1,
            snapshotSequence: 1,
          })),
        ),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const construct = make.pipe(
    Effect.provideService(ServerSecretStore, secrets),
    Effect.provideService(ProjectionSnapshotQuery, query),
    Effect.provideService(ProjectionProjectRepository, {
      getById: ({ projectId }) =>
        Effect.sync(() =>
          Option.fromNullishOr(projects.find((project) => project.id === projectId)).pipe(
            Option.map(
              () =>
                ({
                  projectId,
                  deletedAt: deletedProjects.has(projectId) ? "2026-09-28T00:00:00.000Z" : null,
                }) as ProjectionProject,
            ),
          ),
        ),
      upsert: () => Effect.die("unused"),
    }),
    Effect.provideService(RepositoryIdentityResolver, {
      resolve: (path) =>
        Effect.sync(() => {
          resolvedPaths.push(path);
          return path === "/allowed"
            ? {
                canonicalKey: "github.com/a/a",
                locator: { remoteUrl: "https://github.com/a/a.git" },
              }
            : null;
        }),
    }),
  );
  return { construct, projects, threads, stored, deletedProjects, failures, resolvedPaths };
});
const testLayer = SqlitePersistenceMemory.pipe(
  Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
);
it.layer(testLayer)("repository authorization", (it) => {
  it.effect("archival retains repository authorization and revocation still denies access", () =>
    Effect.gen(function* () {
      const { construct, threads } = yield* fixture;
      threads[0] = { ...threads[0]!, archivedAt: "2026-09-28T10:00:00Z" };
      const access = yield* construct;
      yield* access.apply(policy, true);
      yield* access.requireThread(user, threadA);
      yield* access.apply({
        ...policy,
        revision: 2,
        repositories: policy.repositories.map((repository) => ({ ...repository, userIds: [] })),
      });
      expect(yield* access.requireThread(user, threadA).pipe(Effect.isFailure)).toBe(true);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "fails closed on startup, filters repository grants, and keeps unknown projects admin-only",
    () =>
      Effect.gen(function* () {
        const { construct, projects } = yield* fixture;
        const access = yield* construct;
        expect(yield* access.requireThread(user, threadA).pipe(Effect.isFailure)).toBe(true);
        yield* access.apply(policy, true);
        expect([...(yield* access.projectIds(user))!]).toEqual([projectA]);
        expect(yield* access.requireThread(user, threadB).pipe(Effect.isFailure)).toBe(true);
        projects.push({
          id: ProjectId.make("unknown"),
          repositoryIdentity: null,
        } as OrchestrationProjectShell);
        expect((yield* access.projectIds(admin))?.size).toBe(3);
        expect((yield* access.projectIds(user))?.size).toBe(1);
        expect(yield* access.requireMember({}).pipe(Effect.isFailure)).toBe(true);
      }),
  );
  it.effect(
    "full newer snapshots remove old grants and cannot be rolled back or rebound by remote changes",
    () =>
      Effect.gen(function* () {
        const { construct, projects } = yield* fixture;
        const access = yield* construct;
        yield* access.apply(policy, true);
        projects[0] = {
          ...projects[0]!,
          repositoryIdentity: {
            canonicalKey: "github.com/b/b",
          } as OrchestrationProjectShell["repositoryIdentity"],
        };
        yield* access.apply({
          ...policy,
          revision: 3,
          repositories: [
            { repositoryId: "repo-b", canonicalKeys: ["github.com/b/b"], userIds: ["vali"] },
          ],
        });
        expect(yield* access.requireThread(user, threadA).pipe(Effect.isFailure)).toBe(true);
        yield* access.requireThread(user, threadB);
        expect(yield* access.apply(policy, true).pipe(Effect.isFailure)).toBe(true);
        const restarted = yield* construct;
        expect(yield* restarted.requireThread(user, threadB).pipe(Effect.isFailure)).toBe(true);
        yield* restarted.apply(
          {
            ...policy,
            revision: 3,
            repositories: [
              { repositoryId: "repo-b", canonicalKeys: ["github.com/b/b"], userIds: ["vali"] },
            ],
          },
          true,
        );
        yield* restarted.requireThread(user, threadB);
      }),
  );
  it.effect(
    "acknowledges only after protected consumers drain, while accepted independent work keeps running",
    () =>
      Effect.gen(function* () {
        const { construct } = yield* fixture;
        const access = yield* construct;
        yield* access.apply(policy, true);
        const closing = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        yield* access.registerConnection(
          Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(drained))),
        );
        let acknowledged = false;
        const apply = yield* Effect.forkChild(
          access
            .apply({ ...policy, revision: 2, members: [{ userId: "admin", role: "admin" }] })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  acknowledged = true;
                }),
              ),
            ),
        );
        yield* Deferred.await(closing);
        expect((yield* access.status).ready).toBe(false);
        expect(acknowledged).toBe(false);
        yield* Deferred.succeed(drained, undefined);
        expect(yield* Fiber.join(apply)).toBe(2);
        expect(yield* access.requireMember(user).pipe(Effect.isFailure)).toBe(true);
        // An ACK retry of the same revision does not close newly attached consumers.
        let closes = 0;
        yield* access.registerConnection(
          Effect.sync(() => {
            closes++;
          }),
        );
        yield* access.apply({
          ...policy,
          revision: 2,
          members: [{ userId: "admin", role: "admin" }],
        });
        expect(closes).toBe(0);
      }),
  );
  it.effect(
    "binds permitted registered clones before checkout and never silently rebinds them",
    () =>
      Effect.gen(function* () {
        const { construct, projects } = yield* fixture;
        const access = yield* construct;
        yield* access.apply(policy, true);
        const projectId = ProjectId.make("clone");
        yield* access.authorizeClone(user, { projectId, cloneUrl: "git@github.com:a/a.git" });
        projects.push({ id: projectId, repositoryIdentity: null } as OrchestrationProjectShell);
        yield* access.requireProject(user, projectId);
        expect(
          yield* access
            .authorizeClone(user, {
              projectId: ProjectId.make("denied"),
              cloneUrl: "https://github.com/b/b.git",
            })
            .pipe(Effect.isFailure),
        ).toBe(true);
        // The engine owns duplicate-ID rejection; authorization must not change the old binding.
        yield* access.authorizeClone(admin, { projectId, cloneUrl: "https://github.com/b/b.git" });
        yield* access.requireProject(user, projectId);
        expect(
          yield* access
            .authorizeClone(admin, {
              projectId: ProjectId.make("unregistered"),
              cloneUrl: "https://github.com/unknown/repo.git",
            })
            .pipe(Effect.isFailure),
        ).toBe(true);
      }),
  );
  it.effect(
    "never binds existing unresolved or deleted IDs from replacement create/clone input",
    () =>
      Effect.gen(function* () {
        const { construct, projects, threads, stored, deletedProjects, resolvedPaths } =
          yield* fixture;
        const unknown = ProjectId.make("unknown");
        const unknownThread = ThreadId.make("unknown-thread");
        projects.push({ id: unknown, repositoryIdentity: null } as OrchestrationProjectShell);
        threads.push({ id: unknownThread, projectId: unknown } as OrchestrationThreadShell);
        const access = yield* construct;
        yield* access.apply(policy, true);
        const before = stored.get("repository-access-policy");
        for (const deleted of [false, true]) {
          if (deleted) deletedProjects.add(unknown);
          const command = {
            type: "project.create" as const,
            commandId: CommandId.make(`replace-${deleted}`),
            projectId: unknown,
            title: "replacement",
            workspaceRoot: "/allowed",
            createdAt: "2026-09-28T00:00:00.000Z",
          };
          expect(
            yield* access.withFence(access.requireCommand(user, command)).pipe(Effect.isFailure),
          ).toBe(true);
          expect(
            yield* access
              .withFence(
                access.authorizeClone(user, {
                  projectId: unknown,
                  cloneUrl: "https://github.com/a/a.git",
                }),
              )
              .pipe(Effect.isFailure),
          ).toBe(true);
          yield* access.requireCommand(admin, command);
          yield* access.requirePersistedProject(admin, unknown);
          expect(yield* access.requirePersistedProject(user, unknown).pipe(Effect.isFailure)).toBe(
            true,
          );
          yield* access.authorizeClone(admin, {
            projectId: unknown,
            cloneUrl: "https://github.com/a/a.git",
          });
          expect(stored.get("repository-access-policy")).toEqual(before);
          expect(yield* access.requireThread(user, unknownThread).pipe(Effect.isFailure)).toBe(
            true,
          );
        }
        expect(resolvedPaths).toEqual([]);
      }),
  );
  it.effect(
    "keeps bound active/deleted IDs authorized for engine replay without resolving replacement roots",
    () =>
      Effect.gen(function* () {
        const { construct, stored, deletedProjects, resolvedPaths } = yield* fixture;
        const access = yield* construct;
        yield* access.apply(policy, true);
        const before = stored.get("repository-access-policy");
        for (const deleted of [false, true]) {
          if (deleted) deletedProjects.add(projectA);
          yield* access.requirePersistedProject(user, projectA);
          expect(yield* access.requirePersistedProject(user, projectB).pipe(Effect.isFailure)).toBe(
            true,
          );
          for (const commandId of ["accepted-command", "new-duplicate-command"]) {
            yield* access.requireCommand(user, {
              type: "project.create",
              commandId: CommandId.make(commandId),
              projectId: projectA,
              title: "old",
              workspaceRoot: "/now-missing",
              createdAt: "2026-09-28T00:00:00.000Z",
            });
          }
          yield* access.authorizeClone(user, {
            projectId: projectA,
            cloneUrl: "https://github.com/b/b.git",
          });
        }
        expect(resolvedPaths).toEqual([]);
        expect(stored.get("repository-access-policy")).toEqual(before);
        expect(
          yield* access
            .requirePersistedProject(admin, ProjectId.make("absent"))
            .pipe(Effect.isFailure),
        ).toBe(true);
      }),
  );
  it.effect("still reserves a permitted fresh project before creation", () =>
    Effect.gen(function* () {
      const { construct, projects, resolvedPaths } = yield* fixture;
      const access = yield* construct;
      yield* access.apply(policy, true);
      const projectId = ProjectId.make("fresh");
      yield* access.requireCommand(user, {
        type: "project.create",
        commandId: CommandId.make("fresh"),
        projectId,
        title: "fresh",
        workspaceRoot: "/allowed",
        createdAt: "2026-09-28T00:00:00.000Z",
      });
      projects.push({ id: projectId, repositoryIdentity: null } as OrchestrationProjectShell);
      yield* access.requireProject(user, projectId);
      expect(resolvedPaths).toEqual(["/allowed"]);
    }),
  );
  it.effect(
    "recovers readiness after an interrupted drain without reopening before the retry drains",
    () =>
      Effect.gen(function* () {
        const { construct } = yield* fixture;
        const access = yield* construct;
        yield* access.apply(policy, true);
        const closing = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        yield* access.registerConnection(
          Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(drained))),
        );
        const applying = yield* Effect.forkChild(access.apply({ ...policy, revision: 2 }));
        yield* Deferred.await(closing);
        yield* Fiber.interrupt(applying);
        expect((yield* access.status).ready).toBe(false);
        const retry = yield* Effect.forkChild(access.apply({ ...policy, revision: 2 }));
        expect((yield* access.status).ready).toBe(false);
        yield* Deferred.succeed(drained, undefined);
        expect(yield* Fiber.join(retry)).toBe(2);
        yield* access.requireThread(user, threadA);
      }),
  );
  it.effect(
    "retries typed persistence/query failures and never activates from a pre-start push",
    () =>
      Effect.gen(function* () {
        const { construct, failures } = yield* fixture;
        const access = yield* construct;
        failures.policyWrite = true;
        expect(yield* access.apply(policy, true).pipe(Effect.isFailure)).toBe(true);
        failures.policyWrite = false;
        yield* access.apply(policy);
        expect((yield* access.status).ready).toBe(false);
        yield* access.apply(policy, true);
        let revision = 2;
        for (const failure of ["policyWrite", "projectQuery"] as const) {
          failures[failure] = true;
          expect(yield* access.apply({ ...policy, revision }).pipe(Effect.isFailure)).toBe(true);
          expect((yield* access.status).ready).toBe(false);
          failures[failure] = false;
          if (failure === "projectQuery") revision++;
          yield* access.apply({ ...policy, revision });
          yield* access.requireThread(user, threadA);
          revision++;
        }
        const restarted = yield* construct;
        yield* restarted.apply({ ...policy, revision });
        expect((yield* restarted.status).ready).toBe(false);
        yield* restarted.apply({ ...policy, revision }, true);
        yield* restarted.requireThread(user, threadA);
      }),
  );
  it.effect(
    "keeps ignored enrollment seeds personal and gates only eligible pending enrollment",
    () =>
      Effect.gen(function* () {
        const { construct, stored } = yield* fixture;
        stored.delete(CLOUD_MACHINE_IDENTITY);
        const seed = { T3CODE_MACHINE_ENROLLMENT_SEED: "seed" };
        const complete = { ...seed, T3CODE_MACHINE_ENROLLMENT_RELAY_URL: "https://relay.example" };
        for (const env of [{}, seed]) {
          const access = yield* construct.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
          );
          expect(yield* access.status).toMatchObject({ enabled: false, ready: true });
          yield* access.requireMember({});
        }
        stored.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("personal-user"));
        const personal = yield* construct.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(complete),
          ),
        );
        expect(yield* personal.status).toMatchObject({ enabled: false, ready: true });
        stored.delete(CLOUD_LINKED_USER_ID);
        const pending = yield* construct.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(complete),
          ),
        );
        expect(yield* pending.status).toMatchObject({ enabled: true, ready: false });
        expect(yield* pending.requireMember(user).pipe(Effect.isFailure)).toBe(true);
        stored.set(
          CLOUD_MACHINE_IDENTITY,
          new TextEncoder().encode(
            yield* encodeCloudMachineIdentityJson({
              machineId: "machine",
              organizationId: "org",
              role: "agent_executor",
            }),
          ),
        );
        yield* pending.apply(policy, true);
        yield* pending.requireThread(user, threadA);
      }),
  );
  it.effect("requires queued external sends while allowing authorized enqueue", () =>
    Effect.gen(function* () {
      const { construct } = yield* fixture;
      const access = yield* construct;
      yield* access.apply(policy, true);
      const fields = {
        commandId: CommandId.make("send"),
        threadId: threadA,
        message: { messageId: MessageId.make("message"), text: "hello", attachments: [] },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: "1970-01-01T00:00:00.000Z",
      };
      expect(
        yield* access
          .requireCommand(user, {
            ...fields,
            type: "thread.turn.start",
            message: { ...fields.message, role: "user" },
          })
          .pipe(Effect.isFailure),
      ).toBe(true);
      expect(
        yield* access
          .requireCommand(user, {
            ...fields,
            type: "thread.message.user.append",
          })
          .pipe(Effect.isFailure),
      ).toBe(true);
      yield* access.requireCommand(user, { ...fields, type: "thread.prompt.enqueue" });
    }),
  );
  it.effect("refuses unregistered new projects", () =>
    Effect.gen(function* () {
      const { construct } = yield* fixture;
      const access = yield* construct;
      yield* access.apply(policy, true);
      expect(
        yield* access
          .requireCommand(admin, {
            type: "project.create",
            commandId: CommandId.make("new"),
            projectId: ProjectId.make("new"),
            title: "new",
            workspaceRoot: "/not-registered",
            createdAt: "1970-01-01T00:00:00.000Z",
          })
          .pipe(Effect.isFailure),
      ).toBe(true);
    }),
  );
});
