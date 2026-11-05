import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayEnvironmentPrincipal,
  RelayOrganizationId,
  RelayRepositoryId,
  type RelayThreadLocalEnrollmentRequest,
  type RelayThreadLocalEnrollmentReceiptRequest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { makeThreadLocalEnrollmentStore } from "../threads/ThreadLocalEnrollmentStore.ts";
import { withEnvironmentThread } from "./ThreadEnvironmentApi.ts";
import { tenancyNotFound, tenancyConflict } from "./tenancyErrors.ts";
import { relayInternalErrorResponse } from "./Api.ts";

const failures = {
  ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
};
const response = (
  result: Effect.Success<ReturnType<ReturnType<typeof makeThreadLocalEnrollmentStore>["prepare"]>>,
) => ({
  ...result,
  threadId: ThreadId.make(result.threadId),
  placement: {
    ...result.placement,
    threadId: ThreadId.make(result.placement.threadId),
    environmentId: EnvironmentId.make(result.placement.environmentId),
    projectId: ProjectId.make(result.placement.projectId),
    organizationId: RelayOrganizationId.make(result.placement.organizationId),
    repositoryId: RelayRepositoryId.make(result.placement.repositoryId),
  },
});

/** Only a currently linked personal environment can enroll an existing private local thread. */
export const prepareLocalThreadEnrollment = Effect.fn("relay.api.thread_local_enrollment.prepare")(
  function* (
    input: RelayThreadLocalEnrollmentRequest & { environmentId: string; threadId: string },
  ) {
    const principal = yield* RelayEnvironmentPrincipal,
      sql = (yield* RelayDb).$client;
    if (
      principal.threadVm ||
      !principal.credentialId ||
      principal.environmentId !== input.environmentId
    )
      return yield* tenancyNotFound("thread_not_found");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const keys =
          yield* sql`SELECT 1 FROM relay_environment_credentials WHERE credential_id=${principal.credentialId}
        AND environment_id=${input.environmentId} AND environment_public_key=${principal.environmentPublicKey}
        AND revoked_at IS NULL FOR SHARE`;
        const links =
          yield* sql`SELECT 1 FROM relay_environment_links WHERE environment_id=${input.environmentId}
        AND environment_public_key=${principal.environmentPublicKey} AND user_id=${input.actorUserId}
        AND revoked_at IS NULL FOR SHARE`;
        if (!keys.length || !links.length) return yield* tenancyNotFound("thread_not_found");
        const aliases = yield* sql<{
          organizationId: string;
          repositoryId: string;
          role: string;
        }>`SELECT a.organization_id AS "organizationId",
        a.repository_id AS "repositoryId",m.role FROM relay_repository_aliases a
        JOIN relay_repositories r ON r.repository_id=a.repository_id AND r.organization_id=a.organization_id
        JOIN relay_organization_members m ON m.organization_id=a.organization_id AND m.user_id=${input.actorUserId}
        WHERE a.canonical_key=${input.canonicalKey} FOR SHARE OF a,r,m`;
        if (aliases.length !== 1) return yield* tenancyNotFound("repository_not_found");
        const binding = aliases[0]!;
        if (binding.role !== "admin") {
          const grants =
            yield* sql`SELECT 1 FROM relay_repository_access WHERE organization_id=${binding.organizationId}
          AND repository_id=${binding.repositoryId} AND user_id=${input.actorUserId} FOR SHARE`;
          if (!grants.length) return yield* tenancyNotFound("repository_not_found");
        }
        return response(
          yield* makeThreadLocalEnrollmentStore(sql).prepare({
            ...input,
            organizationId: binding.organizationId,
            repositoryId: binding.repositoryId,
            ownerUserId: input.actorUserId,
          }),
        );
      }),
    );
  },
  Effect.catchTags(failures),
);
export const receiveLocalEnrollmentReceipts = Effect.fn(
  "relay.api.thread_local_enrollment.receipts",
)(
  function* (
    input: RelayThreadLocalEnrollmentReceiptRequest & { environmentId: string; threadId: string },
  ) {
    return yield* withEnvironmentThread(
      { ...input, generation: 1 },
      true,
      makeThreadLocalEnrollmentStore((yield* RelayDb).$client).receipts(input),
    );
  },
  Effect.catchTags({
    ThreadPlacementConflict: failures.ThreadPlacementConflict,
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);
export const confirmLocalThreadEnrollment = Effect.fn("relay.api.thread_local_enrollment.confirm")(
  function* (input: {
    environmentId: string;
    threadId: string;
    operationId: string;
    sourceSequence: number;
    receiptCount: number;
  }) {
    return response(
      yield* withEnvironmentThread(
        { ...input, generation: 1 },
        true,
        makeThreadLocalEnrollmentStore((yield* RelayDb).$client).confirm(input),
      ),
    );
  },
  Effect.catchTag("ThreadPlacementConflict", failures.ThreadPlacementConflict),
);

/** Cleanup remains available to the exact live source credential after link/repository access is revoked. */
export const abortLocalThreadEnrollment = Effect.fn("relay.api.thread_local_enrollment.abort")(
  function* (
    input: RelayThreadLocalEnrollmentRequest & { environmentId: string; threadId: string },
  ) {
    const principal = yield* RelayEnvironmentPrincipal,
      sql = (yield* RelayDb).$client;
    if (
      principal.threadVm ||
      !principal.credentialId ||
      principal.environmentId !== input.environmentId
    )
      return yield* tenancyNotFound("thread_not_found");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const keys =
          yield* sql`SELECT 1 FROM relay_environment_credentials WHERE credential_id=${principal.credentialId}
      AND environment_id=${input.environmentId} AND environment_public_key=${principal.environmentPublicKey} AND revoked_at IS NULL FOR SHARE`;
        if (!keys.length) return yield* tenancyNotFound("thread_not_found");
        const result = yield* makeThreadLocalEnrollmentStore(sql).abort(input);
        return {
          ...result,
          threadId: ThreadId.make(result.threadId),
          environmentId: EnvironmentId.make(result.environmentId),
          projectId: ProjectId.make(result.projectId),
        };
      }),
    );
  },
  Effect.catchTags(failures),
);
