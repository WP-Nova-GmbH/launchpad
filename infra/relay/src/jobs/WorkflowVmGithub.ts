import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  WorkflowInvalidError,
  type VmWorkflowStartFailure,
  type WorkflowStep,
} from "@t3tools/contracts/workflows";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import {
  GithubApp,
  type GithubRequestFailed,
  type GithubWorkflowPublicationTarget,
} from "../tenancy/GithubApp.ts";

type RepositoryScope = { readonly organizationId: string; readonly repositoryId: string };

export interface WorkflowVmGitHubResolution {
  readonly canonicalKey: string;
  readonly installationId: string;
  readonly branch: string;
  readonly commitSha: string;
}

const invalid = (message: string, vmStartFailure?: VmWorkflowStartFailure) =>
  new WorkflowInvalidError({ message, ...(vmStartFailure && { vmStartFailure }) });
const tryAgain = () =>
  invalid("Could not verify this repository with GitHub. Try again.", {
    kind: "github-verification-temporary",
  });
const appSetupRequired = () => invalid("Ask your Launchpad operator to configure the GitHub App.");
const appAuthenticationFailed = () =>
  invalid("Ask your Launchpad operator to check the GitHub App credentials.");
const appCredentialFailure = (error: GithubRequestFailed) =>
  error.operation === "sign-app-token" ||
  (error.operation === "mint-token" && error.status === 401);
const bindingChanged = () => invalid("This repository's GitHub connection changed. Try again.");
const githubRepositoryKey = "^github[.]com/[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+$";

function gitHubReadFailure(error: GithubRequestFailed, branch: string | null, repository: string) {
  if (error.rateLimited) return tryAgain();
  const { status } = error;
  if (appCredentialFailure(error)) return appAuthenticationFailed();
  if (error.operation === "read-branch" && (status === 404 || status === 409 || status === 422))
    return invalid("Choose an existing GitHub base branch with at least one commit.", {
      kind: "base-branch-unavailable",
      branch,
    });
  if (status === 301 || status === 302 || status === 307 || status === 308)
    return invalid(
      "Check that this repository has its current GitHub URL in Organization settings.",
    );
  if (
    error.permissionDenied ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 422
  )
    return invalid(
      "Give the organization's GitHub App read access to this repository, then retry.",
      {
        kind: "github-access-missing",
        ...(error.permissionDenied && { permission: "contents-read" }),
        repository,
      },
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
    return yield* invalid(
      "Connect the organization's GitHub App before running this VM workflow.",
      {
        kind: "github-access-missing",
      },
    );
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
  input: RepositoryScope & {
    readonly baseBranch: string | null;
    readonly publishingSteps?: readonly WorkflowStep[];
  },
) {
  const sql = (yield* RelayDb).$client;
  const github = yield* GithubApp;
  const binding = yield* selectWorkflowVmGitHubBinding(sql, input, false).pipe(
    Effect.catchTag("WorkflowInvalidError", (error) =>
      error.vmStartFailure?.kind === "github-access-missing"
        ? github.installUrl.pipe(
            Effect.flatMap((url) => Effect.fail(url ? error : appSetupRequired())),
          )
        : Effect.fail(error),
    ),
  );
  const repository = binding.canonicalKey.slice("github.com/".length);
  const missingAccess = { kind: "github-access-missing", repository } as const;
  const resolved = yield* github
    .resolveRepositoryBranch({
      ...binding,
      baseBranch: input.baseBranch,
    })
    .pipe(
      Effect.catchTags({
        GithubAppNotConfigured: appSetupRequired,
        GithubRequestFailed: (error) => gitHubReadFailure(error, input.baseBranch, repository),
      }),
      Effect.timeoutOrElse({ duration: "6 seconds", orElse: tryAgain }),
    );
  const openPr = input.publishingSteps?.some(
    (step) => step.kind === "action" && step.action === "open_pull_request",
  );
  const push = input.publishingSteps?.some(
    (step) => step.kind === "action" && step.action === "push",
  );
  if (openPr || push) {
    const access = openPr ? (push ? "workflow-publish" : "workflow-pr") : "workflow-push";
    yield* github.mintRepositoryToken({ ...binding, access }).pipe(
      Effect.catchTags({
        GithubAppNotConfigured: appSetupRequired,
        GithubRequestFailed: (error) => {
          if (appCredentialFailure(error)) return appAuthenticationFailed();
          if (error.permissionDenied)
            return invalid(
              openPr
                ? "Give the organization's GitHub App Contents and Pull requests write access for this workflow, then retry."
                : "Give the organization's GitHub App Contents write access for this workflow, then retry.",
              {
                ...missingAccess,
                permission: openPr ? "contents-and-pull-requests-write" : "contents-write",
              },
            );
          if (!error.rateLimited && error.status === 404)
            return invalid(
              "Give the organization's GitHub App access to this repository, then retry.",
              missingAccess,
            );
          return tryAgain();
        },
      }),
      Effect.timeoutOrElse({ duration: "6 seconds", orElse: tryAgain }),
    );
  }
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

/** Reconciliation uses the pinned App binding even after the guest is gone. */
export const observeWorkflowVmGitHub = Effect.fn("WorkflowVmGitHub.observePublication")(function* (
  input: RepositoryScope &
    Pick<WorkflowVmGitHubResolution, "canonicalKey" | "installationId"> & {
      readonly target: GithubWorkflowPublicationTarget;
    },
) {
  const sql = (yield* RelayDb).$client;
  const recheck = sql.withTransaction(recheckWorkflowVmGitHub(sql, input, input));
  yield* recheck;
  const observed = yield* (yield* GithubApp).observeWorkflowPublication({
    installationId: input.installationId,
    canonicalKey: input.canonicalKey,
    target: input.target,
  });
  yield* recheck;
  return observed;
});
