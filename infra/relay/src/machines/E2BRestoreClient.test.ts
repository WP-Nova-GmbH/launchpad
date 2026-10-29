import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { makeE2BRestoreClient, matchesSnapshotAlias } from "./E2BRestoreClient.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const buildId = "d9dc0c90-8d53-447e-997f-40359797d086";
const settings = { apiUrl: "https://compute.example", apiKey: Redacted.make("management-secret") };
const template = (status = "ready") => ({
  templateID: "snapshot",
  names: ["team/capture:default"],
  builds: [{ buildID: buildId, status }],
});
const fixture = (body: unknown = template()) => {
  const transport = vi.fn<typeof fetch>(async (url) =>
    Response.json(String(url).includes("/aliases/") ? { templateID: "snapshot" } : body),
  );
  return { client: makeE2BRestoreClient(settings, transport), transport };
};

describe("native E2B snapshot catalog", () => {
  it.effect(
    "checks the exact retained ready build using GET only, without mutable source aliases",
    () =>
      Effect.gen(function* () {
        const { client, transport } = fixture();
        expect(yield* client.resolveSource("snapshot", buildId)).toEqual({
          sourceTemplateID: "snapshot",
          sourceBuildID: buildId,
        });
        yield* Effect.flip(
          client.resolveSource("snapshot", "01900000-0000-7000-8000-000000000001"),
        );
        for (const selector of ["", "snapshot:default", "team/snapshot"])
          yield* Effect.flip(client.resolveSource(selector, buildId));
        expect(transport.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
          [`${settings.apiUrl}/templates/snapshot`, "GET"],
          [`${settings.apiUrl}/templates/snapshot`, "GET"],
        ]);
      }),
  );
  for (const problem of [
    "wrong-id",
    "extra-ready",
    "extra-pending",
    "pending",
    "failed",
  ] as const) {
    it.effect(`does not admit a retained source with ${problem}`, () =>
      Effect.gen(function* () {
        const value = template();
        if (problem === "wrong-id") value.templateID = "other";
        if (problem === "extra-ready" || problem === "extra-pending")
          value.builds.push({
            buildID: "01900000-0000-7000-8000-000000000001",
            status: problem === "extra-ready" ? "ready" : "building",
          });
        if (problem === "pending") value.builds[0]!.status = "building";
        if (problem === "failed") value.builds[0]!.status = "error";
        expect(
          yield* fixture(value).client.resolveSource("snapshot", buildId).pipe(Effect.flip),
        ).toMatchObject({ reason: "identity" });
      }),
    );
  }
  it.effect("binds a named successful capture to its exact native template and one alias", () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      expect(yield* client.resolveNamedSnapshot("capture")).toEqual({
        sourceTemplateID: "snapshot",
        sourceBuildID: buildId,
      });
      expect(transport.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
        [`${settings.apiUrl}/templates/aliases/capture`, "GET"],
        [`${settings.apiUrl}/templates/snapshot`, "GET"],
      ]);
    }),
  );
  for (const status of ["ready", "error"]) {
    it.effect(
      `records native terminal ${status} identity without granting backup usability or deleting anything`,
      () =>
        Effect.gen(function* () {
          const { client, transport } = fixture(template(status));
          expect(yield* client.resolveTerminalNamedSnapshot("capture")).toEqual({
            snapshotId: "snapshot",
            sourceTemplateID: "snapshot",
            sourceBuildID: buildId,
          });
          expect(transport.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
        }),
    );
  }
  for (const problem of [
    "wrong-id",
    "missing-alias",
    "ambiguous-alias",
    "extra-build",
    "building",
  ] as const) {
    it.effect(`does not settle a capture when native catalog has ${problem}`, () =>
      Effect.gen(function* () {
        const value = template();
        if (problem === "wrong-id") value.templateID = "other";
        if (problem === "missing-alias") value.names = ["team/foreign:default"];
        if (problem === "ambiguous-alias") value.names.push("capture");
        if (problem === "extra-build")
          value.builds.push({ buildID: "01900000-0000-7000-8000-000000000001", status: "error" });
        if (problem === "building") value.builds[0]!.status = "building";
        expect(
          yield* fixture(value).client.resolveTerminalNamedSnapshot("capture").pipe(Effect.flip),
        ).toMatchObject({ reason: "identity" });
        if (problem !== "building")
          expect(
            yield* fixture(value).client.resolveNamedSnapshot("capture").pipe(Effect.flip),
          ).toMatchObject({ reason: "identity" });
      }),
    );
  }
  it.effect("a missing unique alias remains unknown, while template lookup errors propagate", () =>
    Effect.gen(function* () {
      const missing = vi.fn<typeof fetch>(
        async () => new Response("untrusted-body", { status: 404 }),
      );
      const client = makeE2BRestoreClient(settings, missing);
      expect(yield* client.resolveTerminalNamedSnapshot("capture")).toBeNull();
      expect(yield* client.resolveNamedSnapshot("capture").pipe(Effect.flip)).toMatchObject({
        operation: "snapshot alias",
        reason: "http",
        status: 404,
      });
      const afterAlias = vi.fn<typeof fetch>(async (url) =>
        String(url).includes("/aliases/")
          ? Response.json({ templateID: "snapshot" })
          : new Response(null, { status: 404 }),
      );
      expect(
        yield* makeE2BRestoreClient(settings, afterAlias)
          .resolveTerminalNamedSnapshot("capture")
          .pipe(Effect.flip),
      ).toMatchObject({ operation: "snapshot", reason: "http", status: 404 });
    }),
  );
  it.effect("keeps terminal failed captures separate from native ready completions", () =>
    Effect.gen(function* () {
      expect(
        yield* fixture(template("error")).client.resolveFailedNamedSnapshot("capture"),
      ).toEqual({ snapshotId: "snapshot", sourceTemplateID: "snapshot", sourceBuildID: buildId });
      expect(
        yield* fixture(template("ready")).client.resolveFailedNamedSnapshot("capture"),
      ).toBeNull();
      expect(
        yield* fixture(template("building")).client.resolveFailedNamedSnapshot("capture"),
      ).toBeNull();
      expect(
        yield* fixture(template("error")).client.resolveNamedSnapshot("capture").pipe(Effect.flip),
      ).toMatchObject({ reason: "identity" });
    }),
  );
  for (const body of [
    null,
    {},
    {
      templateID: "snapshot",
      names: ["capture"],
      builds: [{ buildID: "not-a-uuid", status: "ready" }],
    },
  ]) {
    it.effect(`malformed native catalog does not become a completion: ${encodeJson(body)}`, () =>
      Effect.gen(function* () {
        expect(
          yield* fixture(body).client.resolveNamedSnapshot("capture").pipe(Effect.flip),
        ).toMatchObject({ reason: "response" });
      }),
    );
  }
  it.effect("keeps HTTP, parse and transport failures bounded and credential-free", () =>
    Effect.gen(function* () {
      const denied = makeE2BRestoreClient(
        settings,
        async () => new Response("management-secret", { status: 403 }),
      );
      const http = yield* denied.resolveSource("snapshot", buildId).pipe(Effect.flip);
      expect(http).toMatchObject({ reason: "http", status: 403 });
      expect(encodeJson(http)).not.toContain("management-secret");
      const invalid = makeE2BRestoreClient(
        settings,
        async () => new Response("management-secret", { status: 200 }),
      );
      expect(yield* invalid.resolveSource("snapshot", buildId).pipe(Effect.flip)).toMatchObject({
        reason: "response",
      });
      const failed = makeE2BRestoreClient(settings, async () => {
        throw Error("X-API-Key: management-secret");
      });
      const transport = yield* failed.resolveSource("snapshot", buildId).pipe(Effect.flip);
      expect(transport).toMatchObject({ reason: "transport" });
      expect(encodeJson(transport)).not.toContain("management-secret");
    }),
  );
  for (const apiUrl of [
    "file:///private/e2b",
    "https://user:secret@compute.example",
    "https://compute.example?key=secret",
    "https://compute.example/#secret",
    "invalid",
  ]) {
    it.effect(`refuses unsafe API configuration before networking: ${apiUrl}`, () =>
      Effect.gen(function* () {
        const transport = vi.fn<typeof fetch>();
        const client = makeE2BRestoreClient({ ...settings, apiUrl }, transport);
        expect(yield* client.resolveSource("snapshot", buildId).pipe(Effect.flip)).toMatchObject({
          reason: "configuration",
        });
        expect(transport).not.toHaveBeenCalled();
      }),
    );
  }
  it.effect("uses only the explicit configured API and never follows a redirect", () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      yield* client.resolveSource("snapshot", buildId);
      const [, options] = transport.mock.calls[0]!;
      expect(options?.redirect).toBe("error");
      expect(options?.headers).toEqual({ "X-API-Key": "management-secret" });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      const empty = makeE2BRestoreClient({ ...settings, apiKey: Redacted.make(" ") }, transport);
      yield* empty.resolveSource("snapshot", buildId).pipe(Effect.flip);
      expect(transport).toHaveBeenCalledTimes(1);
    }),
  );
  it("matches only the exact generated alias, optional native team namespace and default tag", () => {
    for (const candidate of ["capture", "capture:default", "team/capture", "team/capture:default"])
      expect(matchesSnapshotAlias(candidate, "capture")).toBe(true);
    for (const candidate of ["capture-other", "capture:old", "other", "team/other:default"])
      expect(matchesSnapshotAlias(candidate, "capture")).toBe(false);
  });
});
