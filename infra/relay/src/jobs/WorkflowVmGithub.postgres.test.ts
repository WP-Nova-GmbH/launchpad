import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { GithubApp, GithubRequestFailed } from "../tenancy/GithubApp.ts";
import { Repositories, layer as repositoriesLayer } from "../tenancy/Repositories.ts";
import { databaseUrl, withDatabase } from "../workflowSources/test-fixture.ts";
import { recheckWorkflowVmGitHub, resolveWorkflowVmGitHub } from "./WorkflowVmGithub.ts";

if (!databaseUrl)
  throw new Error("Workflow VM GitHub tests require WORKFLOW_SOURCES_TEST_DATABASE_URL.");

const scope = { organizationId: "org", repositoryId: "repo" };
const canonicalKey = "github.com/acme/project";
const branch = "main";
const commitSha = "aa218f56b14c9653891f9e74264a383fa43fefbd";
const prepare = Effect.gen(function* () {
  const sql = (yield* RelayDb).$client;
  const fs = yield* FileSystem.FileSystem;
  const migration = yield* fs.readFileString(
    new URL(
      "../../migrations/postgres/20260819121924_amused_blue_blade/migration.sql",
      import.meta.url,
    ).pathname,
  );
  for (const statement of migration.split("--> statement-breakpoint")) yield* sql.unsafe(statement);
  yield* sql`INSERT INTO relay_repository_aliases(canonical_key,repository_id,organization_id)
    VALUES (${canonicalKey}, 'repo', 'org'), ('gitlab.com/acme/project', 'repo', 'org'),
      ('github.com/personal-fork/project', 'repo', 'org')`;
  return sql;
});

describe("Workflow VM GitHub admission (PostgreSQL)", () => {
  it.live("pins only the organization's repository and rejects a changed installation", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','ACME','Organization','admin','now','now')`;
        const resolved = yield* resolveWorkflowVmGitHub({ ...scope, baseBranch: null });
        expect(resolved).toEqual({ canonicalKey, installationId: "42", branch, commitSha });
        yield* sql.withTransaction(recheckWorkflowVmGitHub(sql, scope, resolved));
        yield* sql`UPDATE relay_github_installations SET installation_id='43' WHERE organization_id='org'`;
        expect(
          yield* Effect.flip(sql.withTransaction(recheckWorkflowVmGitHub(sql, scope, resolved))),
        ).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "This repository's GitHub connection changed. Try again.",
        });
        expect(
          yield* Effect.flip(
            sql.withTransaction(
              recheckWorkflowVmGitHub(sql, { ...scope, organizationId: "other-org" }, resolved),
            ),
          ),
        ).toMatchObject({ _tag: "WorkflowInvalidError" });
      }).pipe(
        Effect.provide(
          Layer.mock(GithubApp)({
            resolveRepositoryBranch: (input) => {
              expect(input).toEqual({ canonicalKey, installationId: "42", baseBranch: null });
              return Effect.succeed({ branch, commitSha });
            },
          }),
        ),
      ),
    ),
  );

  it.live("rejects a second eligible alias added during GitHub preflight", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','acme','Organization','admin','now','now')`;
        const repositories = yield* Repositories;
        const alias = { ...scope, canonicalKey: "github.com/acme/mirror" };
        const resolve = resolveWorkflowVmGitHub({ ...scope, baseBranch: null });
        const resolved = yield* resolve.pipe(
          Effect.provide(
            Layer.mock(GithubApp)({
              resolveRepositoryBranch: () =>
                repositories.addAlias(alias).pipe(Effect.orDie, Effect.as({ branch, commitSha })),
            }),
          ),
        );
        expect(resolved.canonicalKey).toBe(canonicalKey);
        expect(
          yield* Effect.flip(sql.withTransaction(recheckWorkflowVmGitHub(sql, scope, resolved))),
        ).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "This repository's GitHub connection changed. Try again.",
        });
        expect(
          yield* resolve.pipe(
            Effect.provide(
              Layer.mock(GithubApp)({
                resolveRepositoryBranch: () =>
                  Effect.die("Ambiguous scope must not contact GitHub"),
              }),
            ),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "WorkflowInvalidError" });
      }).pipe(Effect.provide(repositoriesLayer)),
    ),
  );

  it.live("holds the repository and installation locks through admission commit", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','acme','Organization','admin','now','now')`;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const admission = yield* sql
          .withTransaction(
            recheckWorkflowVmGitHub(sql, scope, { canonicalKey, installationId: "42" }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        try {
          for (const writer of [
            sql`SELECT repository_id FROM relay_repositories
              WHERE repository_id='repo' FOR NO KEY UPDATE NOWAIT`,
            sql`SELECT installation_id FROM relay_github_installations
              WHERE organization_id='org' FOR UPDATE NOWAIT`,
          ]) {
            expect(yield* Effect.flip(writer)).toMatchObject({
              _tag: "SqlError",
              reason: { cause: { code: "55P03" } },
            });
          }
        } finally {
          yield* Deferred.succeed(release, undefined);
        }
        yield* Fiber.join(admission);
      }),
    ),
  );

  it.live("serializes alias removal so two callers cannot remove the last alias", () =>
    withDatabase(
      Effect.gen(function* () {
        const repositories = yield* Repositories;
        const aliases = ["github.com/acme/first", "github.com/acme/second"];
        for (const canonicalKey of aliases)
          yield* repositories.addAlias({ ...scope, repositoryId: "repo-2", canonicalKey });
        const removed = yield* Effect.forEach(
          aliases,
          (canonicalKey) => repositories.removeAlias({ repositoryId: "repo-2", canonicalKey }),
          { concurrency: 2 },
        );
        expect(removed.toSorted()).toEqual(["last-alias", "removed"]);
        expect(
          (yield* repositories.getById({ repositoryId: "repo-2" }))?.canonicalKeys,
        ).toHaveLength(1);
      }).pipe(Effect.provide(repositoriesLayer)),
    ),
  );

  it.live("rejects missing installation and wrong repository owner before calling GitHub", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        const resolve = resolveWorkflowVmGitHub({ ...scope, baseBranch: null });
        expect(yield* Effect.flip(resolve)).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "Connect the organization's GitHub App before running this VM workflow.",
        });
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','wrong-owner','Organization','admin','now','now')`;
        expect(yield* Effect.flip(resolve)).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "Set one GitHub repository URL owned by the connected GitHub account.",
        });
      }).pipe(
        Effect.provide(
          Layer.mock(GithubApp)({
            resolveRepositoryBranch: () => Effect.die("Unverified scope must not contact GitHub"),
          }),
        ),
      ),
    ),
  );

  it.live("reports an actionable error for a missing GitHub branch", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','acme','Organization','admin','now','now')`;
        expect(
          yield* Effect.flip(resolveWorkflowVmGitHub({ ...scope, baseBranch: "missing" })),
        ).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "Choose an existing GitHub base branch with at least one commit.",
        });
      }).pipe(
        Effect.provide(
          Layer.mock(GithubApp)({
            resolveRepositoryBranch: () =>
              Effect.fail(
                new GithubRequestFailed({
                  operation: "read-branch",
                  status: 404,
                  cause: "GitHub responded 404",
                }),
              ),
          }),
        ),
      ),
    ),
  );
});
