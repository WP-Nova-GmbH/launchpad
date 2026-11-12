import {
  WorkflowSourceError,
  type BeginWorkflowSource,
  type WorkflowSourceMetadataQuery,
  type WorkflowSourceMetadataPage,
  type WorkflowSourceSelectionQuery,
  type WorkflowSourceSelection,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import * as Store from "./Store.ts";
import * as Linear from "./Linear.ts";
import * as EventFence from "../workflowEvents/Fence.ts";
import type { WorkflowTrigger } from "@t3tools/contracts/workflows";

const decodePending = Schema.decodeUnknownEffect(Schema.fromJsonString(Linear.Pending));
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Linear.Credentials));
const isSourceError = Schema.is(WorkflowSourceError);

const uuid = Crypto.Crypto.pipe(
  Effect.flatMap((c) => c.randomUUIDv4),
  Effect.mapError(() => Store.fail("unavailable", "Could not create an operation identity.")),
);
export const configuredApp = RelayConfiguration.pipe(
  Effect.map((c) => c.linearWorkflow?.clientId.trim() || null),
);
const configuration = Effect.fn("workflowSources.organizationConfiguration")(function* (
  org: string,
) {
  const config = yield* Linear.configuration;
  if (config.organizationId !== org || (yield* Store.configuredFor(org)) !== config.clientId)
    return yield* Store.fail(
      "service_configuration",
      "Linear workflow authorization is unavailable for this organization.",
    );
  return config;
});

// Keep the claim until its worker settles, even when the admin cancels the attempt.
// An abandoned claim can only be replaced by a fresh authorization, never a token refresh.
const exchangeLeaseMs = 30_000;
const finishFailedExchange = Effect.fn("workflowSources.finishFailedExchange")(function* (
  a: Store.Attempt,
  uncertain: boolean,
  error: WorkflowSourceError["code"],
) {
  const sql = (yield* RelayDb).$client;
  if (uncertain && a.connection_id && a.expected_epoch !== null) {
    yield* sql`UPDATE relay_workflow_connections SET status='reconnect_required',authorization_epoch=authorization_epoch+1,
      credential_version=credential_version+1,payload_sealed=NULL,delivery_evidence=NULL,
      health=${Store.json({ code: "reconnect_required", retryAt: null })}::jsonb
      WHERE organization_id=${a.organization_id} AND application_id=${a.application_id} AND connection_id=${a.connection_id}
        AND authorization_epoch=${a.expected_epoch} AND status='connected'`;
  }
  yield* sql`UPDATE relay_workflow_authorizations SET exchange_lease_until=NULL,version=version+1,pending_sealed=NULL,
    status=CASE WHEN status='exchanging' THEN 'failed' ELSE status END,
    error=CASE WHEN status='exchanging' OR (status='cancelled' AND ${uncertain}) THEN ${uncertain ? "reconnect_required" : error} ELSE error END
    WHERE organization_id=${a.organization_id} AND application_id=${a.application_id} AND attempt_id=${a.attempt_id}`;
});

const recoverAbandonedExchange = Effect.fn("workflowSources.recoverAbandonedExchange")(function* (
  org: string,
  app: string,
  user: string,
) {
  const sql = (yield* RelayDb).$client;
  const hint = yield* Store.attempt(org, app);
  if (!hint?.exchange_lease_until || Date.parse(hint.exchange_lease_until) > (yield* Store.now))
    return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* Store.organizationAdmin(org, user);
      const a = yield* Store.attempt(org, app, true);
      if (a?.exchange_lease_until && Date.parse(a.exchange_lease_until) <= (yield* Store.now))
        yield* finishFailedExchange(a, true, "reconnect_required");
    }),
  );
});
export const owner = Effect.fn("workflowSources.owner")(function* (org: string, user: string) {
  const app = yield* Store.configuredFor(org);
  if (app) yield* recoverAbandonedExchange(org, app, user);
  return yield* Store.ownerSnapshot(org, user);
});
export const repository = Store.repositorySnapshot;

const organizationConnection = Effect.fn("workflowSources.organizationConnection")(function* (
  org: string,
  app: string,
  id: string,
  lock = false,
) {
  const c = yield* Store.installed(org, app, lock);
  if (!c || c.connection_id !== id)
    return yield* Store.fail("not_found", "Organization source not found.");
  return c;
});

