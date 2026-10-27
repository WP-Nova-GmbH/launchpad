import type { PgClient } from "@effect/sql-pg/PgClient";
import { ThreadId } from "@t3tools/contracts";
import {
  RelayThreadVmSetupReceipt,
  type RelayThreadVmSetupInput,
  type RelayThreadVmSetupReply,
} from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withPrivateThreadOwnerAccess } from "../http/privateThreadAccess.ts";
import { tenancyNotFound } from "../http/tenancyErrors.ts";
import type { ThreadVmComputeError } from "../machines/E2BThreadVmCompute.ts";
import { makeThreadVmProvisionStore } from "./ThreadVmProvisionStore.ts";
import { makeThreadVmSetupStore, ThreadVmSetupConflict } from "./ThreadVmSetupStore.ts";

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReceipt));
type Deliver = (
  sandboxId: string,
  environmentId: string,
  input: RelayThreadVmSetupInput & { readonly templateId?: string },
) => Effect.Effect<RelayThreadVmSetupReply, ThreadVmComputeError>;

/** Guest preparation owns no scheduling authority. Only a current verified receipt releases the hold. */
export function makeThreadVmSetupWorker(sql: PgClient, deliver: Deliver, hostId: string) {
  const provisions = makeThreadVmProvisionStore(sql);
  const setups = makeThreadVmSetupStore(sql);
  const runOne = Effect.fn("relay.thread_vm_setup.run_one")(function* () {
    const crypto = yield* Crypto.Crypto;
    const claimId = yield* crypto.randomUUIDv4;
    const row = yield* provisions.claimSetup(claimId, hostId);
    if (!row) return false;
    const claim = { allocationId: row.allocationId, claimId };
    const attempt = Effect.gen(function* () {
      const setup = yield* setups.get(row.allocationId);
      if (!setup || !row.computeRef)
        return yield* new ThreadVmSetupConflict({ message: "Setup allocation is unavailable" });
      const withAccess = <A, E, R>(action: Effect.Effect<A, E, R>) =>
        withPrivateThreadOwnerAccess(row.threadId, "write", setup.ownerUserId, () =>
          Effect.gen(function* () {
            yield* provisions.requireSetupClaim(claim);
            const aliases =
              yield* sql`SELECT canonical_key FROM relay_repository_aliases WHERE repository_id = ${setup.repositoryId} AND organization_id = ${setup.organizationId} AND canonical_key = ${setup.canonicalKey} FOR SHARE`;
            if (!aliases.length) return yield* tenancyNotFound("repository_not_found");
            return yield* action;
          }),
        );
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
          });
        }),
      );
      const environmentId = running.environmentId!;
      const reply = running.initialState
        ? yield* deliver(row.computeRef, environmentId, {
            ...running.initialState,
            templateId: row.templateId,
            workspace: {
              operationId: row.operationId,
              scope: {
                allocationId: row.allocationId,
                threadId: ThreadId.make(row.threadId),
                repositoryId: setup.repositoryId,
                generation: row.generation,
              },
              canonicalKey: setup.canonicalKey,
              branch: setup.branch,
              revision: setup.revision,
            },
          }).pipe(Effect.timeout("60 seconds"))
        : { status: "blocked" as const, code: "baseline_import_failed" as const };
      // Access, exact alias, worker claim and the live VM binding are rechecked after networking.
      yield* withAccess(
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
            yield* setups.finish({ allocationId: row.allocationId, environmentId, receiptSha256 });
          } else if (reply.code !== "setup_unconfirmed" && reply.code !== "baseline_unconfirmed") {
            yield* setups.fail({
              allocationId: row.allocationId,
              environmentId,
              errorCode: reply.code,
            });
          }
          yield* provisions.releaseSetupClaim({
            ...claim,
            errorCode: reply.status === "blocked" ? "setup_unconfirmed" : null,
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
