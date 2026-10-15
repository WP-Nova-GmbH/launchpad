import {
  WorkflowSourceError,
  type BeginWorkflowSource,
  type WorkflowSourceMetadataQuery,
  type WorkflowSourceMetadataPage,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import * as Store from "./Store.ts";
import { UserDirectory } from "../tenancy/UserDirectory.ts";
import * as Linear from "./Linear.ts";

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
export const owner = Effect.fn("workflowSources.owner")(function* (user: string) {
  return yield* Store.ownerSnapshot(user, yield* configuredApp);
});
export const repository = Effect.fn("workflowSources.repository")(function* (
  repo: string,
  user: string,
) {
  const app = yield* configuredApp;
  const snapshot = yield* Store.repositorySnapshot(repo, user, app);
  const directory = yield* UserDirectory;
  const profiles = yield* directory
    .lookup({ userIds: snapshot.sources.map((s) => s.source.ownerUserId) })
    .pipe(Effect.timeoutOption("2 seconds"));
  const current = yield* Store.repositorySnapshot(repo, user, app);
  return {
    ...current,
    sources: current.sources.map((entry) => ({
      ...entry,
      source: {
        ...entry.source,
        ownerLabel:
          profiles._tag === "Some"
            ? (profiles.value.get(entry.source.ownerUserId)?.displayName ??
              entry.source.ownerUserId)
            : entry.source.ownerUserId,
      },
    })),
  };
});
const owned = Effect.fn("workflowSources.owned")(function* (id: string, user: string) {
  const c = yield* Store.connection(id);
  if (!c || c.owner_user_id !== user)
    return yield* Store.fail("not_found", "Owned source not found.");
  return c;
});
export const begin = Effect.fn("workflowSources.begin")(function* (
  user: string,
  input: typeof BeginWorkflowSource.Type,
) {
  const config = yield* Linear.configuration;
  const box = yield* RelaySecretBox;
  const pending = { state: (yield* uuid) + (yield* uuid), verifier: (yield* uuid) + (yield* uuid) };
  const sealed = yield* box.seal(Store.json(pending));
  const stateHash = yield* Linear.hash(pending.state);
  const time = yield* Store.now;
  const sql = (yield* RelayDb).$client;
  const saved = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO relay_workflow_authorizations (owner_user_id,application_id) VALUES (${user},${config.clientId}) ON CONFLICT DO NOTHING`;
      const a = (yield* Store.attempt(user, config.clientId, true))!;
      if (a.attempt_id === input.attemptId) return a;
      if (a.version !== input.expectedVersion)
        return yield* Store.fail(
          "conflict",
          "Authorization changed. Refresh before starting again.",
        );
      const c = input.connectionId ? yield* owned(input.connectionId, user) : null;
      if (c && c.application_id !== config.clientId)
        return yield* Store.fail(
          "service_configuration",
          "This connection belongs to a different Linear application.",
        );
      const [updated] =
        yield* sql<Store.Attempt>`UPDATE relay_workflow_authorizations SET version=version+1,attempt_id=${input.attemptId},connection_id=${input.connectionId},expected_epoch=${c?.authorization_epoch ?? null},state_hash=${stateHash},pending_sealed=${sealed},expires_at=${Store.iso(time + 600_000)},status='pending',error=NULL WHERE owner_user_id=${user} AND application_id=${config.clientId} RETURNING *`;
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
  // The snapshot may already contain a newer attempt; it never identifies this link.
  return { authorization, owner: yield* owner(user) };
});
export const cancel = Effect.fn("workflowSources.cancel")(function* (user: string, id: string) {
  const sql = (yield* RelayDb).$client;
  yield* sql`UPDATE relay_workflow_authorizations SET version=version+1,status='cancelled',state_hash=NULL,pending_sealed=NULL,error=NULL WHERE owner_user_id=${user} AND attempt_id=${id} AND status IN ('pending','exchanging')`;
  return yield* owner(user);
});
export const disconnect = Effect.fn("workflowSources.disconnect")(function* (
  user: string,
  id: string,
  epoch: number,
) {
  const c = yield* owned(id, user);
  const sql = (yield* RelayDb).$client;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // OAuth finalization uses this same attempt -> connection order.
      yield* Store.attempt(user, c.application_id, true);
      const [current] =
        yield* sql<Store.Connection>`SELECT * FROM relay_workflow_connections WHERE connection_id=${id} AND owner_user_id=${user} FOR UPDATE`;
      if (current?.status === "disconnected") return;
      if (!current || current.authorization_epoch !== epoch)
        return yield* Store.fail(
          "conflict",
          "The connection changed. Refresh before disconnecting.",
        );
      yield* sql`UPDATE relay_workflow_authorizations SET version=version+1,status='cancelled',state_hash=NULL,pending_sealed=NULL,error=NULL WHERE owner_user_id=${user} AND application_id=${c.application_id} AND (connection_id=${id} OR connection_id IS NULL) AND status IN ('pending','exchanging')`;
      yield* sql`UPDATE relay_workflow_connections SET status='disconnected',authorization_epoch=authorization_epoch+1,credential_version=credential_version+1,payload_sealed=NULL,lease_id=NULL,lease_until=NULL,refresh_started_at=NULL,health=${Store.json(Store.healthy)}::jsonb WHERE connection_id=${id}`;
    }),
  );
  return yield* owner(user);
});
export const callback = Effect.fn("workflowSources.callback")(function* (
  state: string,
  code: string | null,
  denied = false,
) {
  if (!state || state.length > 256 || (code && code.length > 16_384))
    return yield* Store.fail("invalid_input", "Invalid authorization callback.");
  const sql = (yield* RelayDb).$client;
  const time = yield* Store.now;
  const digest = yield* Linear.hash(state);
  const [claimed] =
    yield* sql<Store.Attempt>`UPDATE relay_workflow_authorizations SET status='exchanging',version=version+1,state_hash=NULL WHERE state_hash=${digest} AND status='pending' AND expires_at>${Store.iso(time)} RETURNING *`;
  if (!claimed?.attempt_id || !claimed.pending_sealed)
    return yield* Store.fail(
      "conflict",
      "This authorization expired or has already been handled. Refresh Connections.",
    );
  const attemptId = claimed.attempt_id;
  const complete = Effect.gen(function* () {
    if (denied || !code)
      return yield* Store.fail("invalid_input", "Linear authorization was cancelled.");
    const config = yield* Linear.configuration;
    if (config.clientId !== claimed.application_id)
      return yield* Store.fail(
        "service_configuration",
        "Linear application configuration changed.",
      );
    const box = yield* RelaySecretBox;
    const pending = yield* box.open(claimed.pending_sealed!).pipe(Effect.flatMap(decodePending));
    const tokens = yield* Linear.exchange({ code, verifier: pending.verifier });
    const identity = yield* Linear.identity(tokens.accessToken);
    const sealed = yield* box.seal(Store.json(tokens));
    const id = yield* uuid;
    const stamp = Store.iso(yield* Store.now);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* Store.attempt(claimed.owner_user_id, claimed.application_id, true);
        if (
          current?.attempt_id !== attemptId ||
          current.status !== "exchanging" ||
          Date.parse(current.expires_at!) <= (yield* Store.now)
        )
          return yield* Store.fail("conflict", "Authorization changed. Start connecting again.");
        const [target] = claimed.connection_id
          ? yield* sql<Store.Connection>`SELECT * FROM relay_workflow_connections WHERE connection_id=${claimed.connection_id} AND owner_user_id=${claimed.owner_user_id} FOR UPDATE`
          : yield* sql<Store.Connection>`SELECT * FROM relay_workflow_connections WHERE owner_user_id=${claimed.owner_user_id} AND application_id=${claimed.application_id} AND workspace_id=${identity.organization.id} FOR UPDATE`;
        if (
          claimed.connection_id &&
          (!target || target.authorization_epoch !== claimed.expected_epoch)
        )
          return yield* Store.fail("conflict", "The source changed during authorization.");
        if (target && target.workspace_id !== identity.organization.id)
          return yield* Store.fail(
            "workspace_mismatch",
            "Reconnect must use the same Linear workspace. Use Connect for a different workspace.",
          );
        const connectionId = target?.connection_id ?? id;
        if (target)
          yield* sql`UPDATE relay_workflow_connections SET payload_sealed=${sealed},status='connected',workspace_name=${identity.organization.name},viewer_name=${identity.viewer.name},authorization_epoch=authorization_epoch+1,credential_version=credential_version+1,activated_at=${stamp},health=${Store.json(Store.healthy)}::jsonb,lease_id=NULL,lease_until=NULL,refresh_started_at=NULL WHERE connection_id=${connectionId}`;
        else
          yield* sql`INSERT INTO relay_workflow_connections (connection_id,owner_user_id,application_id,workspace_id,workspace_name,viewer_name,status,activated_at,payload_sealed,health) VALUES (${id},${claimed.owner_user_id},${claimed.application_id},${identity.organization.id},${identity.organization.name},${identity.viewer.name},'connected',${stamp},${sealed},${Store.json(Store.healthy)}::jsonb)`;
        yield* sql`UPDATE relay_workflow_authorizations SET status='connected',version=version+1,connection_id=${connectionId},pending_sealed=NULL,error=NULL WHERE owner_user_id=${claimed.owner_user_id} AND application_id=${claimed.application_id}`;
        return connectionId;
      }),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () =>
        Effect.fail(
          Store.fail("unavailable", "Authorization was interrupted. Start connecting again."),
        ),
    }),
  );
  return yield* complete.pipe(
    Effect.tapError((error) =>
      sql`UPDATE relay_workflow_authorizations SET status='failed',version=version+1,pending_sealed=NULL,error=${isSourceError(error) ? error.code : "unavailable"} WHERE owner_user_id=${claimed.owner_user_id} AND application_id=${claimed.application_id} AND attempt_id=${attemptId} AND status='exchanging'`.pipe(
        Effect.ignore,
      ),
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
      AND (${leaseId}::text IS NULL OR lease_id=${leaseId})`;
});
export const credentials = Effect.fn("workflowSources.credentials")(function* (
  c: Store.Connection,
  force = false,
) {
  const config = yield* Linear.configuration;
  if (c.application_id !== config.clientId)
    return yield* Store.fail(
      "service_configuration",
      "This source belongs to a different Linear application.",
    );
  if (c.status !== "connected" || !c.payload_sealed)
    return yield* Store.fail("reconnect_required", "The source owner must reconnect Linear.");
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
  const sql = (yield* RelayDb).$client;
  const lease = yield* uuid;
  // Capture pre-lease recovery state atomically; the caller may hold an older snapshot.
  const [claimed] = yield* sql<Store.Connection & { prior_refresh_started_at: string | null }>`
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
        "Credential recovery expired. The source owner must reconnect Linear.",
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
const read = Effect.fn("workflowSources.read")(function* <A, R>(
  c: Store.Connection,
  use: (token: string) => Effect.Effect<A, WorkflowSourceError, R>,
) {
  let current = yield* credentials(c);
  const result = yield* use(current.credentials.accessToken).pipe(
    Effect.catchTag("WorkflowSourceError", (error) => {
      if (error.code !== "reconnect_required") return Effect.fail(error);
      return Effect.gen(function* () {
        current = yield* credentials(current.connection, true);
        return yield* use(current.credentials.accessToken);
      });
    }),
    Effect.tapError((error) =>
      isSourceError(error) && error.code !== "forbidden"
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
  user: string,
  id: string,
) {
  yield* refresh(yield* owned(id, user));
  return yield* owner(user);
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
