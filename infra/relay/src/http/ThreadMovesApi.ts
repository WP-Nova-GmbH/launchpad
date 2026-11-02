import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayEnvironmentPrincipal,
  type RelayPortableThreadPlacement,
  type RelayThreadMove,
  type ThreadMoveProgressReport,
} from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ThreadTransferFormat } from "@t3tools/contracts/threadTransferFormat";
import { normalizeThreadTransferFormats } from "@t3tools/shared/threadTransferEncoding";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { ThreadVmRuntimeConfiguration } from "../threads/ThreadVmRuntime.ts";
import { makeThreadVmMoveDestinationStore } from "../threads/ThreadVmMoveDestinationStore.ts";
import { makeThreadVmCapacityStore } from "../threads/ThreadVmCapacityStore.ts";
import { makeThreadVmReplacementCoordinator } from "../threads/ThreadVmReplacementCoordinator.ts";
import { serializeReplacement } from "./ThreadVmsApi.ts";
import { makeThreadVmReplacementStore } from "../threads/ThreadVmReplacementStore.ts";
import { RelayDb } from "../db.ts";
import { ThreadArtifactObjectStorage } from "../threads/ThreadArtifactObjects.ts";
import { makeThreadMoveArtifactStore } from "../threads/ThreadMoveArtifactStore.ts";
import { makeThreadMoveCheckpointStore } from "../threads/ThreadMoveCheckpointStore.ts";
import { makeThreadPlacementStore, type ThreadMove } from "../threads/ThreadPlacementStore.ts";
import { makeThreadMoveProgressStore } from "../threads/ThreadMoveProgressStore.ts";
import { authorizeThreadEnvironment, withEnvironmentThread } from "./ThreadEnvironmentApi.ts";
import { withPrivateThreadOwnerAccess } from "./privateThreadAccess.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";
import { makeThreadVmCodexAuthStore } from "../threads/ThreadVmCodexAuthStore.ts";

type Participant = {
  readonly threadId: string;
  readonly operationId: string;
  readonly environmentId: string;
  readonly generation: number;
};
const failures = {
  ThreadPlacementConflict: () => tenancyConflict("thread_placement_changed"),
  SqlError: () => relayInternalErrorResponse("persistence_failed"),
};
const response = Effect.fnUntraced(function* (move: ThreadMove) {
  const sql = (yield* RelayDb).$client;
  const objects = yield* ThreadArtifactObjectStorage;
  const [artifact] = yield* sql<{
    manifestArtifactId: string;
  }>`SELECT manifest_artifact_id AS "manifestArtifactId"
    FROM relay_thread_move_artifacts WHERE operation_id=${move.operationId}`;
  const aliases = yield* sql<{ canonicalKey: string }>`SELECT a.canonical_key AS "canonicalKey"
    FROM relay_repository_aliases a
    JOIN relay_thread_placements p ON p.repository_id=a.repository_id AND p.organization_id=a.organization_id
    WHERE p.thread_id=${move.threadId} ORDER BY a.canonical_key`;
  return {
    ...move,
    repositoryCanonicalKeys: aliases.map((alias) => alias.canonicalKey),
    progress: yield* makeThreadMoveProgressStore(sql).read(move.operationId),
    manifestArtifactId: artifact?.manifestArtifactId ?? null,
    recoveryVerified: artifact
      ? yield* makeThreadMoveCheckpointStore(sql, objects).isRetainedComplete({
          threadId: move.threadId,
          operationId: move.operationId,
          manifestArtifactId: artifact.manifestArtifactId,
        })
      : false,
    threadId: ThreadId.make(move.threadId),
    sourceEnvironmentId: EnvironmentId.make(move.sourceEnvironmentId),
    destinationEnvironmentId: EnvironmentId.make(move.destinationEnvironmentId),
    destinationProjectId: ProjectId.make(move.destinationProjectId),
  } satisfies RelayThreadMove;
});

