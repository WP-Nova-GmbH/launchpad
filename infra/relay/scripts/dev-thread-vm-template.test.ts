import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  defaultDevThreadVmTemplatePath,
  loadDevThreadVmRuntimeSettings,
} from "./dev-thread-vm-template.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const configured = {
  RELAY_THREAD_VM_PROVISIONING_ENABLED: "true",
  E2B_API_URL: "http://127.0.0.1:3000",
  E2B_SANDBOX_URL: "http://127.0.0.1:3002",
  E2B_API_KEY: "test-management-key",
  E2B_HOST_ID: "primary-linux",
  E2B_MAX_RUNNING_VMS: "2",
  E2B_PUBLIC_RELAY_URL: "https://relay.example.com/",
  E2B_HOST_ADDRESSES: "192.0.2.10",
};
const selected = {
  schemaVersion: 1,
  state: "built",
  apiUrl: configured.E2B_API_URL,
  templateRef: "runner:build-selected",
  buildId: "selected-build-id",
};
const legacy = {
  E2B_TEMPLATE_REF: "old-runner:build-legacy",
  E2B_TEMPLATE_BUILD_ID: "legacy-build-id",
};
const load = (env: Record<string, string>, fs: FileSystem.FileSystem = FileSystem.makeNoop({})) =>
  loadDevThreadVmRuntimeSettings.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Effect.provideService(FileSystem.FileSystem, fs),
  );

