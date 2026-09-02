import { RelayEnvironmentPrincipal } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import * as RelayConfiguration from "../Config.ts";
import * as RelaySecretBox from "../auth/SecretBox.ts";
import * as Machines from "../machines/Machines.ts";
import * as ProviderAccounts from "../tenancy/ProviderAccounts.ts";
import {
  openProviderAccountPayload,
  openProviderAccountsForExecutor,
  sealProviderAccountPayload,
} from "./ProviderAccountsApi.ts";

const timestamp = "2026-09-02T00:00:00.000Z";

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  github: undefined,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

const secretBoxLayer = RelaySecretBox.layer.pipe(
  Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings)),
);

const principal = { environmentId: "environment-1", environmentPublicKey: "public-key-1" };

const unexpected = (name: string) => () => Effect.die(`unexpected ${name}`);

function machine(overrides: Partial<Machines.MachineRecord> = {}): Machines.MachineRecord {
  return {
    machineId: "machine-1",
    organizationId: "organization-1",
    role: "agent_executor",
    label: "Executor 1",
    computeKind: "self_hosted",
    computeRef: null,
    seedExpiresAt: timestamp,
    environmentId: "environment-1",
    environmentPublicKey: "public-key-1",
    endpointHttpBaseUrl: null,
    endpointWsBaseUrl: null,
    endpointProviderKind: null,
    createdByUserId: "user-1",
    enrolledAt: timestamp,
    deprovisionedAt: null,
    createdAt: timestamp,
    ...overrides,
  };
}

function machinesLayer(found: Machines.MachineRecord | null) {
  return Layer.succeed(
    Machines.Machines,
    Machines.Machines.of({
      create: unexpected("create"),
      getById: unexpected("getById"),
      listForOrganization: unexpected("listForOrganization"),
      countActiveForOrganization: unexpected("countActiveForOrganization"),
      getBySeedHash: unexpected("getBySeedHash"),
      getActiveByEnvironmentId: () => Effect.succeed(found),
      recordComputeRef: unexpected("recordComputeRef"),
      claimEnrollment: unexpected("claimEnrollment"),
      deprovision: unexpected("deprovision"),
      remove: unexpected("remove"),
    }),
  );
}

function accountsLayer(
  records: ReadonlyArray<ProviderAccounts.ProviderAccountRecord>,
  seen: Array<string>,
) {
  return Layer.succeed(
    ProviderAccounts.ProviderAccounts,
    ProviderAccounts.ProviderAccounts.of({
      listForOrganization: (input) =>
        Effect.sync(() => {
          seen.push(input.organizationId);
          return records;
        }),
      save: unexpected("save"),
      delete: unexpected("delete"),
    }),
  );
}

const codexPayload = {
  kind: "auth_store",
  files: [{ path: "auth.json", content: '{"tokens":{"refresh_token":"r"}}' }],
} as const;

const cursorPayload = { kind: "env", name: "CURSOR_API_KEY", value: "key_123" } as const;

describe("provider account payloads", () => {
  it.effect("round-trip through the secret box", () =>
    Effect.gen(function* () {
      const sealed = yield* sealProviderAccountPayload(codexPayload);
      expect(sealed).not.toContain("refresh_token");
      const opened = yield* openProviderAccountPayload({
        organizationId: "organization-1",
        provider: "codex",
        kind: "auth_store",
        label: "someone@example.test",
        payloadSealed: sealed,
        version: "v1",
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      expect(opened).toEqual(codexPayload);
    }).pipe(Effect.provide(secretBoxLayer)),
  );
});

describe("openProviderAccountsForExecutor", () => {
  it.effect("opens every account of the executor's organization", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const codexSealed = yield* sealProviderAccountPayload(codexPayload);
      const cursorSealed = yield* sealProviderAccountPayload(cursorPayload);
      const record = (
        provider: ProviderAccounts.ProviderAccountRecord["provider"],
        kind: ProviderAccounts.ProviderAccountRecord["kind"],
        payloadSealed: string,
      ): ProviderAccounts.ProviderAccountRecord => ({
        organizationId: "organization-1",
        provider,
        kind,
        label: `${provider} account`,
        payloadSealed,
        version: `${provider}-v1`,
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const result = yield* openProviderAccountsForExecutor({
        environmentId: "environment-1",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            machinesLayer(machine()),
            accountsLayer(
              [record("codex", "auth_store", codexSealed), record("cursor", "env", cursorSealed)],
              seen,
            ),
          ),
        ),
      );
      expect(seen).toEqual(["organization-1"]);
      expect(result.accounts).toEqual([
        { provider: "codex", label: "codex account", version: "codex-v1", payload: codexPayload },
        {
          provider: "cursor",
          label: "cursor account",
          version: "cursor-v1",
          payload: cursorPayload,
        },
      ]);
    }).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, principal),
      Effect.provide(secretBoxLayer),
    ),
  );

  it.effect("refuses anything that is not an enrolled agent executor", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const error = yield* Effect.flip(
        openProviderAccountsForExecutor({ environmentId: "environment-1" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              machinesLayer(machine({ role: "review_host" })),
              accountsLayer([], seen),
            ),
          ),
        ),
      );
      expect(error).toBeInstanceOf(HttpApiError.Unauthorized);
      expect(seen).toEqual([]);
    }).pipe(
      Effect.provideService(RelayEnvironmentPrincipal, principal),
      Effect.provide(secretBoxLayer),
    ),
  );
});
