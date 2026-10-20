import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  RelayApi,
  RelayEnvironmentPrincipal,
  type RelayPortableThreadPlacement,
  type RelayThreadMove,
} from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
import { authorizeThreadEnvironment, withEnvironmentThread } from "./ThreadEnvironmentApi.ts";
import { withPrivateThreadOwnerAccess } from "./privateThreadAccess.ts";
import { relayInternalErrorResponse } from "./Api.ts";
import { tenancyConflict, tenancyNotFound } from "./tenancyErrors.ts";

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
  return {
    ...move,
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
  input: { destinationEnvironmentId: string; expectedGeneration: number },
) {
  const sql = (yield* RelayDb).$client;
  const credentials = yield* sql<{ credentialId: string; publicKey: string }>`SELECT
    credential_id AS "credentialId", environment_public_key AS "publicKey"
    FROM relay_environment_credentials WHERE environment_id=${input.destinationEnvironmentId}
      AND revoked_at IS NULL ORDER BY credential_id FOR SHARE`;
  for (const credential of credentials) {
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
    if (allowed) return;
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
  function* (input: Participant & { actorUserId: string; cancelBeforeStart: boolean }) {
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

export const pendingPortableThreadMoves = Effect.fn("relay.api.thread_moves.pending")(
  function* (input: { environmentId: string; after: string | null; limit: number }) {
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
      const move = yield* getPortableThreadMove({
        ...candidate,
        environmentId: input.environmentId,
        generation: candidate.generation + (candidate.source === input.environmentId ? 0 : 1),
      }).pipe(Effect.catchTag("RelayTenancyNotFoundError", () => Effect.succeed(null)));
      if (move) entries.push(move);
    }
    return { entries, next: candidates.length > input.limit ? page.at(-1)!.operationId : null };
  },
  Effect.catchTag("SqlError", () => relayInternalErrorResponse("persistence_failed")),
);

export const freezePortableThreadMove = Effect.fn("relay.api.thread_moves.freeze")(function* (
  input: Participant & { sourceCursor: number; manifestSha256: string },
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withThreadMoveParticipant(input, "source", true, () =>
      makeThreadPlacementStore(sql).sourceFrozen(input),
    ),
  );
}, Effect.catchTags(failures));

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
  input: Participant & { sourceCursor: number; manifestSha256: string },
) {
  const sql = (yield* RelayDb).$client;
  return yield* response(
    yield* withThreadMoveParticipant(input, "destination", true, () =>
      makeThreadPlacementStore(sql).destinationReady(input),
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
