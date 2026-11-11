import type { PgClient } from "@effect/sql-pg/PgClient";
import { WorkflowInvalidError } from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { GithubApp, type GithubRequestFailed } from "../tenancy/GithubApp.ts";

type RepositoryScope = { readonly organizationId: string; readonly repositoryId: string };

export interface WorkflowVmGitHubResolution {
  readonly canonicalKey: string;
  readonly installationId: string;
  readonly branch: string;
  readonly commitSha: string;
}

const invalid = (message: string) => new WorkflowInvalidError({ message });
const tryAgain = () => invalid("Could not verify this repository with GitHub. Try again.");
const bindingChanged = () => invalid("This repository's GitHub connection changed. Try again.");
const githubRepositoryKey = "^github[.]com/[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+$";

function gitHubReadFailure(error: GithubRequestFailed) {
  const { status } = error;
  if (error.operation === "read-branch" && (status === 404 || status === 409 || status === 422))
    return invalid("Choose an existing GitHub base branch with at least one commit.");
  if (status === 301 || status === 302 || status === 307 || status === 308)
    return invalid(
      "Check that this repository has its current GitHub URL in Organization settings.",
    );
  if (status === 401 || status === 403 || status === 404 || status === 422)
    return invalid(
      "Give the organization's GitHub App read access to this repository, then retry.",
    );
  return tryAgain();
}

export const selectWorkflowVmGitHubBinding = Effect.fnUntraced(function* (
  sql: PgClient,
  input: RepositoryScope,
  lockInstallation: boolean,
) {
  const [installation] = yield* sql<{ installationId: string; accountLogin: string }>`
    SELECT g.installation_id AS "installationId", g.account_login AS "accountLogin"
    FROM relay_repositories r
    JOIN relay_github_installations g ON g.organization_id = r.organization_id
    WHERE r.organization_id = ${input.organizationId} AND r.repository_id = ${input.repositoryId}
    ${lockInstallation ? sql`FOR SHARE OF g` : sql``}`;
  if (!installation)
    return yield* invalid("Connect the organization's GitHub App before running this VM workflow.");
  const aliases = yield* sql<{ canonicalKey: string }>`
    SELECT canonical_key AS "canonicalKey" FROM relay_repository_aliases
    WHERE organization_id = ${input.organizationId} AND repository_id = ${input.repositoryId}
      AND canonical_key ~ ${githubRepositoryKey}
      AND lower(split_part(canonical_key, '/', 2)) = lower(${installation.accountLogin})
      AND split_part(canonical_key, '/', 3) NOT IN ('.', '..')
    LIMIT 2`;
  const [alias] = aliases;
  if (!alias || aliases.length !== 1)
    return yield* invalid("Set one GitHub repository URL owned by the connected GitHub account.");
  return { canonicalKey: alias.canonicalKey, installationId: installation.installationId };
});

export const resolveWorkflowVmGitHub = Effect.fn("WorkflowVmGitHub.resolve")(function* (
  input: RepositoryScope & { readonly baseBranch: string | null },
) {
  const sql = (yield* RelayDb).$client;
  const binding = yield* selectWorkflowVmGitHubBinding(sql, input, false);
  const github = yield* GithubApp;
  const resolved = yield* github
    .resolveRepositoryBranch({
      ...binding,
      baseBranch: input.baseBranch,
    })
    .pipe(
      Effect.catchTags({
        GithubAppNotConfigured: () =>
          invalid(
            "Configure the GitHub App in Organization settings before running this workflow.",
          ),
        GithubRequestFailed: gitHubReadFailure,
      }),
      Effect.timeoutOrElse({ duration: "6 seconds", orElse: tryAgain }),
    );
  return {
    ...binding,
    ...resolved,
  } satisfies WorkflowVmGitHubResolution;
});

/** Hold the repository alias set and installation through the caller's admission transaction. */
export const recheckWorkflowVmGitHub = Effect.fnUntraced(function* (
  sql: PgClient,
  input: RepositoryScope,
  expected: Pick<WorkflowVmGitHubResolution, "canonicalKey" | "installationId">,
) {
  const [repository] = yield* sql`
    SELECT repository_id FROM relay_repositories
    WHERE organization_id = ${input.organizationId} AND repository_id = ${input.repositoryId}
    FOR SHARE`;
  if (!repository) return yield* bindingChanged();
  const binding = yield* selectWorkflowVmGitHubBinding(sql, input, true).pipe(
    Effect.catchTag("WorkflowInvalidError", bindingChanged),
  );
  if (
    binding.canonicalKey !== expected.canonicalKey ||
    binding.installationId !== expected.installationId
  )
    return yield* bindingChanged();
});