export const begin = Effect.fn("workflowSources.begin")(function* (
  org: string,
  user: string,
  input: typeof BeginWorkflowSource.Type,
) {
  const config = yield* configuration(org);
  // Resolve a crashed exchange before comparing the caller's version.
  yield* recoverAbandonedExchange(org, config.clientId, user);
  const box = yield* RelaySecretBox;
  const state = (yield* uuid) + (yield* uuid);
  const verifier = (yield* uuid) + (yield* uuid);
  const stateHash = yield* Linear.hash(state);
  const sql = (yield* RelayDb).$client;
  const saved = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* Store.organizationAdmin(org, user);
      yield* sql`INSERT INTO relay_workflow_authorizations (organization_id,application_id) VALUES (${org},${config.clientId}) ON CONFLICT DO NOTHING`;
      const a = yield* Store.attempt(org, config.clientId, true);
      if (!a)
        return yield* Store.fail(
          "service_configuration",
          "The Linear app is bound to another organization.",
        );
      if (a.exchange_lease_until) return yield* Store.exchangeInProgress(a.exchange_lease_until);
      if (a.attempt_id === input.attemptId) {
        if (a.initiating_user_id !== user || a.connection_id !== input.connectionId)
          return yield* Store.fail(
            "conflict",
            "This authorization attempt belongs to another request.",
          );
        return a;
      }
      if (a.version !== input.expectedVersion)
        return yield* Store.fail(
          "conflict",
          "Authorization changed. Refresh before starting again.",
        );
      const c = yield* Store.installed(org, config.clientId, true);
      if ((c?.connection_id ?? null) !== input.connectionId)
        return yield* Store.fail(
          "conflict",
          "Reconnect the organization's existing Linear workspace.",
        );
      const sealed = yield* box.seal(
        Store.json({ state, verifier, reconnect: !!c || a.error === "reconnect_required" }),
      );
      const time = yield* Store.now;
      const [updated] =
        yield* sql<Store.Attempt>`UPDATE relay_workflow_authorizations SET started_at=NULL,version=version+1,
      attempt_id=${input.attemptId},initiating_user_id=${user},connection_id=${input.connectionId},expected_epoch=${c?.authorization_epoch ?? null},
      state_hash=${stateHash},pending_sealed=${sealed},expires_at=${Store.iso(time + 600_000)},status='pending',error=NULL
      WHERE organization_id=${org} AND application_id=${config.clientId} RETURNING *`;
      return updated!;
    }),
  );
  const authorization =
    saved.status === "pending" &&
    saved.attempt_id &&
    saved.pending_sealed &&
    Date.parse(saved.expires_at!) > (yield* Store.now)
      ? {
          applicationId: saved.application_id,
          attemptId: saved.attempt_id,
          url: yield* box
            .open(saved.pending_sealed)
            .pipe(Effect.flatMap(decodePending), Effect.flatMap(Linear.authorizationUrl)),
        }
      : null;
  return { authorization, owner: yield* Store.ownerSnapshot(org, user) };
});
export const cancel = Effect.fn("workflowSources.cancel")(function* (
  org: string,
  user: string,
  id: string,
) {
  const config = yield* configuration(org);
  const sql = (yield* RelayDb).$client;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* Store.organizationAdmin(org, user);
      yield* sql`UPDATE relay_workflow_authorizations SET version=version+1,status='cancelled',state_hash=NULL,pending_sealed=NULL,error=NULL
      WHERE organization_id=${org} AND application_id=${config.clientId} AND attempt_id=${id} AND status IN ('pending','exchanging')`;
    }),
  );
  return yield* owner(org, user);
});
export const disconnect = Effect.fn("workflowSources.disconnect")(function* (
  org: string,
  user: string,
  id: string,
  epoch: number,
) {
  const sql = (yield* RelayDb).$client;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* Store.organizationAdmin(org, user);
      const hint = yield* Store.connection(id);
      if (!hint || hint.organization_id !== org)
        return yield* Store.fail("not_found", "Organization source not found.");
      yield* Store.attempt(org, hint.application_id, true);
      const current = yield* organizationConnection(org, hint.application_id, id, true);
      if (current.status === "disconnected") return;
      if (current.authorization_epoch !== epoch)
        return yield* Store.fail(
          "conflict",
          "The connection changed. Refresh before disconnecting.",
        );
      yield* sql`UPDATE relay_workflow_authorizations SET version=version+1,status='cancelled',state_hash=NULL,pending_sealed=NULL,error=NULL
      WHERE organization_id=${org} AND application_id=${hint.application_id} AND status IN ('pending','exchanging')`;
      yield* sql`UPDATE relay_workflow_connections SET status='disconnected',authorization_epoch=authorization_epoch+1,credential_version=credential_version+1,
      payload_sealed=NULL,delivery_evidence=NULL,health=${Store.json(Store.healthy)}::jsonb WHERE connection_id=${id}`;
    }),
  );
  return yield* owner(org, user);
});
export const callback = Effect.fn("workflowSources.callback")(function* (
  state: string,
  code: string | null,
  denied = false,
) {
  if (!state || state.length > 256 || (code && code.length > 16_384))
    return yield* Store.fail("invalid_input", "Invalid authorization callback.");
  const sql = (yield* RelayDb).$client;
  const config = yield* Linear.configuration;
  const org = config.organizationId;
  const app = config.clientId;
  const digest = yield* Linear.hash(state);
  const [hint] =
    yield* sql<Store.Attempt>`SELECT * FROM relay_workflow_authorizations WHERE organization_id=${org} AND application_id=${app} AND state_hash=${digest}`;
  if (!hint?.attempt_id || !hint.initiating_user_id)
    return yield* Store.fail(
      "conflict",
      "This authorization expired or has already been handled. Refresh Organization settings.",
    );
  const initiator = hint.initiating_user_id;
  const attemptId = hint.attempt_id;
  const claimed = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* Store.organizationAdmin(org, initiator);
      yield* configuration(org);
      const a = yield* Store.attempt(org, app, true);
      const now = yield* Store.now;
      if (
        !a ||
        a.attempt_id !== attemptId ||
        a.initiating_user_id !== initiator ||
        a.status !== "pending" ||
        a.state_hash !== digest ||
        !a.pending_sealed ||
        !a.expires_at ||
        Date.parse(a.expires_at) <= now
      )
        return yield* Store.fail(
          "conflict",
          "This authorization expired or has already been handled. Refresh Organization settings.",
        );
      if (a.exchange_lease_until) return yield* Store.exchangeInProgress(a.exchange_lease_until);
      const c = yield* Store.installed(org, app, true);
      if (
        (c?.connection_id ?? null) !== a.connection_id ||
        (c?.authorization_epoch ?? null) !== a.expected_epoch
      )
        return yield* Store.fail("conflict", "The source changed during authorization.");
      if (!denied && code && c?.lease_until && Date.parse(c.lease_until) > now)
        return yield* Store.fail(
          "refresh_in_progress",
          "Linear credentials are refreshing. Reload this callback shortly.",
          Date.parse(c.lease_until),
        );
      // Revocations older than this exchange belong to the previous authorization.
      const exchangeStartedAt = yield* EventFence.timestamp;
      const [claimed] =
        yield* sql<Store.Attempt>`UPDATE relay_workflow_authorizations SET status='exchanging',version=version+1,
      state_hash=NULL,started_at=${exchangeStartedAt},exchange_lease_until=${Store.iso(now + exchangeLeaseMs)}
      WHERE organization_id=${org} AND application_id=${app} RETURNING *`;
      return { attempt: claimed!, connection: c };
    }),
  );

  let mayHaveRotated = false;
  let committed = false;
  let errorCode: WorkflowSourceError["code"] = "unavailable";
  return yield* Effect.gen(function* () {
    if (denied || !code)
      return yield* Store.fail("invalid_input", "Linear authorization was cancelled.");
    const box = yield* RelaySecretBox;
    const pending = yield* box
      .open(claimed.attempt.pending_sealed!)
      .pipe(Effect.flatMap(decodePending));
    mayHaveRotated = true;
    let grantIssued = false;
    const tokens = yield* Linear.exchange({ code, verifier: pending.verifier }, () => {
      grantIssued = true;
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          // These explicit rejections occur before the provider issues credentials.
          if (
            !grantIssued &&
            ["service_configuration", "rate_limited", "forbidden", "invalid_input"].includes(
              error.code,
            )
          )
            mayHaveRotated = false;
        }),
      ),
    );
    const identity = yield* Linear.identity(tokens.accessToken);
    if (claimed.connection && claimed.connection.workspace_id !== identity.organization.id) {
      mayHaveRotated = false;
      return yield* Store.fail(
        "workspace_mismatch",
        "Reconnect must use the organization's existing Linear workspace.",
      );
    }
    if (identity.viewer.app !== true)
      return yield* Store.fail(
        "invalid_input",
        "Linear did not authorize the app. Start the workspace installation again.",
      );
    const sealed = yield* box.seal(Store.json(tokens));
    const id = claimed.connection?.connection_id ?? (yield* uuid);
    const connectionId = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* EventFence.lock(app, identity.organization.id);
        yield* Store.organizationAdmin(org, initiator);
        yield* configuration(org);
        const cutoff = yield* EventFence.revocationCutoff(app, identity.organization.id);
        const current = yield* Store.attempt(org, app, true);
        const now = yield* Store.now;
        if (
          !current ||
          current.attempt_id !== attemptId ||
          current.initiating_user_id !== initiator ||
          current.status !== "exchanging" ||
          current.exchange_lease_until !== claimed.attempt.exchange_lease_until ||
          !current.exchange_lease_until ||
          !current.started_at ||
          Date.parse(current.exchange_lease_until) <= now ||
          !current.expires_at ||
          Date.parse(current.expires_at) <= now
        )
          return yield* Store.fail("conflict", "Authorization changed. Start connecting again.");
        if (cutoff && Date.parse(current.started_at) <= Date.parse(cutoff))
          return yield* Store.fail(
            "conflict",
            "Linear was revoked during this authorization. Start connecting again.",
          );
        const target = yield* Store.installed(org, app, true);
        if (
          (target?.connection_id ?? null) !== current.connection_id ||
          (target?.authorization_epoch ?? null) !== current.expected_epoch
        )
          return yield* Store.fail("conflict", "The source changed during authorization.");
        const stamp = yield* EventFence.timestamp;
        if (target) {
          yield* sql`UPDATE relay_workflow_connections SET delivery_evidence=NULL,authorization_started_at=${current.started_at},payload_sealed=${sealed},status='connected',
          workspace_name=${identity.organization.name},viewer_name=${identity.viewer.name},authorization_epoch=authorization_epoch+1,credential_version=credential_version+1,
          activated_at=${stamp},health=${Store.json(Store.healthy)}::jsonb,lease_id=NULL,lease_until=NULL,refresh_started_at=NULL WHERE connection_id=${id}`;
        } else {
          yield* sql`INSERT INTO relay_workflow_connections (authorization_started_at,connection_id,organization_id,application_id,workspace_id,workspace_name,viewer_name,status,activated_at,payload_sealed,health)
          VALUES (${current.started_at},${id},${org},${app},${identity.organization.id},${identity.organization.name},${identity.viewer.name},'connected',${stamp},${sealed},${Store.json(Store.healthy)}::jsonb)`;
        }
        yield* sql`UPDATE relay_workflow_authorizations SET status='connected',version=version+1,connection_id=${id},exchange_lease_until=NULL,pending_sealed=NULL,error=NULL
        WHERE organization_id=${org} AND application_id=${app}`;
        return id;
      }),
    );
    committed = true;
    return connectionId;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () =>
        Effect.fail(Store.fail("unavailable", "Authorization was interrupted. Reconnect Linear.")),
    }),
    Effect.tapError((error) =>
      Effect.sync(() => {
        errorCode = isSourceError(error) ? error.code : "unavailable";
      }),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        if (committed) return;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const current = yield* Store.attempt(org, app, true);
              if (
                current?.attempt_id === attemptId &&
                current.exchange_lease_until === claimed.attempt.exchange_lease_until
              )
                yield* finishFailedExchange(current, mayHaveRotated, errorCode);
            }),
          )
          .pipe(Effect.ignore);
      }),
    ),
  );
});