describe("local VM runner selection", () => {
  it.effect("does not read a template or require VM settings while provisioning is disabled", () =>
    Effect.gen(function* () {
      const fs = FileSystem.makeNoop({
        readFileString: () => Effect.die("disabled provisioning must not read files"),
      });
      expect(yield* load({}, fs)).toBeUndefined();
      expect(
        yield* load({ ...configured, RELAY_THREAD_VM_PROVISIONING_ENABLED: "false" }, fs),
      ).toBeUndefined();
    }),
  );

  it.effect("loads the successful build without requiring manual template IDs", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const fs = FileSystem.makeNoop({
        readFileString: (path) =>
          Effect.sync(() => {
            paths.push(path);
            return encodeJson(selected);
          }),
      });
      const settings = yield* load(configured, fs);
      expect(settings?.compute.templateId).toBe(selected.templateRef);
      expect(settings?.templateBuildId).toBe(selected.buildId);
      expect(settings?.compute.apiUrl).toBe(configured.E2B_API_URL);
      expect(settings?.hostId).toBe(configured.E2B_HOST_ID);
      expect(paths).toEqual([defaultDevThreadVmTemplatePath]);
      expect(defaultDevThreadVmTemplatePath).toMatch(/\/infra\/relay\/\.t3\/e2b-template\.json$/u);
    }),
  );

  it.effect("uses the selected file instead of stale manual template configuration", () =>
    Effect.gen(function* () {
      const settings = yield* load(
        {
          ...configured,
          E2B_TEMPLATE_REF: "stale-placeholder",
          E2B_TEMPLATE_BUILD_ID: "stale-placeholder",
          E2B_TEMPLATE_FILE: "/fixture/selected-template.json",
        },
        FileSystem.makeNoop({
          readFileString: (path) => {
            expect(path).toBe("/fixture/selected-template.json");
            return Effect.succeed(encodeJson(selected));
          },
        }),
      );
      expect(settings?.compute.templateId).toBe(selected.templateRef);
      expect(settings?.templateBuildId).toBe(selected.buildId);
    }),
  );

  it.effect.each([
    "selected-template.json",
    "./selected-template.json",
    "../selected-template.json",
  ])("rejects the relative E2B_TEMPLATE_FILE %s before reading files", (path) =>
    Effect.gen(function* () {
      const error = yield* load(
        { ...configured, ...legacy, E2B_TEMPLATE_FILE: path },
        FileSystem.makeNoop({
          readFileString: () => Effect.die("relative paths must be rejected before file access"),
        }),
      ).pipe(Effect.flip);
      expect(error.message).toContain("E2B_TEMPLATE_FILE must be an absolute path");
    }),
  );

  it.effect("uses the default selection for a whitespace-only E2B_TEMPLATE_FILE", () =>
    Effect.gen(function* () {
      const settings = yield* load(
        { ...configured, E2B_TEMPLATE_FILE: " \t " },
        FileSystem.makeNoop({
          readFileString: (path) => {
            expect(path).toBe(defaultDevThreadVmTemplatePath);
            return Effect.succeed(encodeJson(selected));
          },
        }),
      );
      expect(settings?.compute.templateId).toBe(selected.templateRef);
    }),
  );

  it.effect("accepts an API URL trailing slash without changing the configured API", () =>
    Effect.gen(function* () {
      for (const [apiUrl, selectedApiUrl] of [
        [configured.E2B_API_URL + "/", configured.E2B_API_URL],
        [configured.E2B_API_URL, configured.E2B_API_URL + "/"],
      ] as const) {
        const settings = yield* load(
          { ...configured, E2B_API_URL: apiUrl },
          FileSystem.makeNoop({
            readFileString: () =>
              Effect.succeed(encodeJson({ ...selected, apiUrl: selectedApiUrl })),
          }),
        );
        expect(settings?.compute.apiUrl).toBe(apiUrl);
      }
    }),
  );

  it.effect.each([
    ["http://LOCALHOST:3000", "http://localhost:3000"],
    ["https://HOST.EXAMPLE:443/", "https://host.example"],
  ] as const)("accepts canonical-equivalent API URLs %s and %s", ([apiUrl, selectedApiUrl]) =>
    Effect.gen(function* () {
      const settings = yield* load(
        { ...configured, E2B_API_URL: apiUrl },
        FileSystem.makeNoop({
          readFileString: () => Effect.succeed(encodeJson({ ...selected, apiUrl: selectedApiUrl })),
        }),
      );
      expect(settings?.compute.apiUrl).toBe(apiUrl);
    }),
  );

  it.effect("preserves legacy explicit configuration only when the default file is absent", () =>
    Effect.gen(function* () {
      const settings = yield* load({ ...configured, ...legacy });
      expect(settings?.compute.templateId).toBe(legacy.E2B_TEMPLATE_REF);
      expect(settings?.templateBuildId).toBe(legacy.E2B_TEMPLATE_BUILD_ID);
    }),
  );

  it.effect("also accepts a complete successful build receipt as the explicit selection file", () =>
    Effect.gen(function* () {
      const settings = yield* load(
        { ...configured, E2B_TEMPLATE_FILE: "/fixture/build-receipt.json" },
        FileSystem.makeNoop({
          readFileString: () =>
            Effect.succeed(
              encodeJson({
                ...selected,
                templateId: "runner",
                buildTag: "build-selected",
                serverSha256: "a".repeat(64),
                versions: { node: "24.21.0", resources: { cpuCount: 2, memoryMB: 4096 } },
              }),
            ),
        }),
      );
      expect(settings?.compute.templateId).toBe(selected.templateRef);
      expect(settings?.templateBuildId).toBe(selected.buildId);
    }),
  );

  it.effect("gives a build command when neither a selected build nor legacy IDs exist", () =>
    Effect.gen(function* () {
      const error = yield* load(configured).pipe(Effect.flip);
      expect(error.message).toContain("No successfully built VM template is selected");
      expect(error.message).toContain("vp run build:vm-template");
    }),
  );

  it.effect("gives the build command for unreplaced legacy template placeholders", () =>
    Effect.gen(function* () {
      const error = yield* load({
        ...configured,
        E2B_TEMPLATE_REF: "<templateRef from a successful build receipt>",
        E2B_TEMPLATE_BUILD_ID: "<buildId from a successful build receipt>",
      }).pipe(Effect.flip);
      expect(error.message).toContain("No successfully built VM template is selected");
      expect(error.message).toContain("vp run build:vm-template");
    }),
  );

  it.effect("does not fall back when an explicit selection file is missing", () =>
    Effect.gen(function* () {
      const error = yield* load({
        ...configured,
        ...legacy,
        E2B_TEMPLATE_FILE: "/fixture/missing-template.json",
      }).pipe(Effect.flip);
      expect(error.message).toContain("Cannot read the selected VM template");
      expect(error.message).toContain("/fixture/missing-template.json");
    }),
  );

  it.effect.each([
    ["unfinished build", encodeJson({ ...selected, state: "building" })],
    ["wrong schema", encodeJson({ ...selected, schemaVersion: 2 })],
    ["mutable tag", encodeJson({ ...selected, templateRef: "runner:latest" })],
    ["missing build ID", encodeJson({ ...selected, buildId: " " })],
    ["unreadable JSON", "{broken"],
    ["malformed API URL", encodeJson({ ...selected, apiUrl: ":not-a-url" })],
    ["different API", encodeJson({ ...selected, apiUrl: "https://other.example.test" })],
  ])("rejects %s even when legacy IDs are present", ([, content]) =>
    Effect.gen(function* () {
      const error = yield* load(
        { ...configured, ...legacy },
        FileSystem.makeNoop({ readFileString: () => Effect.succeed(content!) }),
      ).pipe(Effect.flip);
      expect(error.message).toContain("vp run build:vm-template");
    }),
  );

  it.effect("does not hide file permission failures behind legacy configuration", () =>
    Effect.gen(function* () {
      const error = yield* load(
        { ...configured, ...legacy },
        FileSystem.makeNoop({
          readFileString: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
              }),
            ),
        }),
      ).pipe(Effect.flip);
      expect(error.message).toContain("Cannot read the selected VM template");
    }),
  );
});