/** Destination checks never substitute a client's UUID for a live trusted identity. */
const requireDestination = Effect.fnUntraced(function* (
  placement: RelayPortableThreadPlacement,
  input: {
    destinationEnvironmentId: string;
    expectedGeneration: number;
    publicKey?: string;
    credentialId?: string;
    grantSource?: "link" | "machine";
  },
) {
  const sql = (yield* RelayDb).$client;
  const credentials = yield* sql<{ credentialId: string; publicKey: string }>`SELECT
    credential_id AS "credentialId", environment_public_key AS "publicKey"
    FROM relay_environment_credentials WHERE environment_id=${input.destinationEnvironmentId}
      AND revoked_at IS NULL AND (${input.publicKey ?? null}::text IS NULL OR environment_public_key=${input.publicKey ?? null})
      AND (${input.credentialId ?? null}::text IS NULL OR credential_id=${input.credentialId ?? null}) ORDER BY credential_id FOR SHARE`;
  for (const credential of credentials) {
    if (input.grantSource) {
      const grant =
        input.grantSource === "link"
          ? yield* sql`SELECT user_id FROM relay_environment_links WHERE environment_id=${input.destinationEnvironmentId}
            AND environment_public_key=${credential.publicKey} AND user_id=${placement.ownerUserId} AND revoked_at IS NULL FOR SHARE`
          : yield* sql`SELECT machine_id FROM relay_machines WHERE environment_id=${input.destinationEnvironmentId}
            AND environment_public_key=${credential.publicKey} AND organization_id=${placement.organizationId}
            AND deprovisioned_at IS NULL FOR SHARE`;
      if (!grant.length) continue;
    }
    const [binding] = yield* sql<{
      allocationId: string;
      threadId: string;
      repositoryId: string;
      generation: number;
    }>`SELECT
      allocation_id AS "allocationId", thread_id AS "threadId", repository_id AS "repositoryId", generation
      FROM relay_thread_vm_bindings WHERE environment_id=${input.destinationEnvironmentId}
        AND credential_id=${credential.credentialId} AND revoked_at IS NULL`;
    const allowed = yield* authorizeThreadEnvironment(
      {
        threadId: placement.threadId,
        environmentId: input.destinationEnvironmentId,
        generation: input.expectedGeneration + 1,
      },
      placement,
      true,
    ).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, {
        environmentId: input.destinationEnvironmentId,
        environmentPublicKey: credential.publicKey,
        credentialId: credential.credentialId,
        ...(binding ? { threadVm: { ...binding, threadId: ThreadId.make(binding.threadId) } } : {}),
      }),
      Effect.as(true),
      Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(false)),
    );
    if (allowed) return credential;
  }
  return yield* tenancyNotFound("thread_not_found");
});

/** The source keeps its old generation during a committed handoff; the
 * quarantined destination has exactly the next generation. Neither can name
 * another participant, an old move, or an unrelated VM allocation. */
export const withThreadMoveParticipant = <A, E, R>(
  input: Participant,
  role: "source" | "destination" | "either",
  currentAccess: boolean,
  action: (move: ThreadMove, placement: RelayPortableThreadPlacement) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = (yield* RelayDb).$client;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [locked] = yield* sql`SELECT thread_id FROM relay_thread_placements
      WHERE thread_id=${input.threadId} FOR UPDATE`;
        if (!locked) return yield* tenancyNotFound("thread_not_found");
        const store = makeThreadPlacementStore(sql);
        const placement = yield* store.get(input.threadId);
        const move = yield* store.getMove(input);
        if (!placement) return yield* tenancyNotFound("thread_not_found");
        const source =
          input.environmentId === move.sourceEnvironmentId &&
          input.generation === move.expectedGeneration;
        const destination =
          input.environmentId === move.destinationEnvironmentId &&
          input.generation === move.expectedGeneration + 1;
        if (
          (role === "source" && !source) ||
          (role === "destination" && !destination) ||
          (!source && !destination)
        )
          return yield* tenancyNotFound("thread_not_found");
        const committed = move.phase === "committed" || move.phase === "completed";
        if (
          placement.generation !== move.expectedGeneration + (committed ? 1 : 0) ||
          placement.environmentId !==
            (committed ? move.destinationEnvironmentId : move.sourceEnvironmentId) ||
          (placement.operationId !== move.operationId &&
            !["completed", "aborted"].includes(move.phase))
        )
          return yield* tenancyConflict("thread_placement_changed");
        yield* authorizeThreadEnvironment(input, placement, currentAccess);
        return yield* currentAccess
          ? withPrivateThreadOwnerAccess(input.threadId, "write", move.actorUserId, () =>
              action(move, placement),
            )
          : action(move, placement);
      }),
    );
  });

