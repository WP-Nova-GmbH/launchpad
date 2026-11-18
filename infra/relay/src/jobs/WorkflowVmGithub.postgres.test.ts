import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
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
import {
  type WorkflowVmPublication,
  observeWorkflowVmPublishing,
  observeWorkflowVmPublishingCancellation,
} from "./WorkflowVmPublishing.ts";
import {
  observeWorkflowVmGitHub,
  recheckWorkflowVmGitHub,
  resolveWorkflowVmGitHub,
} from "./WorkflowVmGithub.ts";

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

  it.live("distinguishes missing App setup, missing installation, and wrong repository owner", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        const resolve = (installUrl: string | null) =>
          resolveWorkflowVmGitHub({ ...scope, baseBranch: null }).pipe(
            Effect.provide(
              Layer.mock(GithubApp)({
                installUrl: Effect.succeed(installUrl),
                resolveRepositoryBranch: () =>
                  Effect.die("Unverified scope must not contact GitHub"),
              }),
            ),
            Effect.flip,
          );
        const unconfigured = yield* resolve(null);
        expect(unconfigured).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "Ask your Launchpad operator to configure the GitHub App.",
        });
        expect(unconfigured).not.toHaveProperty("vmStartFailure");

        const installUrl = "https://github.com/apps/launchpad-test/installations/new";
        expect(yield* resolve(installUrl)).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "Connect the organization's GitHub App before running this VM workflow.",
          vmStartFailure: { kind: "github-access-missing" },
        });
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','wrong-owner','Organization','admin','now','now')`;
        expect(yield* resolve(installUrl)).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "Set one GitHub repository URL owned by the connected GitHub account.",
        });
      }),
    ),
  );

  it.live("distinguishes an unavailable branch from a missing read grant", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','acme','Organization','admin','now','now')`;
        for (const [baseBranch, reply, message, vmStartFailure] of [
          [
            "release/2026.11",
            { operation: "read-branch", status: 404 },
            "Choose an existing GitHub base branch with at least one commit.",
            { kind: "base-branch-unavailable", branch: "release/2026.11" },
          ],
          [
            null,
            { operation: "read-branch", status: 409 },
            "Choose an existing GitHub base branch with at least one commit.",
            { kind: "base-branch-unavailable", branch: null },
          ],
          [
            "release/2026.11",
            { operation: "mint-token", permissionDenied: true },
            "Give the organization's GitHub App read access to this repository, then retry.",
            {
              kind: "github-access-missing",
              permission: "contents-read",
              repository: "acme/project",
            },
          ],
          [
            null,
            { operation: "mint-token", status: 401 },
            expect.stringContaining("Ask your Launchpad operator"),
            undefined,
          ],
          [
            null,
            { operation: "sign-app-token" },
            expect.stringContaining("Ask your Launchpad operator"),
            undefined,
          ],
        ] as const) {
          const result = yield* resolveWorkflowVmGitHub({ ...scope, baseBranch }).pipe(
            Effect.provide(
              Layer.mock(GithubApp)({
                resolveRepositoryBranch: () =>
                  Effect.fail(
                    new GithubRequestFailed({ ...reply, cause: "GitHub request failed" }),
                  ),
              }),
            ),
            Effect.flip,
          );
          expect(result).toMatchObject({ _tag: "WorkflowInvalidError", message });
          expect(result._tag === "WorkflowInvalidError" && result.vmStartFailure).toEqual(
            vmStartFailure,
          );
        }
      }),
    ),
  );

  it.live("distinguishes publishing access, throttling, and App authentication", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','acme','Organization','admin','now','now')`;
        const resolve = resolveWorkflowVmGitHub({
          ...scope,
          baseBranch: null,
          publishingSteps: [
            { id: "push", kind: "action", title: "Push", action: "push" },
            { id: "pr", kind: "action", title: "Open PR", action: "open_pull_request" },
          ],
        });
        for (const [reason, message, vmStartFailure] of [
          [
            { status: 403, permissionDenied: true },
            "Give the organization's GitHub App Contents and Pull requests write access for this workflow, then retry.",
            {
              kind: "github-access-missing",
              permission: "contents-and-pull-requests-write",
              repository: "acme/project",
            },
          ],
          [
            { status: 403, rateLimited: true },
            "Could not verify this repository with GitHub. Try again.",
            { kind: "github-verification-temporary" },
          ],
          [{ status: 401 }, expect.stringContaining("Ask your Launchpad operator"), undefined],
        ] as const) {
          const result = yield* resolve.pipe(
            Effect.provide(
              Layer.mock(GithubApp)({
                resolveRepositoryBranch: () => Effect.succeed({ branch, commitSha }),
                mintRepositoryToken: (request) => {
                  expect(request).toEqual({
                    canonicalKey,
                    installationId: "42",
                    access: "workflow-publish",
                  });
                  return Effect.fail(
                    new GithubRequestFailed({
                      operation: "mint-token",
                      cause: "GitHub request failed",
                      ...reason,
                    }),
                  );
                },
              }),
            ),
            Effect.flip,
          );
          expect(result).toMatchObject({ _tag: "WorkflowInvalidError", message });
          expect(result._tag === "WorkflowInvalidError" && result.vmStartFailure).toEqual(
            vmStartFailure,
          );
        }
      }),
    ),
  );

  it.live("rechecks the pinned installation after a relay-only observation", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
          ('org','42','acme','Organization','admin','now','now')`;
        const input = {
          ...scope,
          installationId: "42",
          canonicalKey,
          target: { kind: "branch", branch: "launchpad/job" },
        } as const;
        const observed = yield* observeWorkflowVmGitHub(input).pipe(
          Effect.provide(
            Layer.mock(GithubApp)({
              observeWorkflowPublication: (request) => {
                expect(request).toEqual({
                  installationId: input.installationId,
                  canonicalKey,
                  target: input.target,
                });
                return sql`UPDATE relay_github_installations SET installation_id='43'
                  WHERE organization_id='org'`.pipe(
                  Effect.orDie,
                  Effect.as({ kind: "branch" as const, sha: commitSha }),
                );
              },
            }),
          ),
          Effect.flip,
        );
        expect(observed).toMatchObject({
          _tag: "WorkflowInvalidError",
          message: "This repository's GitHub connection changed. Try again.",
        });
      }),
    ),
  );
});

describe("workflow VM publishing cancellation", () => {
  it.live("confirms an existing closed PR with a moved head only for cancellation", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        yield* sql`INSERT INTO relay_github_installations VALUES
        ('org','42','acme','Organization','admin','now','now')`;
        const publication: WorkflowVmPublication = {
          binding: {
            ...scope,
            jobId: "job",
            threadId: ThreadId.make("workflow:job"),
            environmentId: EnvironmentId.make("vm"),
            projectId: ProjectId.make("project"),
            allocationId: "allocation",
            operationId: "operation",
            generation: 1,
          },
          canonicalKey,
          installationId: "42",
          baseBranch: branch,
          branch: "launchpad/job",
          actionId: "pr",
          stepId: "pr",
          stepGeneration: 0,
          operation: "open_pull_request",
          resultTurnId: "turn",
          checkpointRef: "refs/t3/result",
          tree: "a".repeat(40),
          parent: "b".repeat(40),
          commitSha,
          oldRemoteSha: commitSha,
          outcome: null,
          pullRequestUrl: null,
          recoverySource: null,
        };
        const url = `https://${canonicalKey}/pull/17`;
        let calls = 0;
        const verify = Layer.mock(GithubApp)({
          observeWorkflowPublication: (input) =>
            Effect.sync(() => {
              calls++;
              expect(input.target).toEqual({ kind: "pull_request", branch: publication.branch });
              return {
                kind: "pull_request" as const,
                pullRequests: [
                  {
                    number: 17,
                    url,
                    headBranch: publication.branch,
                    headRepository: "acme/project",
                    headSha: "c".repeat(40),
                    baseBranch: branch,
                    baseRepository: "acme/project",
                    state: "closed" as const,
                    body: "<!-- launchpad-workflow-job:job -->",
                  },
                ],
              };
            }),
        });
        expect(
          yield* observeWorkflowVmPublishing(publication).pipe(Effect.provide(verify)),
        ).toBeNull();
        expect(
          yield* observeWorkflowVmPublishingCancellation(publication).pipe(Effect.provide(verify)),
        ).toEqual({ commitSha, pullRequestUrl: url });
        // A recorded identity should survive without read access to the current remote.
        expect(
          yield* observeWorkflowVmPublishingCancellation({
            ...publication,
            pullRequestUrl: url,
          }).pipe(Effect.provide(verify)),
        ).toEqual({ commitSha, pullRequestUrl: url });
        expect(calls).toBe(2);
      }),
    ),
  );
});
