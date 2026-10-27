// @effect-diagnostics nodeBuiltinImport:off - Resolve local development configuration beside this Node entrypoint.
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { loadThreadVmRuntimeSettings } from "../src/threads/ThreadVmRuntime.ts";

export const defaultDevThreadVmTemplatePath = NodeURL.fileURLToPath(
  new URL("../.t3/e2b-template.json", import.meta.url),
);

const templateReference = TrimmedNonEmptyString.check(Schema.isPattern(/^[^:]+:build-[^:]+$/u));
const isImmutableTemplateReference = Schema.is(templateReference);
const decodeTemplateSelection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      state: Schema.Literal("built"),
      apiUrl: TrimmedNonEmptyString,
      templateRef: templateReference,
      buildId: TrimmedNonEmptyString,
    }),
  ),
);

const templateError = (path: string, detail: string) =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: `${detail} (${path}). Run vp run build:vm-template, then restart the relay.`,
    }),
  );

/** A successful local build selects the runner; deployed Workers keep explicit configuration. */
export const loadDevThreadVmRuntimeSettings = Effect.gen(function* () {
  const enabled = yield* Config.Boolean("RELAY_THREAD_VM_PROVISIONING_ENABLED").pipe(
    Config.withDefault(false),
  );
  if (!enabled) return undefined;

  const override = (yield* Config.String("E2B_TEMPLATE_FILE").pipe(Config.withDefault(""))).trim();
  if (override && !NodePath.isAbsolute(override))
    return yield* Effect.fail(
      templateError(override, "E2B_TEMPLATE_FILE must be an absolute path"),
    );
  const path = override || defaultDevThreadVmTemplatePath;
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" && !override
          ? Effect.void
          : Effect.fail(templateError(path, "Cannot read the selected VM template")),
      ),
    );
  if (content === undefined) {
    // Existing manually configured hosts remain usable until they build a local selection.
    const templateRef = yield* Config.String("E2B_TEMPLATE_REF").pipe(Config.withDefault(""));
    const buildId = yield* Config.String("E2B_TEMPLATE_BUILD_ID").pipe(Config.withDefault(""));
    if (!isImmutableTemplateReference(templateRef) || !buildId.trim())
      return yield* Effect.fail(
        templateError(path, "No successfully built VM template is selected"),
      );
    return yield* loadThreadVmRuntimeSettings;
  }

  const selected = yield* decodeTemplateSelection(content).pipe(
    Effect.mapError(() =>
      templateError(path, "The selected VM template is not a successful build"),
    ),
  );
  const apiUrl = yield* Config.String("E2B_API_URL");
  const matchingApi = yield* Effect.try({
    try: () =>
      new URL(selected.apiUrl).href.replace(/\/+$/u, "") ===
      new URL(apiUrl).href.replace(/\/+$/u, ""),
    catch: () => templateError(path, "The selected VM template or E2B_API_URL has an invalid URL"),
  });
  if (!matchingApi)
    return yield* Effect.fail(
      templateError(path, "The selected VM template belongs to a different E2B_API_URL"),
    );

  const provider = yield* ConfigProvider.ConfigProvider;
  return yield* loadThreadVmRuntimeSettings.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.orElse(
        ConfigProvider.fromUnknown({
          E2B_TEMPLATE_REF: selected.templateRef,
          E2B_TEMPLATE_BUILD_ID: selected.buildId,
        }),
        provider,
      ),
    ),
  );
});
