import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CurrentTransformer } from "effect/unstable/sql/Statement";
import { RelayDb } from "../db.ts";
import { Machines, layer as machinesLayer } from "../machines/Machines.ts";
import { Repositories, layer as repositoriesLayer } from "../tenancy/Repositories.ts";
import { Organizations, layer as organizationsLayer } from "../tenancy/Organizations.ts";
import {
  OrganizationProjectCatalog,
  layer as catalogLayer,
} from "../projects/OrganizationProjectCatalog.ts";
import * as Workflows from "../jobs/Workflows.ts";
import * as Routing from "./Routing.ts";
import { databaseUrl, withDatabase } from "../workflowSources/test-fixture.ts";
import { configured, seed, save, definition } from "./test-fixture.ts";
if (!databaseUrl) throw new Error("Target tests require WORKFLOW_SOURCES_TEST_DATABASE_URL.");
const decodeProof = Schema.decodeUnknownEffect(Routing.EnableProof);
const services = Layer.mergeAll(machinesLayer, repositoriesLayer, organizationsLayer, catalogLayer);
const testDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withDatabase(configured(effect.pipe(Effect.provide(services))));

// Hold the real operation's transaction after its writes; contenders run on other connections.
const hold = Effect.fn(function* <A, E, R>(operation: Effect.Effect<A, E, R>) {
  const sql = (yield* RelayDb).$client;
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const fiber = yield* sql
    .withTransaction(
      operation.pipe(
        Effect.tap(() => Deferred.succeed(entered, undefined)),
        Effect.tap(() => Deferred.await(release)),
      ),
    )
    .pipe(Effect.forkChild);
  yield* Deferred.await(entered);
  return { fiber, release };
});
const project = {
  projectId: definition.projectId,
  title: "Repository",
  repositoryCanonicalKey: "github.com/example/repository",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("enabled workflow target fences (PostgreSQL)", () => {
  for (const mutation of ["machine", "catalog", "alias", "repository"] as const)
    it.live(`Save holds the ${mutation} fence through commit`, () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const repositories = yield* Repositories;
          yield* repositories.addAlias({
            repositoryId: "repo",
            organizationId: "org",
            canonicalKey: "github.com/example/alternate",
          });
          const machines = yield* Machines;
          const catalog = yield* OrganizationProjectCatalog;
          const sql = (yield* RelayDb).$client;
          const writer = yield* hold(save());
          try {
            // NOWAIT is an immediate database receipt proving the production transaction owns this fence.
            const probe =
              mutation === "machine"
                ? sql`SELECT machine_id FROM relay_machines WHERE machine_id='machine' FOR UPDATE NOWAIT`
                : mutation === "catalog"
                  ? sql`SELECT environment_id FROM relay_organization_project_catalogs WHERE environment_id='environment' FOR UPDATE NOWAIT`
                  : mutation === "alias"
                    ? sql`SELECT canonical_key FROM relay_repository_aliases WHERE canonical_key='github.com/example/repository' FOR UPDATE NOWAIT`
                    : sql`SELECT repository_id FROM relay_repositories WHERE repository_id='repo' FOR UPDATE NOWAIT`;
            expect(yield* probe.pipe(Effect.flip)).toMatchObject({
              _tag: "SqlError",
              reason: { cause: { code: "55P03" } },
            });
            const operation =
              mutation === "machine"
                ? machines.deprovision({ machineId: "machine" })
                : mutation === "catalog"
                  ? catalog.replace({
                      organizationId: "org",
                      machineId: "machine",
                      environmentId: "environment",
                      revision: 2,
                      projects: [],
                    })
                  : mutation === "alias"
                    ? repositories.removeAlias({
                        repositoryId: "repo",
                        canonicalKey: "github.com/example/repository",
                      })
                    : sql.withTransaction(repositories.deleteRepository({ repositoryId: "repo" }));
            const contender = yield* operation.pipe(Effect.forkChild);
            yield* Deferred.succeed(writer.release, undefined);
            expect((yield* Fiber.join(writer.fiber)).revision).toBe(1);
            yield* Fiber.join(contender);
          } finally {
            yield* Deferred.succeed(writer.release, undefined);
          }
        }),
      ),
    );

  it.live(
    "rechecks an enabled update and preserves revision, cutoff and capability after rejection",
    () =>
      testDb(
        Effect.gen(function* () {
          yield* seed;
          const saved = yield* save();
          const before = (yield* Routing.read(saved.workflowId))!;
          const context = {
            userId: "maintainer",
            proof: yield* decodeProof(before.target_capability),
          };
          yield* (yield* Machines).deprovision({ machineId: "machine" });
          const store = yield* Workflows.make;
          // Omitted automation must still recheck an enabled target.
          expect(
            yield* store
              .save(
                "org",
                "repo",
                {
                  workflowId: saved.workflowId,
                  expectedRevision: 1,
                  definition: { ...definition, name: "Rename" },
                  archived: false,
                },
                context,
              )
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "WorkflowInvalidError" });
          expect(yield* Routing.read(saved.workflowId)).toEqual(before);
          const disabled = yield* store.save(
            "org",
            "repo",
            { workflowId: saved.workflowId, expectedRevision: 1, definition, archived: true },
            { userId: "maintainer" },
          );
          expect(disabled.automation?.enabled).toBe(false);
        }),
      ),
  );

  it.live("an innocuous catalog refresh retains a valid cached binding", () =>
    testDb(
      Effect.gen(function* () {
        yield* seed;
        const saved = yield* save();
        const before = (yield* Routing.read(saved.workflowId))!;
        const proof = yield* decodeProof(before.target_capability);
        yield* (yield* OrganizationProjectCatalog).replace({
          organizationId: "org",
          machineId: "machine",
          environmentId: "environment",
          revision: 2,
          projects: [project],
        });
        const store = yield* Workflows.make;
        expect(
          (yield* store.save(
            "org",
            "repo",
            {
              workflowId: saved.workflowId,
              expectedRevision: 1,
              definition: { ...definition, name: "Offline rename" },
              archived: false,
            },
            { userId: "maintainer", proof },
          )).revision,
        ).toBe(2);
      }),
    ),
  );

  for (const removalFirst of [false, true])
    it.live(
      `repository deletion and member removal complete (${removalFirst ? "member" : "repository"} first)`,
      () =>
        testDb(
          Effect.gen(function* () {
            yield* seed;
            const sql = (yield* RelayDb).$client;
            const repositories = yield* Repositories;
            const organizations = yield* Organizations;
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const attempted = yield* Deferred.make<void>();
            const removeMember = sql.withTransaction(
              Effect.gen(function* () {
                yield* organizations.removeMember({ organizationId: "org", userId: "reader" });
                if (removalFirst) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                yield* repositories.revokeAllAccessForUser({
                  organizationId: "org",
                  userId: "reader",
                });
              }),
            );
            // Gate deletion before its first write, after all production fences. With access-first ordering
            // this conflicts with member removal's policy trigger before either can finish.
            const deletion = sql
              .withTransaction(repositories.deleteRepository({ repositoryId: "repo" }))
              .pipe(
                Effect.provideService(CurrentTransformer, (statement) =>
                  Effect.gen(function* () {
                    const query = statement.compile()[0];
                    if (query.startsWith('delete from "relay_repository_aliases"')) {
                      if (!removalFirst) {
                        yield* Deferred.succeed(entered, undefined);
                        yield* Deferred.await(release);
                      }
                    }
                    if (query.includes("relay_organization_members") && query.includes("FOR SHARE"))
                      yield* Deferred.succeed(attempted, undefined);
                    return statement;
                  }),
                ),
              );
            const first = yield* (removalFirst ? removeMember : deletion).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            if (!removalFirst) {
              expect(
                yield* sql`SELECT user_id FROM relay_organization_members WHERE user_id='reader' FOR UPDATE NOWAIT`.pipe(
                  Effect.flip,
                ),
              ).toMatchObject({ reason: { cause: { code: "55P03" } } });
            }
            const second = yield* (removalFirst ? deletion : removeMember).pipe(Effect.forkChild);
            if (removalFirst) yield* Deferred.await(attempted);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(second);
            expect(
              yield* sql`SELECT * FROM relay_repositories WHERE repository_id='repo'`,
            ).toHaveLength(0);
            expect(
              yield* sql`SELECT * FROM relay_repository_access WHERE repository_id='repo'`,
            ).toHaveLength(0);
            expect(
              yield* sql`SELECT * FROM relay_organization_members WHERE user_id='reader'`,
            ).toHaveLength(0);
            expect(
              yield* sql`SELECT * FROM relay_workflow_repository_grants WHERE repository_id='repo' AND NOT revoked`,
            ).toHaveLength(0);
          }),
        ),
    );
});
