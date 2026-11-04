import type { PgClient } from "@effect/sql-pg/PgClient";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  RelayThreadVmSetupReceipt,
  RelayOrganizationId,
  RelayRepositoryId,
  type RelayThreadVmCheckoutFailureCode,
  type RelayThreadVmCheckoutFailureProbe,
  type RelayInternalError,
  type RelayTenancyNotFoundError,
  type RelayThreadVmSetupInput,
  type RelayThreadVmSetupReply,
} from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import {
  makeThreadVmProvisionStore,
  type ThreadVmProvisionConflict,
} from "./ThreadVmProvisionStore.ts";
import { makeThreadVmSetupStore, ThreadVmSetupConflict } from "./ThreadVmSetupStore.ts";
import type { RelayDb } from "../db.ts";
import { GithubApp } from "../tenancy/GithubApp.ts";
import type { ThreadVmResourceKind } from "./ThreadVmAllocationStore.ts";
import { withPreparingWorkflowVm } from "./ThreadVmWorkflowAccess.ts";

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReceipt));
type Deliver = (
  sandboxId: string,
  environmentId: string,
  input: RelayThreadVmSetupInput & { readonly templateId?: string },
  gitToken?: Redacted.Redacted<string>,
) => Effect.Effect<RelayThreadVmSetupReply, ThreadVmComputeError>;
type RecoverCheckoutFailure = (
  sandboxId: string,
  request: RelayThreadVmCheckoutFailureProbe & { readonly templateId: string },
) => Effect.Effect<RelayThreadVmCheckoutFailureCode | null, ThreadVmComputeError>;

