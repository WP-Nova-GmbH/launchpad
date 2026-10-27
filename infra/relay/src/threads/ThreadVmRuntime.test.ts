import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { loadThreadVmRuntimeSettings } from "./ThreadVmRuntime.ts";

const configured = {
  RELAY_THREAD_VM_PROVISIONING_ENABLED: "true",
  E2B_API_URL: "http://127.0.0.1:3000",
  E2B_SANDBOX_URL: "http://127.0.0.1:3002",
  E2B_API_KEY: "test-management-key",
  E2B_TEMPLATE_REF: "runner:build-immutable",
  E2B_TEMPLATE_BUILD_ID: "immutable",
  E2B_HOST_ID: "primary-linux",
  E2B_MAX_RUNNING_VMS: "2",
  E2B_PUBLIC_RELAY_URL: "https://relay.example.com/",
  E2B_HOST_ADDRESSES: "192.0.2.10, 2001:db8::10",
};
const load = (env: Record<string, string>) =>
  loadThreadVmRuntimeSettings.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
it.effect("keeps provisioning off without requiring any compute credentials", () =>
  Effect.gen(function* () {
    expect(yield* load({})).toBeUndefined();
    expect(yield* load({ E2B_API_URL: "incomplete" })).toBeUndefined();
  }),
);
it.effect(
  "loads explicit host capacity and immutable runner identity without exposing the key",
  () =>
    Effect.gen(function* () {
      const settings = yield* load(configured);
      expect(settings).toMatchObject({
        hostId: "primary-linux",
        maxRunningVms: 2,
        templateBuildId: "immutable",
        publicRelayUrl: "https://relay.example.com",
      });
      expect(settings?.compute.hostAddresses).toEqual(["192.0.2.10", "2001:db8::10"]);
      expect(Redacted.isRedacted(settings?.compute.apiKey)).toBe(true);
      expect(String(settings?.compute.apiKey)).not.toContain(configured.E2B_API_KEY);
    }),
);
it.effect.each([
  ["E2B_MAX_RUNNING_VMS", "0"],
  ["E2B_MAX_RUNNING_VMS", "1.5"],
  ["E2B_TEMPLATE_REF", "runner:default"],
  ["E2B_TEMPLATE_BUILD_ID", ""],
  ["E2B_PUBLIC_RELAY_URL", "http://relay.test"],
  ["E2B_PUBLIC_RELAY_URL", "https://localhost"],
  ["E2B_PUBLIC_RELAY_URL", "https://user:secret@relay.test"],
  ["E2B_API_URL", "http://127.0.0.1:3000?token=secret"],
  ["E2B_HOST_ID", " "],
  ["E2B_HOST_ID", "x".repeat(192)],
  ["E2B_HOST_ADDRESSES", " , "],
] as const)("rejects unsafe or incomplete configuration %s=%s", ([key, value]) =>
  Effect.gen(function* () {
    expect((yield* Effect.result(load({ ...configured, [key]: value })))._tag).toBe("Failure");
  }),
);
it.effect("accepts host identities up to the persistence limit", () =>
  Effect.gen(function* () {
    const hostId = "x".repeat(191);
    expect((yield* load({ ...configured, E2B_HOST_ID: hostId }))?.hostId).toBe(hostId);
  }),
);
it.effect("refuses enabling provisioning with missing required settings", () =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.result(load({ RELAY_THREAD_VM_PROVISIONING_ENABLED: "true" })))._tag,
    ).toBe("Failure");
  }),
);

it.effect(
  "keeps idle deletion disabled unless both deletion and verified backups are explicitly enabled",
  () =>
    Effect.gen(function* () {
      const disabled = yield* load(configured);
      expect(disabled?.autoDeleteEnabled).toBe(false);
      expect(
        (yield* Effect.result(load({ ...configured, RELAY_THREAD_VM_AUTO_DELETE_ENABLED: "true" })))
          ._tag,
      ).toBe("Failure");
      const enabled = yield* load({
        ...configured,
        RELAY_THREAD_VM_AUTO_DELETE_ENABLED: "true",
        RELAY_THREAD_VM_AUTO_BACKUP_ENABLED: "true",
      });
      expect(enabled?.autoDeleteEnabled).toBe(true);
    }),
);

it.effect(
  "keeps replacement disabled until verified backups and replacement are explicitly enabled",
  () =>
    Effect.gen(function* () {
      expect((yield* load(configured))?.replacementEnabled).toBe(false);
      expect(
        (yield* Effect.result(load({ ...configured, RELAY_THREAD_VM_REPLACEMENT_ENABLED: "true" })))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* load({
          ...configured,
          RELAY_THREAD_VM_REPLACEMENT_ENABLED: "true",
          RELAY_THREAD_VM_AUTO_BACKUP_ENABLED: "true",
        }))?.replacementEnabled,
      ).toBe(true);
    }),
);