export const beginPortableThreadMove = Effect.fn("relay.api.thread_moves.begin")(function* (
  input: Participant & {
    actorUserId: string;
    destinationEnvironmentId: string;
    destinationProjectId: string;
    sourceThreadTransferFormats?: readonly ThreadTransferFormat[];
  },
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withEnvironmentThread(
      input,
      true,
      Effect.gen(function* () {
        const placement = yield* makeThreadPlacementStore(sql).get(input.threadId);
        if (!placement || placement.ownerUserId !== input.actorUserId)
          return yield* tenancyNotFound("thread_not_found");
        yield* requireDestination(placement, { ...input, expectedGeneration: input.generation });
        return yield* makeThreadPlacementStore(sql).beginMove({
          ...input,
          sourceEnvironmentId: input.environmentId,
          expectedGeneration: input.generation,
        });
      }),
    ),
  );
}, Effect.catchTags(failures));

export const beginPortableThreadVmMove = Effect.fn("relay.api.thread_moves.begin_vm")(
  function* (
    input: Participant & {
      actorUserId: string;
      cancelBeforeStart: boolean;
      sourceThreadTransferFormats?: readonly ThreadTransferFormat[];
    },
  ) {
    const sql = (yield* RelayDb).$client;
    const { settings } = yield* ThreadVmRuntimeConfiguration;
    if (!settings) return yield* relayInternalErrorResponse("upstream_unavailable");
    yield* makeThreadVmCapacityStore(sql).configure(settings.hostId, settings.maxRunningVms);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Quota writers take this user lock before the placement lock.
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.actorUserId},721864))`;
          const move = yield* withEnvironmentThread(
            input,
            true,
            Effect.gen(function* () {
              const placement = yield* makeThreadPlacementStore(sql).get(input.threadId);
              if (!placement || placement.ownerUserId !== input.actorUserId)
                return yield* tenancyNotFound("thread_not_found");
              if (input.cancelBeforeStart) {
                const objects = yield* ThreadArtifactObjectStorage;
                const replacements = makeThreadVmReplacementCoordinator(sql, objects);
                const pending = yield* replacements.get(input.operationId);
                if (pending && pending.phase !== "admitted")
                  yield* replacements.cancel({
                    requestId: input.operationId,
                    ownerUserId: input.actorUserId,
                  });
              }
              return yield* makeThreadVmMoveDestinationStore(sql).enqueue({
                ...input,
                sourceEnvironmentId: input.environmentId,
                expectedGeneration: input.generation,
                hostId: settings.hostId,
                templateId: settings.compute.templateId,
              });
            }),
          );
          return { status: "accepted" as const, move: yield* response(move) };
        }),
      )
      .pipe(
        Effect.catchTag("ThreadVmQuotaExceeded", (error) =>
          Effect.gen(function* () {
            const principal = yield* RelayEnvironmentPrincipal;
            if (!principal.credentialId) return yield* tenancyNotFound("thread_not_found");
            const placement = yield* makeThreadPlacementStore(sql).get(input.threadId);
            if (!placement) return yield* tenancyNotFound("thread_not_found");
            const objects = yield* ThreadArtifactObjectStorage;
            const replacement = yield* makeThreadVmReplacementCoordinator(sql, objects).record({
              requestId: input.operationId,
              threadId: input.threadId,
              ownerUserId: input.actorUserId,
              organizationId: placement.organizationId,
              repositoryId: placement.repositoryId,
              hostId: settings.hostId,
              templateId: settings.compute.templateId,
              intent: {
                kind: "move",
                threadId: input.threadId,
                operationId: input.operationId,
                actorUserId: input.actorUserId,
                sourceEnvironmentId: input.environmentId,
                expectedGeneration: input.generation,
                sourceCredentialId: principal.credentialId,
                sourcePublicKey: principal.environmentPublicKey,
                sourceAllocationId: principal.threadVm?.allocationId ?? null,
                ...(input.sourceThreadTransferFormats === undefined
                  ? {}
                  : {
                      sourceThreadTransferFormats: normalizeThreadTransferFormats(
                        input.sourceThreadTransferFormats,
                      ),
                    }),
              },
            });
            const candidate = yield* makeThreadVmReplacementStore(sql).suggest(input.actorUserId);
            return {
              status: "quota_reached" as const,
              replacement: serializeReplacement(replacement),
              maxVms: error.maxVms,
              reservedVms: error.reservedVms,
              suggestedReplacement: candidate
                ? { ...candidate, threadId: ThreadId.make(candidate.threadId) }
                : null,
            };
          }),
        ),
      );
  },
  Effect.catchTags({
    ...failures,
    ThreadVmReplacementConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmFinalSaveConflict: () => tenancyConflict("thread_placement_changed"),
    SchemaError: () => relayInternalErrorResponse("persistence_failed"),
    ThreadVmAllocationConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmProvisionConflict: () => tenancyConflict("thread_placement_changed"),
    ThreadVmCapacityConflict: () => tenancyConflict("thread_placement_changed"),
  }),
);

export const getPortableThreadMove = Effect.fn("relay.api.thread_moves.get")(function* (
  input: Participant,
) {
  return yield* response(
    yield* withThreadMoveParticipant(input, "either", true, (move) => Effect.succeed(move)),
  );
}, Effect.catchTags(failures));

/** Select before packing; an admitted guest can report formats without starting its import server. */
export const selectPortableThreadMoveEncoding = Effect.fn("relay.api.thread_moves.encoding")(
  function* (input: Participant) {
    const sql = (yield* RelayDb).$client;
    const store = makeThreadPlacementStore(sql);
    const selected = yield* withThreadMoveParticipant(input, "source", true, (move, placement) =>
      Effect.gen(function* () {
        if (move.transferEncodingPolicy != null) return move;
        const [guest] = yield* sql<{
          allocationId: string;
          environmentId: string | null;
        }>`SELECT d.allocation_id AS "allocationId",e.environment_id AS "environmentId",
      d.operation_id FROM relay_thread_vm_move_destinations d
      LEFT JOIN relay_thread_vm_enrollments e USING(allocation_id) WHERE d.operation_id=${move.operationId}`;
        // Ordinary receivers attest formats on their authenticated move poll.
        // Their public endpoint may be absent or stale while the relay link works.
        if (!guest || guest.environmentId === null) return move;
        const valid = yield* sql<{
          formats: readonly ThreadTransferFormat[] | null;
        }>`SELECT e.thread_transfer_formats_json AS formats FROM relay_thread_vm_allocations a
        JOIN relay_thread_vm_bindings b USING(allocation_id)
        JOIN relay_environment_credentials c ON c.credential_id=b.credential_id
        JOIN relay_thread_vm_enrollments e USING(allocation_id)
        WHERE a.allocation_id=${guest.allocationId} AND a.thread_id=${move.threadId}
          AND a.owner_user_id=${move.actorUserId} AND a.state='running' AND a.deleted_at IS NULL
          AND b.environment_id=${guest.environmentId} AND b.thread_id=${move.threadId}
          AND b.repository_id=${placement.repositoryId} AND b.generation=${move.expectedGeneration + 1}
          AND b.revoked_at IS NULL AND c.revoked_at IS NULL AND c.environment_id=b.environment_id
          AND c.environment_public_key=b.environment_public_key AND e.environment_id=b.environment_id
          AND e.environment_public_key=b.environment_public_key AND e.credential_id=b.credential_id
          AND e.operation_id=${move.operationId}
          AND (${move.destinationEnvironmentId}=${`pending-vm:${move.operationId}`} OR b.environment_id=${move.destinationEnvironmentId})
        FOR SHARE OF a,b,c,e`;
        if (!valid.length) return yield* tenancyNotFound("thread_not_found");
        return yield* store.selectEncoding({
          ...move,
          destinationThreadTransferFormats: normalizeThreadTransferFormats(valid[0]!.formats),
        });
      }),
    );
    return yield* response(selected);
  },
  Effect.catchTags(failures),
);

export const reportPortableThreadMoveProgress = Effect.fn("relay.api.thread_moves.progress")(
  function* (input: Participant & ThreadMoveProgressReport) {
    const sql = (yield* RelayDb).$client;
    yield* withThreadMoveParticipant(input, "either", true, (move) =>
      makeThreadMoveProgressStore(sql).report(move, input),
    );
    return { accepted: true as const };
  },
  Effect.catchTags(failures),
);

export const pendingPortableThreadMoves = Effect.fn("relay.api.thread_moves.pending")(
  function* (input: {
    environmentId: string;
    after: string | null;
    limit: number;
    threadTransferFormats?: readonly ThreadTransferFormat[];
  }) {
    const principal = yield* RelayEnvironmentPrincipal;
    if (!principal.credentialId || principal.environmentId !== input.environmentId)
      return yield* tenancyNotFound("thread_not_found");
    const sql = (yield* RelayDb).$client;
    const candidates = yield* sql<{
      threadId: string;
      operationId: string;
      source: string;
      generation: number;
    }>`SELECT
    m.thread_id AS "threadId", m.operation_id AS "operationId", m.source_environment_id AS source,
    m.expected_generation AS generation FROM relay_thread_moves m JOIN relay_thread_placements p USING(thread_id)
    WHERE p.operation_id=m.operation_id AND m.phase NOT IN ('completed','aborted')
      AND (m.source_environment_id=${input.environmentId} OR m.destination_environment_id=${input.environmentId})
      AND (${input.after}::text IS NULL OR m.operation_id>${input.after})
      AND (${principal.threadVm?.threadId ?? null}::text IS NULL OR m.thread_id=${principal.threadVm?.threadId ?? null})
    ORDER BY m.operation_id LIMIT ${input.limit + 1}`;
    const page = candidates.slice(0, input.limit);
    const entries: RelayThreadMove[] = [];
    for (const candidate of page) {
      const participant = {
        ...candidate,
        environmentId: input.environmentId,
        generation: candidate.generation + (candidate.source === input.environmentId ? 0 : 1),
      };
      const move = yield* withThreadMoveParticipant(participant, "either", true, (move) =>
        Effect.gen(function* () {
          if (
            principal.threadVm ||
            move.destinationEnvironmentId !== input.environmentId ||
            move.transferEncodingPolicy !== null ||
            !["preparing", "frozen"].includes(move.phase)
          )
            return move;
          const [offer] = yield* sql<{ formats: readonly ThreadTransferFormat[] }>`SELECT
            source_formats_json AS formats FROM relay_thread_moves WHERE operation_id=${move.operationId}`;
          if (!offer) return yield* tenancyNotFound("thread_not_found");
          const destination = normalizeThreadTransferFormats(input.threadTransferFormats);
          const source = normalizeThreadTransferFormats(offer.formats);
          const store = makeThreadPlacementStore(sql);
          if (!source.some((format) => destination.includes(format)))
            return yield* store.reportFailure({
              ...participant,
              detail:
                "The source and destination do not share a supported transfer format. Update the destination or cancel this move.",
            });
          return yield* store.selectEncoding({
            ...move,
            destinationThreadTransferFormats: destination,
          });
        }),
      ).pipe(
        Effect.flatMap(response),
        Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)),
      );
      if (move) entries.push(move);
    }
    return { entries, next: candidates.length > input.limit ? page.at(-1)!.operationId : null };
  },
  Effect.catchTags(failures),
);

export const freezePortableThreadMove = Effect.fn("relay.api.thread_moves.freeze")(function* (
  input: Participant & { sourceCursor: number; manifestSha256: string; attempt?: number },
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withThreadMoveParticipant(input, "source", true, () =>
      makeThreadPlacementStore(sql).sourceFrozen(input),
    ),
  );
}, Effect.catchTags(failures));

export const reportPortableThreadMoveFailure = Effect.fn("relay.api.thread_moves.failed")(
  function* (input: Participant & { detail: string; attempt?: number }) {
    const sql = (yield* RelayDb).$client;
    return yield* response(
      yield* withThreadMoveParticipant(input, "either", true, () =>
        makeThreadPlacementStore(sql).reportFailure(input),
      ),
    );
  },
  Effect.catchTags(failures),
);

export const publishPortableThreadMove = Effect.fn("relay.api.thread_moves.publish")(
  function* (input: Participant & { manifestArtifactId: string }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    // Full archive verification and object reads run outside the authorization
    // transaction. The store rechecks operation ownership before publishing pins;
    // a final access check precedes acknowledgement, and commit checks it again.
    yield* withThreadMoveParticipant(input, "source", true, () => Effect.void);
    const receipt = yield* makeThreadMoveArtifactStore(sql, objects).publish(input);
    yield* withThreadMoveParticipant(input, "source", true, () => Effect.void);
    return receipt;
  },
  Effect.catchTags({
    ...failures,
    ThreadAttachmentReferencesError: () => tenancyConflict("thread_checkpoint_conflict"),
    ThreadMoveCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    ThreadNativeCheckpointConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    SchemaError: () => tenancyConflict("thread_checkpoint_conflict"),
    TimeoutError: () => relayInternalErrorResponse("upstream_unavailable"),
    ThreadMoveArtifactConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    ThreadArtifactConflict: () => tenancyConflict("thread_artifact_conflict"),
    ThreadArtifactObjectError: () => relayInternalErrorResponse("persistence_failed"),
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

export const readPortableThreadMoveArtifact = Effect.fn("relay.api.thread_moves.read_artifact")(
  function* (input: Participant & { artifactId: string }) {
    const sql = (yield* RelayDb).$client;
    const objects = yield* ThreadArtifactObjectStorage;
    yield* withThreadMoveParticipant(input, "either", true, (move) =>
      ["frozen", "ready", "committed"].includes(move.phase)
        ? Effect.void
        : tenancyConflict("thread_placement_changed"),
    );
    // Authorize and acquire the read pin before returning HTTP headers. The
    // stream keeps its one-hour read lease until it completes or disconnects.
    const body = yield* makeThreadMoveArtifactStore(sql, objects).openPublished(input);
    return body.pipe(
      Stream.provideContext(
        yield* Effect.context<RelayDb | ThreadArtifactObjectStorage | Crypto.Crypto>(),
      ),
    );
  },
  Effect.catchTags({
    ...failures,
    ThreadMoveArtifactConflict: () => tenancyConflict("thread_checkpoint_conflict"),
    ThreadArtifactConflict: () => tenancyConflict("thread_artifact_conflict"),
    ThreadArtifactObjectError: () => relayInternalErrorResponse("persistence_failed"),
    PlatformError: () => relayInternalErrorResponse("persistence_failed"),
  }),
);

export const readyPortableThreadMove = Effect.fn("relay.api.thread_moves.ready")(function* (
  input: Participant & { sourceCursor: number; manifestSha256: string; attempt?: number },
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withThreadMoveParticipant(input, "destination", true, (_, placement) =>
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (principal.threadVm)
          yield* makeThreadVmCodexAuthStore(sql).requireAcknowledged({
            ...input,
            allocationId: principal.threadVm.allocationId,
            organizationId: placement.organizationId,
          });
        return yield* makeThreadPlacementStore(sql).destinationReady(input);
      }),
    ),
  );
}, Effect.catchTags(failures));

export const commitPortableThreadMove = Effect.fn("relay.api.thread_moves.commit")(function* (
  input: Participant,
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withThreadMoveParticipant(input, "either", true, (move, placement) =>
      Effect.gen(function* () {
        yield* requireDestination(placement, move);
        return yield* makeThreadPlacementStore(sql).commitMove(input);
      }),
    ),
  );
}, Effect.catchTags(failures));

export const activatePortableThreadMove = Effect.fn("relay.api.thread_moves.activate")(function* (
  input: Participant,
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withThreadMoveParticipant(input, "destination", true, () =>
      makeThreadPlacementStore(sql).activated(input),
    ),
  );
}, Effect.catchTags(failures));

export const abortPortableThreadMove = Effect.fn("relay.api.thread_moves.abort")(function* (
  input: Participant,
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withThreadMoveParticipant(input, "source", false, () =>
      makeThreadPlacementStore(sql).requestAbort(input),
    ),
  );
}, Effect.catchTags(failures));

export const confirmPortableThreadMoveDestinationRemoved = Effect.fn(
  "relay.api.thread_moves.removed",
)(function* (input: Participant) {
  const sql = (yield* RelayDb).$client;
  const principal = yield* RelayEnvironmentPrincipal;
  // A guest cannot attest that its own VM no longer exists. VM destruction is
  // confirmed by the compute reconciler before quota or the source is released.
  if (principal.threadVm) return yield* tenancyConflict("thread_placement_changed");
  return yield* response(
    yield* withThreadMoveParticipant(input, "destination", false, () =>
      makeThreadPlacementStore(sql).destinationRemoved(input),
    ),
  );
}, Effect.catchTags(failures));

export const threadMovesApi = HttpApiBuilder.group(RelayApi, "threadMoves", (handlers) =>
  handlers
    .handle("progress", ({ params, payload }) =>
      reportPortableThreadMoveProgress({ ...params, ...payload }),
    )
    .handle("pending", ({ params, payload }) =>
      pendingPortableThreadMoves({ ...params, ...payload }),
    )
    .handle("artifact", ({ params, query }) =>
      readPortableThreadMoveArtifact({ ...params, ...query }),
    )
    .handle("begin", ({ params, payload }) => beginPortableThreadMove({ ...params, ...payload }))
    .handle("beginVm", ({ params, payload }) =>
      beginPortableThreadVmMove({ ...params, ...payload }),
    )
    .handle("get", ({ params, payload }) => getPortableThreadMove({ ...params, ...payload }))
    .handle("selectEncoding", ({ params, payload }) =>
      selectPortableThreadMoveEncoding({ ...params, ...payload }),
    )
    .handle("failed", ({ params, payload }) =>
      reportPortableThreadMoveFailure({ ...params, ...payload }),
    )
    .handle("freeze", ({ params, payload }) => freezePortableThreadMove({ ...params, ...payload }))
    .handle("publish", ({ params, payload }) =>
      publishPortableThreadMove({ ...params, ...payload }),
    )
    .handle("ready", ({ params, payload }) => readyPortableThreadMove({ ...params, ...payload }))
    .handle("commit", ({ params, payload }) => commitPortableThreadMove({ ...params, ...payload }))
    .handle("activate", ({ params, payload }) =>
      activatePortableThreadMove({ ...params, ...payload }),
    )
    .handle("abort", ({ params, payload }) => abortPortableThreadMove({ ...params, ...payload }))
    .handle("removed", ({ params, payload }) =>
      confirmPortableThreadMoveDestinationRemoved({ ...params, ...payload }),
    ),
);
