import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  RELAY_WORKFLOW_ENV_MAX_ENTRIES,
  RELAY_WORKFLOW_ENV_NAME_MAX_LENGTH,
  RELAY_WORKFLOW_ENV_TOTAL_MAX_BYTES,
  RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES,
  RelayOrganizationId,
  RelayRepositoryId,
  type RelayRepositoryWorkflowConfiguration,
  type RelayUpdateRepositoryWorkflowConfiguration,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RelaySecretBox } from "../auth/SecretBox.ts";

export class RepositoryWorkflowConfigurationError extends Schema.TaggedError<RepositoryWorkflowConfigurationError>()(
  "RepositoryWorkflowConfigurationError",
  { reason: Schema.Literals(["invalid", "limit", "conflict", "storage"]) },
) {}

const failure = (reason: RepositoryWorkflowConfigurationError["reason"]) =>
  new RepositoryWorkflowConfigurationError({ reason });

const StoredEntry = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("variable"), name: Schema.String, value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("secret"),
    name: Schema.String,
    sealed: Schema.String,
    bytes: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES }),
    ),
  }),
]);
type StoredEntry = typeof StoredEntry.Type;
const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(StoredEntry));
const SecretEnvelope = Schema.Struct({
  purpose: Schema.Literal("repository-workflow-environment"),
  organizationId: Schema.String,
  repositoryId: Schema.String,
  name: Schema.String,
  value: Schema.String,
});
const SecretJson = Schema.fromJsonString(SecretEnvelope);
const encodeSecret = Schema.encodeEffect(SecretJson);
const decodeSecret = Schema.decodeUnknownEffect(SecretJson);
const utf8 = new TextEncoder();

type RepositoryScope = { readonly organizationId: string; readonly repositoryId: string };

// Workloads inherit these boundaries from the VM runtime, credential helper, and provider.
const reservedNames = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "ENV",
  "BASH_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
]);
const reservedPrefixes = [
  "T3CODE_",
  "LAUNCHPAD_",
  "CODEX_",
  "GIT_",
  "LD_",
  "DYLD_",
  "XDG_",
  "BASH_FUNC_",
];
const isAllowedName = (name: string): boolean => {
  const key = name.toUpperCase();
  return (
    name.length <= RELAY_WORKFLOW_ENV_NAME_MAX_LENGTH &&
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) &&
    !reservedNames.has(key) &&
    !reservedPrefixes.some((prefix) => key.startsWith(prefix))
  );
};
const entryBytes = (entry: StoredEntry): number =>
  entry.kind === "secret" ? entry.bytes : utf8.encode(entry.value).byteLength;
const validValue = (value: string): boolean =>
  !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0");

const readStored = Effect.fnUntraced(function* (sql: PgClient, scope: RepositoryScope) {
  const [row] = yield* sql<{ revision: number; entries: unknown }>`
    SELECT c.revision,c.entries FROM relay_repository_workflow_configurations c
    JOIN relay_repositories r USING(repository_id)
    WHERE c.repository_id=${scope.repositoryId} AND r.organization_id=${scope.organizationId}
  `.pipe(Effect.mapError(() => failure("storage")));
  if (!row) return { revision: 0, entries: [] as ReadonlyArray<StoredEntry> };
  const entries = yield* decodeEntries(row.entries).pipe(Effect.mapError(() => failure("storage")));
  if (
    entries.length > RELAY_WORKFLOW_ENV_MAX_ENTRIES ||
    new Set(entries.map((entry) => entry.name)).size !== entries.length ||
    entries.some(
      (entry) =>
        !isAllowedName(entry.name) ||
        entryBytes(entry) > RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES ||
        (entry.kind === "variable" && !validValue(entry.value)),
    ) ||
    entries.reduce((total, entry) => total + entryBytes(entry), 0) >
      RELAY_WORKFLOW_ENV_TOTAL_MAX_BYTES
  )
    return yield* failure("storage");
  return { revision: row.revision, entries };
});

