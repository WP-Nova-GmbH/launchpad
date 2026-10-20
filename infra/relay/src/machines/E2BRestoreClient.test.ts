import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { makeE2BRestoreClient } from "./E2BRestoreClient.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const operationID = "c07929bf-0882-46bf-95c4-9e1f2c032da8";
const generation = "generation-2";
const status = {
  operationID,
  generation,
  sandboxID: "restored-vm",
  executionID: "feaa6d88-cc72-4c31-9493-99c733dfe747",
  preparedBuildID: "d9dc0c90-8d53-447e-997f-40359797d086",
  state: "preparing",
};
const settings = { apiUrl: "https://compute.example", apiKey: Redacted.make("management-secret") };
const input = {
  sourceTemplateID: "snapshot",
  sourceBuildID: status.preparedBuildID,
  generation,
  leaseSeconds: 600,
};
function fixture(reply: unknown = status) {
  const transport = vi.fn<typeof fetch>(async () => Response.json(reply));
  return { transport, client: makeE2BRestoreClient(settings, transport) };
}
describe("E2B prepared restore client", () => {
  it.effect(
    "retains only the requested paused alias and preserves a definitive refusal status",
    () =>
      Effect.gen(function* () {
        const { client, transport } = fixture({
          snapshotID: "team/save:default",
          names: ["team/save"],
        });
        expect(yield* client.retainPausedSnapshot("paused-vm", "save")).toEqual({
          snapshotId: "team/save:default",
          names: ["team/save"],
        });
        expect(transport.mock.lastCall?.[0]).toBe(
          `${settings.apiUrl}/sandboxes/paused-vm/snapshots`,
        );
        expect(yield* decodeJson(String(transport.mock.lastCall?.[1]?.body))).toEqual({
          name: "save",
        });
        transport.mockImplementation(async () =>
          Response.json({ snapshotID: "wrong", names: ["team/save:other"] }),
        );
        expect(
          yield* client.retainPausedSnapshot("paused-vm", "save").pipe(Effect.flip),
        ).toMatchObject({ reason: "identity" });
        transport.mockImplementation(async () => new Response(null, { status: 409 }));
        expect(
          yield* client.retainPausedSnapshot("paused-vm", "save").pipe(Effect.flip),
        ).toMatchObject({ operation: "paused snapshot", reason: "http", status: 409 });
      }),
  );
  it.effect("requires a positive physical-stop receipt for the exact restored VM", () =>
    Effect.gen(function* () {
      const boot = { ...status, state: "active" as const };
      const { client, transport } = fixture({ sandboxID: boot.sandboxID, physicallyStopped: true });
      expect(yield* client.stopBoot(boot)).toEqual({ ...boot, physicallyStopped: true });
      expect(transport.mock.lastCall?.[0]).toBe(
        `${settings.apiUrl}/extensions/launchpad/v1/executions/restored-vm`,
      );
      expect(transport.mock.lastCall?.[1]?.method).toBe("DELETE");
      for (const reply of [
        { sandboxID: "foreign", physicallyStopped: true },
        { sandboxID: boot.sandboxID, physicallyStopped: false },
        { sandboxID: boot.sandboxID },
      ]) {
        transport.mockImplementation(async () => Response.json(reply));
        expect(yield* Effect.flip(client.stopBoot(boot))).toMatchObject({
          _tag: "E2BRestoreError",
        });
      }
      transport.mockImplementation(async () => new Response(null, { status: 404 }));
      expect(yield* Effect.flip(client.stopBoot(boot))).toMatchObject({
        reason: "http",
        status: 404,
      });
    }),
  );
  it.effect("distinguishes missing sandbox catalog state from an unavailable control plane", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
      const client = makeE2BRestoreClient(settings, transport);
      expect(yield* client.sandboxExists("restored-vm")).toBe(false);
      transport.mockImplementation(async () => new Response(null, { status: 503 }));
      expect(yield* Effect.flip(client.sandboxExists("restored-vm"))).toMatchObject({
        _tag: "E2BRestoreError",
        reason: "http",
        status: 503,
      });
      expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET"]);
    }),
  );

  it.effect(
    "keeps preparation and explicit activation separate and binds retries to the same operation",
    () =>
      Effect.gen(function* () {
        const { client, transport } = fixture();
        yield* client.prepare(operationID, input);
        yield* client.prepare(operationID, input);
        yield* client.inspect(operationID, generation);
        expect(transport.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
          [`${settings.apiUrl}/extensions/launchpad/v1/restores/${operationID}`, "PUT"],
          [`${settings.apiUrl}/extensions/launchpad/v1/restores/${operationID}`, "PUT"],
          [`${settings.apiUrl}/extensions/launchpad/v1/restores/${operationID}`, "GET"],
        ]);
        expect(transport.mock.calls[0]?.[1]).toMatchObject({
          redirect: "error",
          body: encodeJson(input),
        });
        yield* client.activate(operationID, generation);
        expect(transport.mock.lastCall?.[0]).toMatch(/\/activate$/u);
        expect(transport.mock.lastCall?.[1]?.method).toBe("POST");
      }),
  );
  for (const response of [
    { ...status, generation: "retired" },
    { ...status, operationID: "f6cfae25-cbbe-40d1-9e43-13b8c497ca18" },
  ]) {
    it.effect("rejects a response for another operation or placement", () =>
      Effect.gen(function* () {
        const { client } = fixture(response);
        expect(yield* Effect.flip(client.inspect(operationID, generation))).toMatchObject({
          reason: "identity",
        });
      }),
    );
  }
  it.effect("does not retry or boot elsewhere after an ambiguous transport failure", () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      transport.mockRejectedValue(
        new Error("request with management-secret and enrollment-secret failed"),
      );
      const error = yield* Effect.flip(client.activate(operationID, generation));
      expect(error.reason).toBe("transport");
      expect(encodeJson(error)).not.toContain("secret");
      expect(transport).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("preserves refusal status without returning a possibly secret response body", () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      transport.mockImplementation(async () => new Response("management-secret", { status: 409 }));
      const error = yield* Effect.flip(client.cancel(operationID, generation));
      expect(error).toMatchObject({ reason: "http", status: 409 });
      expect(encodeJson(error)).not.toContain("management-secret");
    }),
  );
  for (const reply of [
    { version: 2, diskRestore: true, renewableLifetime: true },
    { version: 1, diskRestore: false, renewableLifetime: false },
  ]) {
    it.effect(
      "rejects incompatible capability versions instead of using ordinary snapshot boot",
      () =>
        Effect.gen(function* () {
          const { client, transport } = fixture(reply);
          expect(yield* Effect.flip(client.capabilities())).toMatchObject({
            reason: "unsupported",
          });
          expect(transport).toHaveBeenCalledTimes(1);
        }),
    );
  }
  it.effect(
    "resolves a unique snapshot to a fixed build and rejects ambiguous template histories",
    () =>
      Effect.gen(function* () {
        const { client, transport } = fixture({
          templateID: "snapshot",
          builds: [{ buildID: status.preparedBuildID, status: "ready" }],
        });
        expect(yield* client.resolveSnapshot("snapshot:default")).toEqual({
          sourceTemplateID: "snapshot",
          sourceBuildID: status.preparedBuildID,
        });
        transport.mockImplementation(async () =>
          Response.json({
            templateID: "snapshot",
            builds: [
              { buildID: status.preparedBuildID, status: "ready" },
              { buildID: status.executionID, status: "ready" },
            ],
          }),
        );
        expect(yield* Effect.flip(client.resolveSnapshot("snapshot:default"))).toMatchObject({
          reason: "identity",
        });
      }),
  );
  it.effect("refuses invalid endpoint configuration before sending credentials", () =>
    Effect.gen(function* () {
      const { transport } = fixture();
      const client = makeE2BRestoreClient(
        { ...settings, apiUrl: "https://user:secret@compute.example" },
        transport,
      );
      expect(yield* Effect.flip(client.capabilities())).toMatchObject({ reason: "configuration" });
      expect(transport).not.toHaveBeenCalled();
    }),
  );
});