/** Guest preparation owns no scheduling authority. Only a current verified receipt releases the hold. */
export function makeThreadVmSetupWorker(
  sql: PgClient,
  deliver: Deliver,
  hostId: string,
  resourceKind: ThreadVmResourceKind = "personal",
  recoverCheckoutFailure?: RecoverCheckoutFailure,
) {
  const provisions = makeThreadVmProvisionStore(sql);
  const setups = makeThreadVmSetupStore(sql);
  const runOne = Effect.fn("relay.thread_vm_setup.run_one")(function* () {
    const crypto = yield* Crypto.Crypto;
    const claimId = yield* crypto.randomUUIDv4;
    const row = yield* provisions.claimSetup(claimId, hostId, resourceKind);
    if (!row) return false;
    const claim = { allocationId: row.allocationId, claimId };
    const attempt = Effect.gen(function* () {
      const setup = yield* setups.getFor(row.allocationId, resourceKind);
      if (!setup || !row.computeRef)
        return yield* new ThreadVmSetupConflict({ message: "Setup allocation is unavailable" });
      const { computeRef, workflowSnapshot: snapshot } = row;
      const workspace = {
        operationId: row.operationId,
        scope: {
          allocationId: row.allocationId,
          threadId: ThreadId.make(row.threadId),
          repositoryId: RelayRepositoryId.make(setup.repositoryId),
          generation: row.generation,
        },
        canonicalKey: setup.canonicalKey,
        branch: setup.branch,
        revision: setup.revision,
      };
      const withWorkflowSetupClaim = <A, E, R>(action: Effect.Effect<A, E, R>) =>
        withPreparingWorkflowVm(sql, row, () =>
          Effect.gen(function* () {
            const current = yield* provisions.requireSetupClaim(claim);
            if (current.computeRef !== computeRef)
              return yield* new ThreadVmSetupConflict({ message: "Setup VM identity changed" });
            return yield* action;
          }),
        );
      if (snapshot && recoverCheckoutFailure && setup.phase === "running" && setup.environmentId) {
        const environmentId = EnvironmentId.make(setup.environmentId);
        const withRecoveryTarget = <A, E, R>(action: Effect.Effect<A, E, R>) =>
          withWorkflowSetupClaim(
            Effect.gen(function* () {
              const [target] = yield* sql`SELECT s.allocation_id FROM relay_thread_vm_setups s
                JOIN relay_thread_placements t ON t.thread_id=${row.threadId} AND t.environment_id=s.environment_id
                JOIN relay_thread_vm_bindings b ON b.allocation_id=s.allocation_id AND b.environment_id=s.environment_id
                WHERE s.allocation_id=${row.allocationId} AND s.phase='running' AND s.environment_id=${environmentId}
                  AND b.thread_id=t.thread_id AND b.repository_id=t.repository_id AND b.generation=t.generation
                FOR SHARE OF b`;
              if (!target)
                return yield* new ThreadVmSetupConflict({ message: "Setup identity changed" });
              return yield* action;
            }),
          );
        yield* withRecoveryTarget(Effect.void);
        const failure = yield* recoverCheckoutFailure(computeRef, {
          environmentId,
          workspace,
          templateId: row.templateId,
        }).pipe(
          Effect.timeout("8 seconds"),
          Effect.orElseSucceed(() => null),
        );
        if (failure !== null) {
          yield* withRecoveryTarget(
            setups
              .fail({
                allocationId: row.allocationId,
                environmentId,
                errorCode: failure,
                resourceKind,
              })
              .pipe(Effect.andThen(provisions.releaseSetupClaim({ ...claim, errorCode: null }))),
          );
          return;
        }
      }
      const withAccess = <A, E, R>(
        action: Effect.Effect<A, E, R>,
      ): Effect.Effect<
        A,
        | E
        | RelayTenancyNotFoundError
        | RelayInternalError
        | ThreadVmProvisionConflict
        | ThreadVmSetupConflict,
        R | RelayDb
      > => {
        if (snapshot)
          return withWorkflowSetupClaim(
            Effect.gen(function* () {
              const [git] = yield* sql`SELECT a.canonical_key FROM relay_repository_aliases a
            JOIN relay_github_installations g ON g.organization_id=a.organization_id
            WHERE a.repository_id=${setup.repositoryId} AND a.organization_id=${setup.organizationId}
              AND a.canonical_key=${snapshot.canonicalKey} AND g.installation_id=${snapshot.installationId} FOR SHARE OF g`;
              if (!git) return yield* tenancyNotFound("repository_not_found");
              return yield* action;
            }),
          );
        if (!setup.ownerUserId) return tenancyNotFound("thread_not_found");
        return withPrivateThreadOwnerAccess(row.threadId, "write", setup.ownerUserId, () =>
          Effect.gen(function* () {
            yield* provisions.requireSetupClaim(claim);
            const aliases =
              yield* sql`SELECT canonical_key FROM relay_repository_aliases WHERE repository_id = ${setup.repositoryId} AND organization_id = ${setup.organizationId} AND canonical_key = ${setup.canonicalKey} FOR SHARE`;
            if (!aliases.length) return yield* tenancyNotFound("repository_not_found");
            return yield* action;
          }),
        );
      };
      const running = yield* withAccess(
        Effect.gen(function* () {
          const [binding] = yield* sql<{
            environmentId: string;
          }>`SELECT environment_id AS "environmentId" FROM relay_thread_vm_bindings WHERE allocation_id = ${row.allocationId} AND revoked_at IS NULL`;
          if (!binding)
            return yield* new ThreadVmSetupConflict({ message: "Setup identity is unavailable" });
          return yield* setups.begin({
            allocationId: row.allocationId,
            environmentId: binding.environmentId,
            resourceKind,
          });
        }),
      );
      const environmentId = running.environmentId!;
      let gitToken: Redacted.Redacted<string> | undefined;
      if (snapshot) {
        const app = yield* Effect.serviceOption(GithubApp);
        if (Option.isNone(app))
          return yield* new ThreadVmSetupConflict({
            message: "Workflow GitHub App is unavailable",
          });
        const minted = yield* app.value.mintRepositoryToken({ ...snapshot, access: "read" }).pipe(
          Effect.timeout("6 seconds"),
          Effect.mapError(
            () =>
              new ThreadVmSetupConflict({
                message: "Workflow repository access could not be verified",
              }),
          ),
        );
        // GitHub I/O may outlast a claim or race cancellation. Recheck before the token leaves the relay.
        yield* withAccess(
          setups.begin({ allocationId: row.allocationId, environmentId, resourceKind }),
        );
        gitToken = Redacted.make(minted.token);
      }
      const reply = running.initialState
        ? yield* deliver(
            computeRef,
            environmentId,
            {
              ...running.initialState,
              templateId: row.templateId,
              ...(snapshot
                ? {
                    workflow: {
                      jobId: row.operationId,
                      organizationId: RelayOrganizationId.make(setup.organizationId),
                      installationId: snapshot.installationId,
                      baseBranch: snapshot.branch,
                    },
                  }
                : {}),
              workspace,
            },
            gitToken,
          ).pipe(Effect.timeout("60 seconds"))
        : { status: "blocked" as const, code: "baseline_import_failed" as const };
      const unconfirmed =
        reply.status === "blocked" &&
        (reply.code === "setup_unconfirmed" || reply.code === "baseline_unconfirmed");
      // A definitive workflow failure only tears down the claimed VM. Its original GitHub
      // installation can disappear during checkout without invalidating that failure.
      const withResultAccess =
        snapshot && reply.status === "blocked" && !unconfirmed
          ? withWorkflowSetupClaim
          : withAccess;
      yield* withResultAccess(
        Effect.gen(function* () {
          if (reply.status === "prepared") {
            const receipt = reply.receipt;
            if (
              receipt.operationId !== row.operationId ||
              receipt.environmentId !== environmentId ||
              receipt.scope.allocationId !== row.allocationId ||
              receipt.scope.threadId !== row.threadId ||
              receipt.scope.repositoryId !== setup.repositoryId ||
              receipt.scope.generation !== row.generation ||
              receipt.revision !== setup.revision ||
              receipt.projectId !== `vm:${row.threadId}` ||
              receipt.workspaceRoot !== "/workspace/project" ||
              receipt.execution !== "frozen"
            )
              return yield* new ThreadVmSetupConflict({
                message: "Setup receipt does not match its intent",
              });
            const digest = yield* crypto.digest(
              "SHA-256",
              new TextEncoder().encode(yield* encodeReceipt(receipt)),
            );
            const receiptSha256 = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            yield* setups.finish({
              allocationId: row.allocationId,
              environmentId,
              receiptSha256,
              resourceKind,
            });
          } else if (!unconfirmed) {
            yield* setups.fail({
              allocationId: row.allocationId,
              environmentId,
              errorCode: reply.code,
              resourceKind,
            });
          }
          yield* provisions.releaseSetupClaim({
            ...claim,
            errorCode:
              reply.status === "blocked" && (unconfirmed || resourceKind === "personal")
                ? "setup_unconfirmed"
                : null,
          });
        }),
      );
    });
    const defer = (errorCode: "setup_unconfirmed" | "setup_access_denied") =>
      provisions
        .releaseSetupClaim({ ...claim, errorCode })
        .pipe(Effect.catchTag("ThreadVmProvisionConflict", () => Effect.void));
    yield* attempt.pipe(
      Effect.catchTags({
        RelayTenancyNotFoundError: () => defer("setup_access_denied"),
        ThreadVmSetupConflict: () => defer("setup_unconfirmed"),
        ThreadVmComputeError: () => defer("setup_unconfirmed"),
        TimeoutError: () => defer("setup_unconfirmed"),
        SchemaError: () => defer("setup_unconfirmed"),
        RelayInternalError: () => defer("setup_unconfirmed"),
        ThreadVmProvisionConflict: () => Effect.void,
      }),
    );
    return true;
  });
  return { runOne };
}
