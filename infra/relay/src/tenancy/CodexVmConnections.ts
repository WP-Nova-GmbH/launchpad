import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface CodexVmConnection {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly epoch: number;
  readonly tokenRevision: number;
  readonly actionRevision: number;
  readonly latestAttemptId: string | null;
  readonly issuer: string | null;
  readonly subject: string | null;
  readonly clientId: string | null;
  readonly label: string | null;
  readonly status: "disconnected" | "connected" | "reconnect_required";
  readonly errorCode: string | null;
  readonly payloadSealed: string | null;
  readonly expiresAt: string | null;
  readonly earliestRefreshAt: string | null;
  readonly refreshAttemptId: string | null;
  readonly lastRefreshAttemptId: string | null;
  readonly refreshStartedAt: string | null;
  readonly updatedAt: string;
}

export interface CodexVmOAuthAttempt {
  readonly attemptId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly intent: "connect" | "reconnect" | "replace";
  readonly redirectUri: string;
  readonly stateHash: string;
  readonly pendingSealed: string | null;
  readonly issuedClientId: string | null;
  readonly expectedConnectionId: string;
  readonly expectedEpoch: number;
  readonly actionRevision: number;
  readonly phase:
    | "pending"
    | "exchanging"
    | "completed"
    | "cancelled"
    | "denied"
    | "failed"
    | "expired"
    | "superseded";
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface CodexVmRefreshFence {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly epoch: number;
  readonly tokenRevision: number;
  readonly attemptId: string;
}

export class CodexVmConnectionConflict extends Schema.TaggedError<CodexVmConnectionConflict>()(
  "CodexVmConnectionConflict",
  {
    code: Schema.Literals([
      "not_admin",
      "stale_attempt",
      "invalid_state",
      "identity_mismatch",
      "not_connected",
    ]),
  },
) {}

const connectionColumns = `organization_id AS "organizationId", connection_id AS "connectionId",
  epoch, token_revision AS "tokenRevision", action_revision AS "actionRevision", latest_attempt_id AS "latestAttemptId",
  issuer, subject, client_id AS "clientId", label, status, error_code AS "errorCode", payload_sealed AS "payloadSealed",
  expires_at AS "expiresAt", earliest_refresh_at AS "earliestRefreshAt", refresh_attempt_id AS "refreshAttemptId", last_refresh_attempt_id AS "lastRefreshAttemptId",
  refresh_started_at AS "refreshStartedAt", updated_at AS "updatedAt"`;
const attemptColumns = `attempt_id AS "attemptId", organization_id AS "organizationId", user_id AS "userId",
  intent, redirect_uri AS "redirectUri", state_hash AS "stateHash", pending_sealed AS "pendingSealed",
  issued_client_id AS "issuedClientId", expected_connection_id AS "expectedConnectionId", expected_epoch AS "expectedEpoch",
  action_revision AS "actionRevision", phase, expires_at AS "expiresAt", updated_at AS "updatedAt"`;
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const uuid = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4);
const conflict = (code: CodexVmConnectionConflict["code"]) =>
  new CodexVmConnectionConflict({ code });