it.effect("resolves a recoverable named snapshot before binding its immutable build", () =>
  Effect.gen(function* () {
    const { client, transport } = fixture();
    transport.mockResolvedValueOnce(Response.json({ templateID: "snapshot" }));
    transport.mockResolvedValueOnce(
      Response.json({
        templateID: "snapshot",
        builds: [{ buildID: status.preparedBuildID, status: "ready" }],
      }),
    );
    expect(yield* client.resolveNamedSnapshot("team/proof:default")).toEqual({
      sourceTemplateID: "snapshot",
      sourceBuildID: status.preparedBuildID,
    });
    expect(transport.mock.calls[0]?.[0]).toBe(
      `${settings.apiUrl}/templates/aliases/team%2Fproof%3Adefault`,
    );
  }),
);

for (const statusName of ["error", "building", "ready"]) {
  it.effect(`resolves only a positive terminal ${statusName} named capture`, () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      transport.mockResolvedValueOnce(Response.json({ templateID: "snapshot" }));
      transport.mockResolvedValueOnce(
        Response.json({
          templateID: "snapshot",
          names: ["team/proof"],
          builds: [{ buildID: status.preparedBuildID, status: statusName }],
        }),
      );
      const result = yield* client.resolveFailedNamedSnapshot("proof");
      expect(result).toEqual(
        statusName === "error"
          ? {
              snapshotId: "snapshot",
              sourceTemplateID: "snapshot",
              sourceBuildID: status.preparedBuildID,
            }
          : null,
      );
      expect(transport.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET"]);
    }),
  );
}
for (const [problem, reply] of Object.entries({
  "foreign-template": {
    templateID: "foreign",
    names: ["team/proof"],
    builds: [{ buildID: status.preparedBuildID, status: "error" }],
  },
  "foreign-alias": {
    templateID: "snapshot",
    names: ["team/another"],
    builds: [{ buildID: status.preparedBuildID, status: "error" }],
  },
  "ambiguous-build": {
    templateID: "snapshot",
    names: ["team/proof"],
    builds: [
      { buildID: status.preparedBuildID, status: "error" },
      { buildID: status.executionID, status: "error" },
    ],
  },
  "missing-build": { templateID: "snapshot", names: ["team/proof"], builds: [] },
})) {
  it.effect(`rejects ${problem} failed snapshot evidence`, () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      transport.mockResolvedValueOnce(Response.json({ templateID: "snapshot" }));
      transport.mockResolvedValueOnce(Response.json(reply));
      expect(yield* Effect.flip(client.resolveFailedNamedSnapshot("proof"))).toMatchObject({
        reason: "identity",
      });
    }),
  );
}