const recordFailure = Effect.fn("workflowSources.recordFailure")(function* (
  c: Store.Connection,
  error: WorkflowSourceError,
  leaseId: string | null = null,
) {
  const sql = (yield* RelayDb).$client;
  // A read's expired access token is not proof that a faulted refresh grant was lost.
  const lost = sql`${error.code === "reconnect_required"} AND (${leaseId}::text IS NOT NULL OR health->>'code'<>'service_configuration')`;
  const confirmedLoss = error.code === "reconnect_required" && leaseId !== null;
  const retryAt =
    error.retryAt ?? (error.code === "unavailable" ? (yield* Store.now) + 5000 : null);
  const code =
    error.code === "reconnect_required"
      ? "reconnect_required"
      : error.code === "service_configuration"
        ? "service_configuration"
        : error.code === "rate_limited"
          ? "rate_limited"
          : "unavailable";
  yield* sql`UPDATE relay_workflow_connections SET
    status=CASE WHEN ${lost} THEN 'reconnect_required' ELSE status END,
    authorization_epoch=authorization_epoch+CASE WHEN ${lost} THEN 1 ELSE 0 END,
    health=jsonb_build_object(
    'code',CASE WHEN health->>'code'='service_configuration' AND NOT ${confirmedLoss} THEN 'service_configuration' ELSE ${code}::text END,
    'retryAt',GREATEST((health->>'retryAt')::double precision,${retryAt}::double precision)
  ),
    lease_id=CASE WHEN ${leaseId}::text IS NOT NULL THEN NULL ELSE lease_id END,
    lease_until=CASE WHEN ${leaseId}::text IS NOT NULL THEN NULL ELSE lease_until END,
    refresh_started_at=CASE WHEN ${leaseId}::text IS NOT NULL AND ${c.refresh_started_at}::text IS NULL AND ${error.code !== "unavailable"} THEN NULL ELSE refresh_started_at END
    WHERE connection_id=${c.connection_id} AND status='connected'
      AND authorization_epoch=${c.authorization_epoch} AND credential_version=${c.credential_version}
      AND NOT EXISTS (SELECT 1 FROM relay_workflow_authorizations a WHERE a.organization_id=${c.organization_id}
        AND a.application_id=${c.application_id} AND a.exchange_lease_until IS NOT NULL)
      AND (${leaseId}::text IS NULL OR lease_id=${leaseId})`;
});
export const credentials = Effect.fn("workflowSources.credentials")(function* (
  input: Store.Connection,
  force = false,
) {
  const config = yield* configuration(input.organization_id);
  if (input.application_id !== config.clientId)
    return yield* Store.fail(
      "service_configuration",
      "This source belongs to a different Linear application.",
    );
  const sql = (yield* RelayDb).$client;
  const c = yield* sql.withTransaction(
    Effect.gen(function* () {
      const a = yield* Store.attempt(input.organization_id, config.clientId);
      if (a?.exchange_lease_until) return yield* Store.exchangeInProgress(a.exchange_lease_until);
      const current = yield* organizationConnection(
        input.organization_id,
        config.clientId,
        input.connection_id,
      );
      if (current.authorization_epoch !== input.authorization_epoch)
        return yield* Store.fail(
          "conflict",
          "The Linear authorization changed. Refresh its status.",
        );
      if (!a || current.status !== "connected" || !current.payload_sealed)
        return yield* Store.fail(
          "reconnect_required",
          "An organization admin must reconnect Linear.",
        );
      return { ...current, payload_sealed: current.payload_sealed };
    }),
  );
  const time = yield* Store.now;
  if (c.health.retryAt && c.health.retryAt > time)
    return yield* Store.fail(
      c.health.code === "rate_limited" ? "rate_limited" : "unavailable",
      "Linear is waiting before retrying.",
      c.health.retryAt,
    );
  const box = yield* RelaySecretBox;
  const payload = yield* box.open(c.payload_sealed).pipe(Effect.flatMap(decodeCredentials));
  if (!force && c.health.code !== "service_configuration" && payload.expiresAt > time + 60_000)
    return { credentials: payload, connection: c };
  const lease = yield* uuid;
  // Capture pre-lease recovery state atomically; the caller may hold an older snapshot.
  const claimed = yield* sql.withTransaction(
    Effect.gen(function* () {
      const a = yield* Store.attempt(c.organization_id, c.application_id);
      if (a?.exchange_lease_until) return yield* Store.exchangeInProgress(a.exchange_lease_until);
      const [row] = yield* sql<Store.Connection & { prior_refresh_started_at: string | null }>`
    WITH previous AS (
      SELECT connection_id,refresh_started_at FROM relay_workflow_connections
      WHERE connection_id=${c.connection_id} AND status='connected'
        AND authorization_epoch=${c.authorization_epoch} AND credential_version=${c.credential_version}
        AND (lease_id IS NULL OR lease_until<=${Store.iso(time)})
        AND ((health->>'retryAt')::double precision IS NULL OR (health->>'retryAt')::double precision<=${time})
      FOR UPDATE
    )
    UPDATE relay_workflow_connections c SET lease_id=${lease},lease_until=${Store.iso(time + 30_000)},
      refresh_started_at=COALESCE(previous.refresh_started_at,${Store.iso(time)})
    FROM previous WHERE c.connection_id=previous.connection_id
    RETURNING c.*,previous.refresh_started_at AS prior_refresh_started_at`;
      return row;
    }),
  );
  if (!claimed)
    return yield* Store.fail(
      "refresh_in_progress",
      "Linear credentials are refreshing. Retry shortly.",
      time + 1000,
    );
  return yield* Effect.gen(function* () {
    if (
      claimed.prior_refresh_started_at &&
      time - Date.parse(claimed.prior_refresh_started_at) > 30 * 60_000
    )
      return yield* Store.fail(
        "reconnect_required",
        "Credential recovery expired. An organization admin must reconnect Linear.",
      );
    const tokens = yield* Linear.exchange({ refreshToken: payload.refreshToken });
    const sealed = yield* box.seal(Store.json(tokens));
    const [saved] =
      yield* sql<Store.Connection>`UPDATE relay_workflow_connections SET payload_sealed=${sealed},credential_version=credential_version+1,health=CASE
      WHEN (health->>'retryAt')::double precision>${yield* Store.now} THEN
        jsonb_set(health,'{code}',CASE WHEN health->>'code'='service_configuration' THEN '"unavailable"'::jsonb ELSE health->'code' END)
      ELSE ${Store.json(Store.healthy)}::jsonb END,lease_id=NULL,lease_until=NULL,refresh_started_at=NULL WHERE connection_id=${c.connection_id} AND status='connected' AND authorization_epoch=${c.authorization_epoch} AND credential_version=${c.credential_version} AND lease_id=${lease} RETURNING *`;
    if (!saved)
      return yield* Store.fail(
        "conflict",
        "The source changed while refreshing. Refresh its status.",
      );
    return { credentials: tokens, connection: saved };
  }).pipe(
    Effect.tapError((error) =>
      isSourceError(error)
        ? recordFailure(
            { ...claimed, refresh_started_at: claimed.prior_refresh_started_at },
            error,
            lease,
          ).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
});
export const read = Effect.fn("workflowSources.read")(function* <A, R>(
  c: Store.Connection,
  use: (token: string, connection: Store.Connection) => Effect.Effect<A, WorkflowSourceError, R>,
) {
  let current = yield* credentials(c);
  const result = yield* use(current.credentials.accessToken, current.connection).pipe(
    Effect.catchTag("WorkflowSourceError", (error) => {
      if (error.code !== "reconnect_required") return Effect.fail(error);
      return Effect.gen(function* () {
        current = yield* credentials(current.connection, true);
        return yield* use(current.credentials.accessToken, current.connection);
      });
    }),
    Effect.tapError((error) =>
      isSourceError(error) && error.code !== "forbidden" && error.code !== "invalid_input"
        ? recordFailure(current.connection, error).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
  return result;
});
export const refresh = Effect.fn("workflowSources.refresh")(function* (c: Store.Connection) {
  const identity = yield* read(c, Linear.identity);
  if (identity.organization.id !== c.workspace_id)
    return yield* Store.fail(
      "workspace_mismatch",
      "The Linear workspace changed. Connect it as a new source.",
    );
  const sql = (yield* RelayDb).$client;
  yield* sql`UPDATE relay_workflow_connections SET workspace_name=${identity.organization.name},viewer_name=${identity.viewer.name},health=${Store.json(Store.healthy)}::jsonb WHERE connection_id=${c.connection_id} AND status='connected' AND authorization_epoch=${c.authorization_epoch} AND health->>'code'<>'service_configuration' AND ((health->>'retryAt')::double precision IS NULL OR (health->>'retryAt')::double precision<=${yield* Store.now})`;
});
export const refreshOwner = Effect.fn("workflowSources.refreshOwner")(function* (
  org: string,
  user: string,
  id: string,
) {
  const config = yield* configuration(org);
  const sql = (yield* RelayDb).$client;
  const c = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* Store.organizationAdmin(org, user);
      return yield* organizationConnection(org, config.clientId, id);
    }),
  );
  yield* refresh(c);
  return yield* owner(org, user);
});

const Cursor = Schema.Struct({
  v: Schema.Literal(1),
  repo: Schema.String,
  grant: Schema.String,
  connection: Schema.String,
  epoch: Schema.Int,
  kind: Schema.String,
  team: Schema.NullOr(Schema.String),
  after: Schema.String.check(Schema.isMaxLength(2048)),
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
export const metadata = Effect.fn("workflowSources.metadata")(function* (
  repo: string,
  user: string,
  input: WorkflowSourceMetadataQuery,
) {
  const sql = (yield* RelayDb).$client;
  const bound = yield* sql.withTransaction(Store.authority(repo, input.grantId, user));
  let after: string | null = null;
  if (input.cursor) {
    const decoded = yield* Effect.try({
      try: () => atob(input.cursor!),
      catch: () => Store.fail("invalid_input", "Invalid metadata cursor."),
    });
    const cursor = yield* decodeCursor(decoded).pipe(
      Effect.mapError(() => Store.fail("invalid_input", "Invalid metadata cursor.")),
    );
    if (
      cursor.repo !== repo ||
      cursor.grant !== input.grantId ||
      cursor.connection !== bound.connection.connection_id ||
      cursor.epoch !== bound.connection.authorization_epoch ||
      cursor.kind !== input.kind ||
      cursor.team !== (input.teamId ?? null)
    )
      return yield* Store.fail(
        "invalid_input",
        "Metadata cursor belongs to another source or selection.",
      );
    after = cursor.after;
  }
  const result = yield* read(bound.connection, (token) =>
    Linear.metadata(
      token,
      bound.connection.workspace_id,
      input.kind,
      input.teamId,
      after,
      input.limit ?? 50,
    ),
  );
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* Store.authority(repo, input.grantId, user);
      if (current.connection.authorization_epoch !== bound.connection.authorization_epoch)
        return yield* Store.fail("conflict", "The source changed while loading metadata.");
    }),
  );
  return {
    items: result.items,
    nextCursor: result.after
      ? btoa(
          Store.json({
            v: 1,
            repo,
            grant: input.grantId,
            connection: bound.connection.connection_id,
            epoch: bound.connection.authorization_epoch,
            kind: input.kind,
            team: input.teamId ?? null,
            after: result.after,
          }),
        )
      : null,
  } satisfies WorkflowSourceMetadataPage;
});

