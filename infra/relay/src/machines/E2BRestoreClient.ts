import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const Identifier = Schema.NonEmptyString;
const UUID = Schema.String.check(Schema.isUUID());
const Template = Schema.Struct({
  templateID: Identifier,
  builds: Schema.Array(Schema.Struct({ buildID: UUID, status: Schema.String })),
});
const decodeTemplate = Schema.decodeUnknownEffect(Template);
const decodeNamedTemplate = Schema.decodeUnknownEffect(
  Schema.Struct({ ...Template.fields, names: Schema.Array(Identifier) }),
);
const decodeAlias = Schema.decodeUnknownEffect(Schema.Struct({ templateID: Identifier }));
export class E2BRestoreError extends Schema.TaggedError<E2BRestoreError>()("E2BRestoreError", {
  operation: Schema.String,
  reason: Schema.Literals(["configuration", "transport", "http", "response", "identity"]),
  status: Schema.optionalKey(Schema.Number),
}) {}

/** Native snapshot aliases can include their team namespace and default tag. */
export function matchesSnapshotAlias(candidate: string, name: string): boolean {
  const alias = candidate.split("/").at(-1);
  return alias === name || alias === `${name}:default`;
}

/** Native catalog reads only. Snapshot creation and VM lifecycle use the stock SDK adapter. */
export function makeE2BRestoreClient(
  settings: { readonly apiUrl: string; readonly apiKey: Redacted.Redacted<string> },
  transport: typeof fetch = fetch,
) {
  const valid = (() => {
    try {
      const url = new URL(settings.apiUrl);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !!Redacted.value(settings.apiKey).trim()
      );
    } catch {
      return false;
    }
  })();
  const base = settings.apiUrl.replace(/\/$/u, "");
  const request = Effect.fn("E2BRestoreClient.request")(function* (
    operation: string,
    path: string,
  ) {
    if (!valid) return yield* new E2BRestoreError({ operation, reason: "configuration" });
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        transport(`${base}${path}`, {
          method: "GET",
          headers: { "X-API-Key": Redacted.value(settings.apiKey) },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        }),
      // Transport errors may include headers; neither credentials nor their raw causes leave this adapter.
      catch: () => new E2BRestoreError({ operation, reason: "transport" }),
    });
    if (!response.ok) {
      yield* Effect.tryPromise({
        try: () => response.body?.cancel() ?? Promise.resolve(),
        catch: () => undefined,
      }).pipe(Effect.ignore);
      return yield* new E2BRestoreError({ operation, reason: "http", status: response.status });
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new E2BRestoreError({ operation, reason: "response" }),
    });
  });
  const source = Effect.fn("E2BRestoreClient.resolveSource")(function* (
    sourceTemplateID: string,
    sourceBuildID: string,
  ) {
    if (!sourceTemplateID || sourceTemplateID.includes(":") || sourceTemplateID.includes("/"))
      return yield* new E2BRestoreError({ operation: "snapshot", reason: "identity" });
    const template = yield* decodeTemplate(
      yield* request("snapshot", `/templates/${encodeURIComponent(sourceTemplateID)}`),
    ).pipe(
      Effect.mapError(() => new E2BRestoreError({ operation: "snapshot", reason: "response" })),
    );
    if (
      template.templateID !== sourceTemplateID ||
      template.builds.length !== 1 ||
      template.builds[0]!.status !== "ready" ||
      template.builds[0]!.buildID !== sourceBuildID
    )
      return yield* new E2BRestoreError({ operation: "snapshot", reason: "identity" });
    return { sourceTemplateID, sourceBuildID };
  });
  const named = Effect.fn("E2BRestoreClient.namedTemplate")(function* (name: string) {
    if (!name)
      return yield* new E2BRestoreError({ operation: "snapshot alias", reason: "identity" });
    const alias = yield* decodeAlias(
      yield* request("snapshot alias", `/templates/aliases/${encodeURIComponent(name)}`),
    ).pipe(
      Effect.mapError(
        () => new E2BRestoreError({ operation: "snapshot alias", reason: "response" }),
      ),
    );
    const template = yield* decodeNamedTemplate(
      yield* request("snapshot", `/templates/${encodeURIComponent(alias.templateID)}`),
    ).pipe(
      Effect.mapError(() => new E2BRestoreError({ operation: "snapshot", reason: "response" })),
    );
    if (
      template.templateID !== alias.templateID ||
      template.builds.length !== 1 ||
      template.names.filter((candidate) => matchesSnapshotAlias(candidate, name)).length !== 1
    )
      return yield* new E2BRestoreError({ operation: "snapshot", reason: "identity" });
    return template;
  });
  const identity = (template: Effect.Success<ReturnType<typeof named>>) => ({
    snapshotId: template.templateID,
    sourceTemplateID: template.templateID,
    sourceBuildID: template.builds[0]!.buildID,
  });
  return {
    resolveSource: source,
    resolveNamedSnapshot: Effect.fn("E2BRestoreClient.resolveNamedSnapshot")(function* (
      name: string,
    ) {
      const template = yield* named(name);
      if (template.builds[0]!.status !== "ready")
        return yield* new E2BRestoreError({ operation: "snapshot", reason: "identity" });
      const { sourceTemplateID, sourceBuildID } = identity(template);
      return { sourceTemplateID, sourceBuildID };
    }),
    /** A missing alias is an unknown upload outcome, never a cleanup fence. */
    resolveTerminalNamedSnapshot: Effect.fn("E2BRestoreClient.resolveTerminalNamedSnapshot")(
      function* (name: string) {
        const template = yield* named(name).pipe(
          Effect.catchTag("E2BRestoreError", (error) =>
            error.operation === "snapshot alias" && error.reason === "http" && error.status === 404
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        );
        if (!template) return null;
        if (!["ready", "error"].includes(template.builds[0]!.status))
          return yield* new E2BRestoreError({ operation: "snapshot", reason: "identity" });
        return identity(template);
      },
    ),
    /** Native snapshot listing omits failed builds; the unique alias retains their terminal identity. */
    resolveFailedNamedSnapshot: Effect.fn("E2BRestoreClient.resolveFailedNamedSnapshot")(function* (
      name: string,
    ) {
      const template = yield* named(name);
      return template.builds[0]!.status === "error" ? identity(template) : null;
    }),
  };
}