it.effect("keeps serving restores disabled until explicitly enabled", () =>
  Effect.gen(function* () {
    expect((yield* load(configured))?.restoreEnabled).toBe(false);
    expect(
      (yield* load({ ...configured, RELAY_THREAD_VM_RESTORE_ENABLED: "true" }))?.restoreEnabled,
    ).toBe(true);
  }),
);

it.effect("keeps resetting VMs disabled until explicitly enabled", () =>
  Effect.gen(function* () {
    expect((yield* load(configured))?.resetEnabled).toBe(false);
    expect(
      (yield* load({ ...configured, RELAY_THREAD_VM_RESET_ENABLED: "true" }))?.resetEnabled,
    ).toBe(true);
  }),
);

it.effect("permanent deletion stays explicitly disabled until its release gates pass", () =>
  Effect.gen(function* () {
    expect((yield* load(configured))?.permanentDeleteEnabled).toBe(false);
    expect(
      (yield* load({ ...configured, RELAY_THREAD_VM_PERMANENT_DELETE_ENABLED: "true" }))
        ?.permanentDeleteEnabled,
    ).toBe(true);
  }),
);

const previewConfigured = {
  ...configured,
  RELAY_THREAD_VM_PREVIEW_BASE_URL: "https://previews.example.net/",
  RELAY_THREAD_VM_APP_ORIGINS: "https://app.example.com",
  RELAY_THREAD_VM_AUTH_ORIGINS: "https://auth.example.org",
};

it.effect(
  "keeps previews disabled until isolated domains and protected origins are configured",
  () =>
    Effect.gen(function* () {
      expect((yield* load(configured))?.previewBaseUrl).toBeUndefined();
      expect((yield* load(previewConfigured))?.previewBaseUrl).toBe("https://previews.example.net");
      for (const origin of [
        "https://relay.example.com",
        "https://child.relay.example.com",
        "https://sibling.example.com",
        "https://preview.example.org",
        "https://example.com",
        "https://bad.test/path",
        "https://user:secret@bad.test",
        "bad-url",
        "http://public.test",
        "https://co.uk",
        "https://unknown.invalid",
        "https://127.0.0.1",
      ]) {
        expect(
          (yield* load({ ...previewConfigured, RELAY_THREAD_VM_PREVIEW_BASE_URL: origin }).pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      }
    }),
);

it.effect("fails closed when application or authentication cookie origins are unknown", () =>
  Effect.gen(function* () {
    for (const key of ["RELAY_THREAD_VM_APP_ORIGINS", "RELAY_THREAD_VM_AUTH_ORIGINS"] as const) {
      for (const origin of [
        "",
        " ",
        "*",
        "https://unknown.invalid",
        "https://app.example.com/path",
        "https://app.example.com?token=secret",
        "https://user:secret@app.example.com",
        "https://app.example.com,",
        "t3code-dev://app",
      ])
        expect(
          (yield* load({ ...previewConfigured, [key]: origin }).pipe(Effect.result))._tag,
        ).toBe("Failure");
    }
    expect(
      (yield* load({ ...previewConfigured, E2B_PUBLIC_RELAY_URL: "https://relay.internal" }).pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("uses complete public and private suffixes and every declared protected origin", () =>
  Effect.gen(function* () {
    for (const [preview, applications] of [
      ["https://preview.shared.co.uk", "https://app.shared.co.uk"],
      ["https://preview.account.github.io", "https://app.account.github.io"],
      ["https://preview.xn--mnich-kva.de", "https://app.münich.de"],
      ["https://PREVIEW.EXAMPLE.COM.", "https://app.example.org"],
      ["https://preview.example.net", "https://app.example.com, https://second.example.net"],
    ])
      expect(
        (yield* load({
          ...previewConfigured,
          RELAY_THREAD_VM_PREVIEW_BASE_URL: preview!,
          RELAY_THREAD_VM_APP_ORIGINS: applications!,
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
    expect(
      (yield* load({
        ...previewConfigured,
        RELAY_THREAD_VM_PREVIEW_BASE_URL: "https://vm-guest.github.io",
        RELAY_THREAD_VM_APP_ORIGINS: "https://launchpad.github.io",
        RELAY_THREAD_VM_AUTH_ORIGINS: "https://instance.clerk.accounts.dev",
      }))?.previewBaseUrl,
    ).toBe("https://vm-guest.github.io");
  }),
);

it.effect("keeps local preview cookies separate from authenticated localhost applications", () =>
  Effect.gen(function* () {
    expect(
      (yield* load({
        ...previewConfigured,
        RELAY_THREAD_VM_PREVIEW_BASE_URL: "http://preview.localhost:8610",
        RELAY_THREAD_VM_APP_ORIGINS: "http://127.0.0.1:7737",
      }))?.previewBaseUrl,
    ).toBe("http://preview.localhost:8610");
    for (const origin of ["http://localhost:7737", "http://app.localhost:7737"]) {
      expect(
        (yield* load({
          ...previewConfigured,
          RELAY_THREAD_VM_PREVIEW_BASE_URL: "http://preview.localhost:8610",
          RELAY_THREAD_VM_APP_ORIGINS: origin,
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }
  }),
);