it.effect(
  "exposes a confirmed restore failure for reconciliation without retrying activation",
  () =>
    Effect.gen(function* () {
      const reply = {
        ...status,
        state: "failed",
        error: "activation lease expired before guest start; destination cleaned",
      };
      const { client, transport } = fixture(reply);
      expect(yield* client.inspect(operationID, generation)).toEqual(reply);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
    }),
);

describe("cold recovery receipts", () => {
  const proof = {
    version: 1,
    preparedBuildID: status.preparedBuildID,
    rootfsSHA256: "a".repeat(64),
    initSHA256: "b".repeat(64),
    physicalStopConfirmed: true,
    mountOnly: true,
  };
  it.effect("retains a cold proof tied to the exact prepared allocation", () =>
    Effect.gen(function* () {
      const { client } = fixture({ ...status, state: "prepared", coldProbe: proof });
      expect((yield* client.prepare(operationID, input)).coldProbe).toEqual(proof);
    }),
  );
  for (const [name, bad] of Object.entries({
    "foreign build": { ...proof, preparedBuildID: status.executionID },
    "unconfirmed stop": { ...proof, physicalStopConfirmed: false },
    "missing stop": { ...proof, physicalStopConfirmed: undefined },
    "bad checksum": { ...proof, rootfsSHA256: "not-a-checksum" },
    "bad verifier": { ...proof, initSHA256: "not-a-checksum" },
    "wrong proof mode": { ...proof, mountOnly: false },
  }))
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const { client } = fixture({ ...status, state: "prepared", coldProbe: bad });
        expect((yield* Effect.flip(client.prepare(operationID, input))).reason).toMatch(
          /response|identity/,
        );
      }),
    );
});