const publicConfiguration = (
  scope: RepositoryScope,
  revision: number,
  entries: ReadonlyArray<StoredEntry>,
): RelayRepositoryWorkflowConfiguration => ({
  organizationId: RelayOrganizationId.make(scope.organizationId),
  repositoryId: RelayRepositoryId.make(scope.repositoryId),
  revision,
  entries: entries.map((entry) =>
    entry.kind === "variable"
      ? { kind: "variable", name: entry.name, value: entry.value }
      : { kind: "secret", name: entry.name },
  ),
});

export const getRepositoryWorkflowConfiguration = Effect.fnUntraced(function* (
  sql: PgClient,
  scope: RepositoryScope,
) {
  const { revision, entries } = yield* readStored(sql, scope);
  return publicConfiguration(scope, revision, entries);
});

/** The caller holds maintainable-repository authority and the repository write lock. */
export const updateRepositoryWorkflowConfiguration = Effect.fnUntraced(function* (
  sql: PgClient,
  box: RelaySecretBox["Service"],
  scope: RepositoryScope,
  { expectedRevision, mutation }: RelayUpdateRepositoryWorkflowConfiguration,
) {
  if (!isAllowedName(mutation.name)) return yield* failure("invalid");
  const { revision, entries } = yield* readStored(sql, scope);
  if (revision !== expectedRevision) return yield* failure("conflict");
  if (revision === 2_147_483_647) return yield* failure("limit");
  const previous = entries.find((entry) => entry.name === mutation.name);
  const next = entries.filter((entry) => entry.name !== mutation.name);
  if (mutation.kind === "delete") {
    if (!previous) return yield* failure("invalid");
  } else {
    const kind = mutation.kind === "setVariable" ? "variable" : "secret";
    if (
      (previous && previous.kind !== kind) ||
      !validValue(mutation.value) ||
      (kind === "secret" && mutation.value.length === 0)
    )
      return yield* failure("invalid");
    const bytes = utf8.encode(mutation.value).byteLength;
    if (
      bytes > RELAY_WORKFLOW_ENV_VALUE_MAX_BYTES ||
      next.length >= RELAY_WORKFLOW_ENV_MAX_ENTRIES ||
      next.reduce((total, entry) => total + entryBytes(entry), bytes) >
        RELAY_WORKFLOW_ENV_TOTAL_MAX_BYTES
    )
      return yield* failure("limit");
    if (kind === "variable") {
      next.push({ kind, name: mutation.name, value: mutation.value });
    } else {
      const sealed = yield* encodeSecret({
        purpose: "repository-workflow-environment",
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        name: mutation.name,
        value: mutation.value,
      }).pipe(
        Effect.flatMap(box.seal),
        Effect.mapError(() => failure("storage")),
      );
      next.push({ kind, name: mutation.name, sealed, bytes });
    }
  }
  next.sort((left, right) => left.name.localeCompare(right.name));
  const nextRevision = revision + 1;
  yield* sql`
    INSERT INTO relay_repository_workflow_configurations (repository_id,revision,entries)
    VALUES (${scope.repositoryId},${nextRevision},${sql.json(next)})
    ON CONFLICT (repository_id) DO UPDATE SET revision=excluded.revision,entries=excluded.entries
  `.pipe(Effect.mapError(() => failure("storage")));
  return publicConfiguration(scope, nextRevision, next);
});

/** Caller holds the live repository's shared lock through accepting preparation. */
export const readWorkflowConfigurationForFreeze = Effect.fnUntraced(function* (
  sql: PgClient,
  box: RelaySecretBox["Service"],
  scope: RepositoryScope,
) {
  const { revision, entries } = yield* readStored(sql, scope);
  const values = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      if (entry.kind === "variable")
        return { kind: entry.kind, name: entry.name, value: entry.value } as const;
      const envelope = yield* box.open(entry.sealed).pipe(
        Effect.flatMap(decodeSecret),
        Effect.mapError(() => failure("storage")),
      );
      if (
        envelope.organizationId !== scope.organizationId ||
        envelope.repositoryId !== scope.repositoryId ||
        envelope.name !== entry.name ||
        !validValue(envelope.value) ||
        utf8.encode(envelope.value).byteLength !== entry.bytes
      )
        return yield* failure("storage");
      return { kind: entry.kind, name: entry.name, value: envelope.value } as const;
    }),
  );
  return { revision, values, hasSecrets: values.some((entry) => entry.kind === "secret") };
});