const SelectionNode = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
});
const decodeSelection = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      organization: Schema.Struct({ id: Schema.String }),
      team: Schema.NullOr(SelectionNode),
      state: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ ...SelectionNode.fields, team: Schema.Struct({ id: Schema.String }) }),
        ),
      ),
      labels: Schema.optional(
        Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              ...SelectionNode.fields,
              isGroup: Schema.Boolean,
              team: Schema.NullOr(Schema.Struct({ id: Schema.String })),
            }),
          ),
          pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
        }),
      ),
    }),
  }),
);
/** The same bounded selection read serves the inspector and enable validation. */
const readSelection = Effect.fn("workflowSources.readSelection")(function* (
  connection: Store.Connection,
  input: WorkflowSourceSelectionQuery,
) {
  const state = !!input.stateId;
  const labels = input.labelIds.length > 0;
  const result = yield* read(connection, (token) =>
    Linear.graphql(
      token,
      `query WorkflowTriggerSelection($team:String!${labels ? ",$labels:[ID!]!" : ""}${state ? ",$state:String!" : ""}) {organization{id} team(id:$team){id name archivedAt} ${state ? "state:workflowState(id:$state){id name archivedAt team{id}}" : ""} ${labels ? "labels:issueLabels(first:100,filter:{id:{in:$labels}}){nodes{id name archivedAt isGroup team{id}} pageInfo{hasNextPage}}" : ""}}`,
      {
        team: input.teamId,
        ...(labels ? { labels: input.labelIds } : {}),
        ...(state ? { state: input.stateId } : {}),
      },
      decodeSelection,
    ),
  );
  if (result.organization.id !== connection.workspace_id)
    return yield* Store.fail("workspace_mismatch", "Linear returned a different workspace.");
  const team = result.team?.id === input.teamId && !result.team.archivedAt ? result.team : null;
  const selectedState =
    result.state?.id === input.stateId &&
    result.state?.team.id === input.teamId &&
    !result.state.archivedAt
      ? result.state
      : null;
  const selectedLabels = (
    result.labels?.pageInfo.hasNextPage ? [] : (result.labels?.nodes ?? [])
  ).filter(
    (label) =>
      input.labelIds.includes(label.id) &&
      !label.archivedAt &&
      !label.isGroup &&
      (!label.team || label.team.id === input.teamId),
  );
  const issues: WorkflowSourceSelection["issues"][number][] = [];
  if (!team) issues.push({ field: "team", message: "The selected Linear team is unavailable." });
  if (state && !selectedState)
    issues.push({ field: "state", message: "The selected status is unavailable in this team." });
  if (input.labelIds.some((id) => !selectedLabels.some((label) => label.id === id)))
    issues.push({ field: "labels", message: "Some selected labels are unavailable in this team." });
  const config = yield* EventFence.configuration;
  return {
    authorizationEpoch: connection.authorization_epoch,
    team: team ? { id: team.id, name: team.name ?? team.id } : null,
    state: selectedState
      ? { id: selectedState.id, name: selectedState.name ?? selectedState.id }
      : null,
    labels: selectedLabels.map((label) => ({
      id: label.id,
      name: label.name ?? label.id,
      teamId: label.team?.id ?? null,
    })),
    issues,
    deliveryReady:
      !!config?.admissionEnabled &&
      config.applicationId === connection.application_id &&
      EventFence.covers(connection, config.generation, input.teamId),
  } satisfies WorkflowSourceSelection;
});
export const selection = Effect.fn("workflowSources.selection")(function* (
  repo: string,
  user: string,
  input: WorkflowSourceSelectionQuery,
) {
  const sql = (yield* RelayDb).$client;
  const bound = yield* sql.withTransaction(Store.authority(repo, input.grantId, user));
  const result = yield* readSelection(bound.connection, input);
  const current = yield* sql.withTransaction(Store.authority(repo, input.grantId, user));
  if (current.connection.authorization_epoch !== bound.connection.authorization_epoch)
    return yield* Store.fail("conflict", "The source changed while loading selections.");
  const config = yield* EventFence.configuration;
  return {
    ...result,
    deliveryReady:
      !!config?.admissionEnabled &&
      config.applicationId === current.connection.application_id &&
      EventFence.covers(current.connection, config.generation, input.teamId),
  };
});
export const validateTrigger = Effect.fn("workflowSources.validateTrigger")(function* (
  connection: Store.Connection,
  trigger: WorkflowTrigger,
) {
  const result = yield* readSelection(connection, {
    grantId: trigger.grantId,
    teamId: trigger.teamId,
    labelIds: trigger.labelIds,
    ...(trigger.event === "entered_status" ? { stateId: trigger.stateId } : {}),
  });
  if (result.issues.length)
    return yield* Store.fail(
      "invalid_input",
      "The selected Linear team, state or labels are unavailable.",
    );
});