/** Durable claims commit before OAuth I/O; a lost refresh reply is never a retry lease. */
export function makeCodexVmConnections(sql: PgClient) {
  const requireAdmin = Effect.fn("codex_vm.require_admin")(function* (
    organizationId: string,
    userId: string,
  ) {
    const rows = yield* sql`SELECT 1 FROM relay_organization_members
      WHERE organization_id=${organizationId} AND user_id=${userId} AND role='admin' FOR SHARE`;
    if (!rows.length) return yield* conflict("not_admin");
  });
  const get = Effect.fn("codex_vm.get")(function* (organizationId: string) {
    const [row] = yield* sql<CodexVmConnection>`SELECT ${sql.literal(connectionColumns)}
      FROM relay_codex_vm_connections WHERE organization_id=${organizationId}`;
    return row ?? null;
  });
  const getLocked = Effect.fn("codex_vm.get_locked")(function* (organizationId: string) {
    const [row] = yield* sql<CodexVmConnection>`SELECT ${sql.literal(connectionColumns)}
      FROM relay_codex_vm_connections WHERE organization_id=${organizationId} FOR UPDATE`;
    return row ?? null;
  });
  const getAttempt = Effect.fn("codex_vm.get_attempt")(function* (attemptId: string) {
    const [row] = yield* sql<CodexVmOAuthAttempt>`SELECT ${sql.literal(attemptColumns)}
      FROM relay_codex_vm_oauth_attempts WHERE attempt_id=${attemptId}`;
    return row ?? null;
  });
  const matches = (connection: CodexVmConnection, attempt: CodexVmOAuthAttempt) =>
    connection.connectionId === attempt.expectedConnectionId &&
    connection.epoch === attempt.expectedEpoch &&
    connection.actionRevision === attempt.actionRevision &&
    connection.latestAttemptId === attempt.attemptId;
  const getHostId = Effect.fn("codex_vm.host_id")(function* () {
    const hostId = yield* uuid;
    yield* sql`INSERT INTO relay_codex_vm_installation(key,host_id) VALUES('installation',${hostId}) ON CONFLICT DO NOTHING`;
    const [row] = yield* sql<{
      hostId: string;
    }>`SELECT host_id AS "hostId" FROM relay_codex_vm_installation WHERE key='installation'`;
    return row!.hostId;
  });
  const beginOAuthAttempt = Effect.fn("codex_vm.begin_oauth")(function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly intent: CodexVmOAuthAttempt["intent"];
    readonly redirectUri: string;
    readonly stateHash: string;
    readonly pendingSealed: string;
    readonly expiresAt: string;
    readonly expected: Pick<CodexVmConnection, "connectionId" | "epoch" | "actionRevision"> | null;
    readonly retryAttemptId?: string;
  }) {
    const timestamp = yield* now,
      attemptId = yield* uuid,
      connectionId = yield* uuid;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireAdmin(input.organizationId, input.userId);
        yield* sql`INSERT INTO relay_codex_vm_connections(organization_id,connection_id,status,updated_at)
        VALUES(${input.organizationId},${connectionId},'disconnected',${timestamp}) ON CONFLICT DO NOTHING`;
        const current = (yield* getLocked(input.organizationId))!;
        if (
          input.expected === null
            ? current.epoch !== 0 || current.actionRevision !== 0
            : current.connectionId !== input.expected.connectionId ||
              current.epoch !== input.expected.epoch ||
              current.actionRevision !== input.expected.actionRevision
        )
          return yield* conflict("stale_attempt");
        const retry = input.retryAttemptId ? yield* getAttempt(input.retryAttemptId) : null;
        if (
          input.retryAttemptId &&
          (!retry ||
            retry.organizationId !== input.organizationId ||
            retry.userId !== input.userId ||
            retry.intent !== input.intent ||
            retry.phase !== "failed" ||
            !retry.issuedClientId ||
            retry.issuedClientId === "dynamic_agent_client" ||
            retry.expectedConnectionId !== current.connectionId ||
            retry.expectedEpoch !== current.epoch ||
            current.actionRevision !== retry.actionRevision + 1 ||
            current.latestAttemptId !== null)
        )
          return yield* conflict("stale_attempt");
        if (input.intent === "connect" && current.subject !== null)
          return yield* conflict("identity_mismatch");
        if (input.intent === "reconnect" && current.clientId === null)
          return yield* conflict("not_connected");
        yield* sql`UPDATE relay_codex_vm_oauth_attempts SET phase='superseded',pending_sealed=NULL,updated_at=${timestamp}
        WHERE organization_id=${input.organizationId} AND phase IN ('pending','exchanging')`;
        const actionRevision = current.actionRevision + 1;
        yield* sql`UPDATE relay_codex_vm_connections SET action_revision=${actionRevision},latest_attempt_id=${attemptId},updated_at=${timestamp}
        WHERE organization_id=${input.organizationId}`;
        yield* sql`INSERT INTO relay_codex_vm_oauth_attempts(attempt_id,organization_id,user_id,intent,redirect_uri,state_hash,pending_sealed,
        issued_client_id,expected_connection_id,expected_epoch,action_revision,phase,expires_at,updated_at)
        VALUES(${attemptId},${input.organizationId},${input.userId},${input.intent},${input.redirectUri},${input.stateHash},${input.pendingSealed},
        ${retry?.issuedClientId ?? (input.intent === "reconnect" ? current.clientId : null)},${current.connectionId},${current.epoch},${actionRevision},'pending',${input.expiresAt},${timestamp})`;
        return (yield* getAttempt(attemptId))!;
      }),
    );
  });

  const claimCallback = Effect.fn("codex_vm.claim_callback")(function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly attemptId: string;
    readonly stateHash: string;
    readonly issuedClientId?: string;
  }) {
    const timestamp = yield* now;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireAdmin(input.organizationId, input.userId);
        const current = yield* getLocked(input.organizationId),
          attempt = yield* getAttempt(input.attemptId);
        if (
          !current ||
          !attempt ||
          attempt.organizationId !== input.organizationId ||
          attempt.userId !== input.userId ||
          !matches(current, attempt) ||
          attempt.phase !== "pending" ||
          attempt.expiresAt <= timestamp
        )
          return yield* conflict("stale_attempt");
        if (attempt.stateHash !== input.stateHash) return yield* conflict("invalid_state");
        const clientId = input.issuedClientId ?? attempt.issuedClientId;
        if (
          !clientId ||
          clientId === "dynamic_agent_client" ||
          (attempt.issuedClientId && clientId !== attempt.issuedClientId)
        )
          return yield* conflict("identity_mismatch");
        yield* sql`UPDATE relay_codex_vm_oauth_attempts SET phase='exchanging',issued_client_id=${clientId},updated_at=${timestamp}
        WHERE attempt_id=${attempt.attemptId}`;
        return {
          ...attempt,
          phase: "exchanging" as const,
          issuedClientId: clientId,
          updatedAt: timestamp,
        };
      }),
    );
  });

  const install = Effect.fn("codex_vm.install")(function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly attemptId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly clientId: string;
    readonly label: string;
    readonly payloadSealed: string;
    readonly expiresAt: string;
    readonly earliestRefreshAt: string | null;
  }) {
    const timestamp = yield* now,
      replacementId = yield* uuid;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireAdmin(input.organizationId, input.userId);
        const current = yield* getLocked(input.organizationId),
          attempt = yield* getAttempt(input.attemptId);
        // Repeating persistence after a lost commit reply must not exchange the code again.
        if (
          current &&
          attempt &&
          attempt.organizationId === input.organizationId &&
          attempt.userId === input.userId &&
          attempt.phase === "completed" &&
          current.epoch === attempt.expectedEpoch + 1 &&
          current.actionRevision === attempt.actionRevision + 1 &&
          current.latestAttemptId === null &&
          current.status === "connected" &&
          current.issuer === input.issuer &&
          current.subject === input.subject &&
          current.clientId === input.clientId &&
          current.payloadSealed === input.payloadSealed &&
          current.expiresAt === input.expiresAt &&
          current.earliestRefreshAt === input.earliestRefreshAt
        )
          return {
            connection: current,
            previous: null,
            retirementUnconfirmed: current.connectionId !== attempt.expectedConnectionId,
          };
        if (
          !current ||
          !attempt ||
          attempt.organizationId !== input.organizationId ||
          attempt.userId !== input.userId ||
          !matches(current, attempt) ||
          attempt.phase !== "exchanging" ||
          attempt.expiresAt <= timestamp
        )
          return null;
        if (
          attempt.issuedClientId !== input.clientId ||
          (current.subject !== null &&
            attempt.intent !== "replace" &&
            (current.subject !== input.subject ||
              current.issuer !== input.issuer ||
              current.clientId !== input.clientId))
        )
          return yield* conflict("identity_mismatch");
        const sameIdentity =
          current.subject === null ||
          (current.subject === input.subject &&
            current.issuer === input.issuer &&
            current.clientId === input.clientId);
        yield* sql`UPDATE relay_codex_vm_connections SET connection_id=${sameIdentity ? current.connectionId : replacementId},
        epoch=epoch+1,token_revision=token_revision+1,action_revision=action_revision+1,latest_attempt_id=NULL,
        issuer=${input.issuer},subject=${input.subject},client_id=${input.clientId},label=${input.label},status='connected',
        error_code=${(!sameIdentity && current.payloadSealed !== null) || current.errorCode === "revocation_unconfirmed" ? "revocation_unconfirmed" : null},
        payload_sealed=${input.payloadSealed},expires_at=${input.expiresAt},earliest_refresh_at=${input.earliestRefreshAt},
        refresh_attempt_id=NULL,last_refresh_attempt_id=NULL,refresh_started_at=NULL,updated_at=${timestamp} WHERE organization_id=${input.organizationId}`;
        yield* sql`UPDATE relay_codex_vm_oauth_attempts SET phase='completed',pending_sealed=NULL,updated_at=${timestamp} WHERE attempt_id=${input.attemptId}`;
        return {
          connection: (yield* get(input.organizationId))!,
          previous: current.payloadSealed ? current : null,
          retirementUnconfirmed: false,
        };
      }),
    );
  });

  const markOAuthFailure = Effect.fn("codex_vm.oauth_failure")(function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly attemptId: string;
    readonly phase?: "failed" | "expired" | "denied";
    readonly stateHash?: string;
  }) {
    const timestamp = yield* now;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireAdmin(input.organizationId, input.userId);
        const current = yield* getLocked(input.organizationId),
          attempt = yield* getAttempt(input.attemptId);
        if (
          !current ||
          !attempt ||
          attempt.organizationId !== input.organizationId ||
          attempt.userId !== input.userId ||
          !matches(current, attempt) ||
          !["pending", "exchanging"].includes(attempt.phase)
        )
          return false;
        if (input.stateHash !== undefined && attempt.stateHash !== input.stateHash)
          return yield* conflict("invalid_state");
        yield* sql`UPDATE relay_codex_vm_oauth_attempts SET phase=${input.phase ?? "failed"},pending_sealed=NULL,updated_at=${timestamp}
        WHERE attempt_id=${input.attemptId}`;
        yield* sql`UPDATE relay_codex_vm_connections SET action_revision=action_revision+1,latest_attempt_id=NULL,updated_at=${timestamp}
        WHERE organization_id=${input.organizationId}`;
        return true;
      }),
    );
  });
  const cancel = Effect.fn("codex_vm.cancel_oauth")(function* (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly attemptId: string;
  }) {
    const timestamp = yield* now;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireAdmin(input.organizationId, input.userId);
        const current = yield* getLocked(input.organizationId),
          attempt = yield* getAttempt(input.attemptId);
        if (
          !current ||
          !attempt ||
          attempt.organizationId !== input.organizationId ||
          attempt.userId !== input.userId ||
          !matches(current, attempt) ||
          !["pending", "exchanging"].includes(attempt.phase)
        )
          return false;
        yield* sql`UPDATE relay_codex_vm_oauth_attempts SET phase='cancelled',pending_sealed=NULL,updated_at=${timestamp} WHERE attempt_id=${input.attemptId}`;
        yield* sql`UPDATE relay_codex_vm_connections SET action_revision=action_revision+1,latest_attempt_id=NULL,updated_at=${timestamp} WHERE organization_id=${input.organizationId}`;
        return true;
      }),
    );
  });
  const disconnect = Effect.fn("codex_vm.disconnect")(function* (input: {
    readonly organizationId: string;
    readonly userId: string;
  }) {
    const timestamp = yield* now;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* requireAdmin(input.organizationId, input.userId);
        const current = yield* getLocked(input.organizationId);
        if (!current) return null;
        yield* sql`UPDATE relay_codex_vm_connections SET epoch=epoch+1,action_revision=action_revision+1,latest_attempt_id=NULL,
        status='disconnected',error_code=${current.payloadSealed || current.errorCode === "revocation_unconfirmed" ? "revocation_unconfirmed" : null},payload_sealed=NULL,expires_at=NULL,earliest_refresh_at=NULL,
        refresh_attempt_id=NULL,last_refresh_attempt_id=NULL,refresh_started_at=NULL,updated_at=${timestamp} WHERE organization_id=${input.organizationId}`;
        yield* sql`UPDATE relay_codex_vm_oauth_attempts SET phase='cancelled',pending_sealed=NULL,updated_at=${timestamp}
        WHERE organization_id=${input.organizationId} AND phase IN ('pending','exchanging')`;
        return { previous: current, epoch: current.epoch + 1 };
      }),
    );
  });
  const markRevocation = Effect.fn("codex_vm.revocation")(function* (input: {
    readonly organizationId: string;
    readonly epoch: number;
    readonly confirmed: boolean;
  }) {
    const timestamp = yield* now;
    const rows =
      yield* sql`UPDATE relay_codex_vm_connections SET error_code=${input.confirmed ? null : "revocation_unconfirmed"},updated_at=${timestamp}
      WHERE organization_id=${input.organizationId} AND epoch=${input.epoch} AND status='disconnected' RETURNING organization_id`;
    return rows.length === 1;
  });
  /** Explicit retirement serializes a bounded revoke with subsequent connection actions. */
  const withConnectionRevocation = Effect.fn("codex_vm.connection_revocation")(function* <E, R>(
    input: Pick<CodexVmConnection, "organizationId" | "connectionId" | "epoch" | "actionRevision">,
    revoke: Effect.Effect<boolean, E, R>,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getLocked(input.organizationId);
        if (
          !current ||
          current.connectionId !== input.connectionId ||
          current.epoch !== input.epoch ||
          current.actionRevision !== input.actionRevision
        )
          return false;
        const confirmed = yield* revoke.pipe(
          Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(false) }),
          Effect.orElseSucceed(() => false),
        );
        yield* sql`UPDATE relay_codex_vm_connections SET
          error_code=CASE WHEN error_code='revocation_unconfirmed' THEN ${confirmed ? null : "revocation_unconfirmed"} ELSE error_code END,
          updated_at=${yield* now}
        WHERE organization_id=${input.organizationId} AND connection_id=${input.connectionId} AND epoch=${input.epoch} AND action_revision=${input.actionRevision}`;
        return confirmed;
      }),
    );
  });

  const claimRefresh = Effect.fn("codex_vm.claim_refresh")(function* (input: {
    readonly organizationId: string;
    readonly connectionId?: string;
    readonly minimumValidityMs?: number;
  }) {
    const timestamp = yield* now,
      attemptId = yield* uuid;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getLocked(input.organizationId);
        if (
          !current ||
          (input.connectionId !== undefined && current.connectionId !== input.connectionId)
        )
          return { kind: "unavailable" as const, connection: current };
        if (current.status !== "connected" || !current.payloadSealed || !current.expiresAt)
          return { kind: "unavailable" as const, connection: current };
        const [timing] = yield* sql<{
          valid: boolean;
          expired: boolean;
          abandoned: boolean;
          tooEarly: boolean;
        }>`SELECT
        ${current.expiresAt}::timestamptz > ${timestamp}::timestamptz + (${input.minimumValidityMs ?? 60000} * interval '1 millisecond') AS valid,
        ${current.expiresAt}::timestamptz <= ${timestamp}::timestamptz AS expired,
        ${current.refreshStartedAt}::timestamptz <= ${timestamp}::timestamptz - interval '6 seconds' AS abandoned,
        ${current.earliestRefreshAt}::timestamptz > ${timestamp}::timestamptz AS "tooEarly"`;
        if (current.refreshAttemptId) {
          if (timing!.abandoned) {
            yield* sql`UPDATE relay_codex_vm_connections SET status='reconnect_required',error_code='refresh_uncertain',updated_at=${timestamp}
            WHERE organization_id=${input.organizationId}`;
            return {
              kind: "unavailable" as const,
              connection: (yield* get(input.organizationId))!,
            };
          }
          return { kind: "pending" as const, retryAfterMs: 100 };
        }
        if (timing!.tooEarly && timing!.expired) {
          yield* sql`UPDATE relay_codex_vm_connections SET status='reconnect_required',error_code='configuration_error',updated_at=${timestamp}
            WHERE organization_id=${input.organizationId}`;
          return { kind: "unavailable" as const, connection: (yield* get(input.organizationId))! };
        }
        if (timing!.valid || timing!.tooEarly)
          return { kind: "ready" as const, connection: current };
        yield* sql`UPDATE relay_codex_vm_connections SET refresh_attempt_id=${attemptId},refresh_started_at=${timestamp},updated_at=${timestamp}
        WHERE organization_id=${input.organizationId}`;
        return {
          kind: "refresh" as const,
          connection: current,
          fence: {
            organizationId: input.organizationId,
            connectionId: current.connectionId,
            epoch: current.epoch,
            tokenRevision: current.tokenRevision,
            attemptId,
          } satisfies CodexVmRefreshFence,
        };
      }),
    );
  });

  const completeRefresh = Effect.fn("codex_vm.complete_refresh")(function* (input: {
    readonly fence: CodexVmRefreshFence;
    readonly payloadSealed: string;
    readonly expiresAt: string;
    readonly earliestRefreshAt: string | null;
  }) {
    const timestamp = yield* now,
      f = input.fence;
    const rows =
      yield* sql`UPDATE relay_codex_vm_connections SET payload_sealed=${input.payloadSealed},expires_at=${input.expiresAt},
      earliest_refresh_at=${input.earliestRefreshAt},token_revision=token_revision+1,status='connected',
      error_code=CASE WHEN error_code='revocation_unconfirmed' THEN error_code ELSE NULL END,
      refresh_attempt_id=NULL,last_refresh_attempt_id=${f.attemptId},refresh_started_at=NULL,updated_at=${timestamp}
      WHERE organization_id=${f.organizationId} AND connection_id=${f.connectionId} AND epoch=${f.epoch}
        AND token_revision=${f.tokenRevision} AND refresh_attempt_id=${f.attemptId}
        AND (status='connected' OR (status='reconnect_required' AND error_code='refresh_uncertain')) RETURNING organization_id`;
    if (rows.length === 1) return true;
    // A committed write may lose its reply. Retry persistence of that exact result, never its grant exchange.
    const committed = yield* sql`SELECT 1 FROM relay_codex_vm_connections
      WHERE organization_id=${f.organizationId} AND connection_id=${f.connectionId} AND epoch=${f.epoch}
        AND token_revision=${f.tokenRevision + 1} AND last_refresh_attempt_id=${f.attemptId}
        AND refresh_attempt_id IS NULL AND status='connected' AND payload_sealed=${input.payloadSealed}
        AND expires_at=${input.expiresAt} AND earliest_refresh_at IS NOT DISTINCT FROM ${input.earliestRefreshAt}`;
    return committed.length === 1;
  });
  const failRefresh = Effect.fn("codex_vm.fail_refresh")(function* (
    fence: CodexVmRefreshFence,
    errorCode: "refresh_uncertain" | "invalid_grant" | "configuration_error",
  ) {
    const timestamp = yield* now;
    const rows =
      yield* sql`UPDATE relay_codex_vm_connections SET status='reconnect_required',error_code=${errorCode},updated_at=${timestamp}
      WHERE organization_id=${fence.organizationId} AND connection_id=${fence.connectionId} AND epoch=${fence.epoch}
        AND token_revision=${fence.tokenRevision} AND refresh_attempt_id=${fence.attemptId}
        AND (status='connected' OR (status='reconnect_required' AND error_code='refresh_uncertain')) RETURNING organization_id`;
    return rows.length === 1;
  });
  /** Only a known preflight failure, before dispatching the grant, may release a claim. */
  const releaseRefreshClaim = Effect.fn("codex_vm.release_refresh")(function* (
    fence: CodexVmRefreshFence,
  ) {
    const timestamp = yield* now;
    const rows = yield* sql`UPDATE relay_codex_vm_connections SET status='connected',
      error_code=CASE WHEN error_code='revocation_unconfirmed' THEN error_code ELSE NULL END,
      refresh_attempt_id=NULL,refresh_started_at=NULL,updated_at=${timestamp}
      WHERE organization_id=${fence.organizationId} AND connection_id=${fence.connectionId} AND epoch=${fence.epoch}
        AND token_revision=${fence.tokenRevision} AND refresh_attempt_id=${fence.attemptId}
        AND (status='connected' OR (status='reconnect_required' AND error_code='refresh_uncertain')) RETURNING organization_id`;
    return rows.length === 1;
  });
  return {
    getHostId,
    get,
    getAttempt,
    beginOAuthAttempt,
    claimCallback,
    install,
    markOAuthFailure,
    cancel,
    disconnect,
    markRevocation,
    withConnectionRevocation,
    claimRefresh,
    completeRefresh,
    failRefresh,
    releaseRefreshClaim,
  };
}