describe("damaged execution retention before recovery", () => {
  it.effect(
    "recognizes only a definitive missing alias while keeping template/transport uncertainty",
    () =>
      Effect.gen(function* () {
        const { client, transport } = fixture();
        transport.mockResolvedValueOnce(new Response(null, { status: 404 }));
        expect(yield* client.resolveStoppedNamedSnapshot("owned-capture")).toBeNull();
        transport.mockResolvedValueOnce(new Response(null, { status: 503 }));
        yield* Effect.flip(client.resolveStoppedNamedSnapshot("owned-capture"));
        transport.mockResolvedValueOnce(Response.json({ templateID: "immutable-owned" }));
        transport.mockResolvedValueOnce(new Response(null, { status: 404 }));
        yield* Effect.flip(client.resolveStoppedNamedSnapshot("owned-capture"));
      }),
  );
  it.effect(
    "resolves ready or failed stopped captures to exact immutable identities without creating",
    () =>
      Effect.gen(function* () {
        const { client, transport } = fixture();
        for (const state of ["ready", "error"]) {
          transport.mockResolvedValueOnce(Response.json({ templateID: "immutable-owned" }));
          transport.mockResolvedValueOnce(
            Response.json({
              templateID: "immutable-owned",
              names: ["team/owned-capture:default"],
              builds: [{ buildID: status.preparedBuildID, status: state }],
            }),
          );
          expect(yield* client.resolveStoppedNamedSnapshot("owned-capture")).toEqual({
            snapshotId: "immutable-owned",
            sourceTemplateID: "immutable-owned",
            sourceBuildID: status.preparedBuildID,
          });
        }
        expect(transport.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
      }),
  );
  it.effect("refuses an unfinished or foreign stopped-capture alias before deletion", () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      for (const reply of [
        {
          templateID: "immutable-owned",
          names: ["team/owned-capture"],
          builds: [{ buildID: status.preparedBuildID, status: "building" }],
        },
        {
          templateID: "immutable-owned",
          names: ["team/foreign"],
          builds: [{ buildID: status.preparedBuildID, status: "ready" }],
        },
      ]) {
        transport.mockResolvedValueOnce(Response.json({ templateID: "immutable-owned" }));
        transport.mockResolvedValueOnce(Response.json(reply));
        yield* Effect.flip(client.resolveStoppedNamedSnapshot("owned-capture"));
      }
    }),
  );
  const candidate = {
    sandboxID: "damaged-vm",
    executionID: status.executionID,
    buildID: status.preparedBuildID,
    metadata: {
      "launchpad.managed": "thread-vm-v1",
      "launchpad.allocation_id": "allocation",
      "launchpad.operation_id": "provision",
      "launchpad.thread_id": "thread",
      "launchpad.generation": "2",
    },
    disposition: "ready_tip" as const,
  };
  const retained = {
    ...candidate,
    version: 1 as const,
    kind: "retained_for_stop" as const,
    recoveryOperationID: operationID,
    retainedTemplateID: "retained-template",
    retainedBuildIDs: [candidate.buildID],
    requestSHA256: "a".repeat(64),
  };
  it.effect(
    "requires explicit native retention capability without dispatching any execution request",
    () =>
      Effect.gen(function* () {
        const { client, transport } = fixture({
          version: 1,
          diskRestore: true,
          quiescedSnapshots: true,
          renewableLifetime: true,
        });
        expect(yield* Effect.flip(client.requireExecutionRetention())).toMatchObject({
          reason: "unsupported",
        });
        expect(transport).toHaveBeenCalledTimes(1);
        expect(transport.mock.lastCall?.[1]?.method).toBe("GET");
        transport.mockResolvedValueOnce(
          Response.json({
            version: 1,
            diskRestore: true,
            quiescedSnapshots: true,
            renewableLifetime: true,
            executionRetention: true,
          }),
        );
        yield* client.requireExecutionRetention();
      }),
  );
  it.effect("binds candidate, retained roots and physical stop as three different receipts", () =>
    Effect.gen(function* () {
      const { client, transport } = fixture(candidate);
      expect(yield* client.retentionCandidate(candidate.sandboxID)).toEqual(candidate);
      transport.mockResolvedValueOnce(Response.json(retained));
      expect(yield* client.retainForStop(operationID, candidate)).toEqual(retained);
      expect(yield* decodeJson(String(transport.mock.lastCall?.[1]?.body))).toEqual({
        executionID: candidate.executionID,
        buildID: candidate.buildID,
        metadata: candidate.metadata,
      });
      expect(transport.mock.lastCall?.[1]?.method).toBe("PUT");
      transport.mockResolvedValueOnce(
        Response.json({ sandboxID: candidate.sandboxID, physicallyStopped: true }),
      );
      expect(yield* client.stopRetained(retained)).toEqual({
        ...retained,
        physicallyStopped: true,
      });
    }),
  );
  for (const [name, reply] of Object.entries({
    execution: { ...retained, executionID: operationID },
    sandbox: { ...retained, sandboxID: "foreign" },
    operation: { ...retained, recoveryOperationID: status.executionID },
    build: { ...retained, buildID: status.executionID },
    metadata: { ...retained, metadata: { ...candidate.metadata, "launchpad.generation": "3" } },
    roots: { ...retained, retainedBuildIDs: [] },
    template: { ...retained, retainedTemplateID: null },
    kind: { ...retained, kind: "paused" },
  }))
    it.effect(`rejects ${name} retention mismatch before stop`, () =>
      Effect.gen(function* () {
        const { client, transport } = fixture(reply);
        yield* Effect.flip(client.retainForStop(operationID, candidate));
        expect(transport).toHaveBeenCalledTimes(1);
      }),
    );
  it.effect(
    "allows no-current-tip only as authoritative empty preservation, not as physical absence",
    () =>
      Effect.gen(function* () {
        const empty = { ...candidate, buildID: null, disposition: "no_current_tip" as const },
          receipt = { ...retained, ...empty, retainedTemplateID: null, retainedBuildIDs: [] };
        const { client, transport } = fixture(receipt);
        expect(yield* client.retainForStop(operationID, empty)).toEqual(receipt);
        transport.mockResolvedValueOnce(Response.json({ sandboxID: empty.sandboxID }));
        yield* Effect.flip(client.stopRetained(receipt));
      }),
  );
  it.effect("only exposes the explicit no-commit CAS code and keeps plain failures uncertain", () =>
    Effect.gen(function* () {
      const { client, transport } = fixture();
      for (const code of ["retention_candidate_changed", "foreign", ""]) {
        transport.mockResolvedValueOnce(Response.json({ code }, { status: 409 }));
        const error = yield* Effect.flip(client.retainForStop(operationID, candidate));
        expect(error.nativeCode).toBe(code === "retention_candidate_changed" ? code : undefined);
        expect(error.status).toBe(409);
      }
    }),
  );
});
