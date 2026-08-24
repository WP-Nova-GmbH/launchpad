import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";

import {
  RelayCloudDispatchJobProofPayload,
  RelayCloudDispatchJobRequest,
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudMintCredentialProofPayload,
  RelayEnvironmentDispatchJobResponse,
  RelayEnvironmentDispatchJobResponseProofPayload,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentHealthResponseProofPayload,
  RelayEnvironmentMintResponse,
  RelayEnvironmentMintResponseProofPayload,
  RelayJobId,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  RELAY_DISPATCH_JOB_RESPONSE_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_RESPONSE_TYP,
} from "@t3tools/shared/relayJwt";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as Machines from "../machines/Machines.ts";
import * as Organizations from "../tenancy/Organizations.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentConnector from "./EnvironmentConnector.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const environmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const otherEnvironmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const decodeHealthRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayCloudEnvironmentHealthRequest),
);
const decodeMintRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayCloudMintCredentialRequest),
);
const decodeDispatchJobRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayCloudDispatchJobRequest),
);
const isEnvironmentConnectNotAuthorized = Schema.is(
  EnvironmentConnector.EnvironmentConnectNotAuthorized,
);

function requestBodyText(request: HttpClientRequest.HttpClientRequest): string {
  return request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
}

const settings = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(cloudKeyPair.privateKey),
  cloudMintPublicKey: cloudKeyPair.publicKey,
  github: undefined,
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: undefined,
});

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${encodedPayload}`;
  return `${input}.${NodeCrypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

function decodeRequestProof<T>(proof: string): T {
  const payload = proof.split(".")[1];
  if (!payload) throw new Error("Missing JWT payload.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}

function signMintResponse(
  request: RelayCloudMintCredentialRequest,
  overrides: Partial<RelayEnvironmentMintResponseProofPayload> = {},
  privateKey = environmentKeyPair.privateKey,
): RelayEnvironmentMintResponse {
  const requestProof = decodeRequestProof<RelayCloudMintCredentialProofPayload>(request.proof);
  const payload = {
    iss: `t3-env:${requestProof.environmentId}`,
    aud: "https://relay.example.test",
    sub: requestProof.environmentId,
    jti: "mint-response-jti",
    iat: requestProof.iat,
    exp: requestProof.exp,
    environmentId: requestProof.environmentId,
    clientProofKeyThumbprint: requestProof.clientProofKeyThumbprint,
    requestNonce: requestProof.nonce,
    credential: "pairing_credential",
    ...overrides,
  } satisfies RelayEnvironmentMintResponseProofPayload;
  return {
    credential: payload.credential,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(payload.exp * 1_000)),
    proof: signTestJwt(payload, RELAY_MINT_RESPONSE_TYP, privateKey),
  };
}

function signHealthResponse(
  request: RelayCloudEnvironmentHealthRequest,
  privateKey = environmentKeyPair.privateKey,
  overrides: Partial<RelayEnvironmentHealthResponse> = {},
  payloadOverrides: Partial<RelayEnvironmentHealthResponseProofPayload> = {},
): RelayEnvironmentHealthResponse {
  const requestProof = decodeRequestProof<RelayCloudEnvironmentHealthProofPayload>(request.proof);
  const payload = {
    iss: `t3-env:${requestProof.environmentId}`,
    aud: "https://relay.example.test",
    sub: requestProof.environmentId,
    jti: "health-response-jti",
    iat: requestProof.iat,
    exp: requestProof.exp,
    environmentId: requestProof.environmentId,
    requestNonce: requestProof.nonce,
    status: "online",
    descriptor: {
      environmentId: requestProof.environmentId,
      label: "Connector Test Environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(requestProof.iat * 1_000)),
    ...payloadOverrides,
  } satisfies RelayEnvironmentHealthResponseProofPayload;
  return {
    environmentId: payload.environmentId,
    status: "online",
    descriptor: payload.descriptor,
    checkedAt: payload.checkedAt,
    proof: signTestJwt(payload, RELAY_HEALTH_RESPONSE_TYP, privateKey),
    ...overrides,
  };
}

function signDispatchJobResponse(
  request: RelayCloudDispatchJobRequest,
  overrides: Partial<RelayEnvironmentDispatchJobResponseProofPayload> = {},
  bodyOverrides: Partial<RelayEnvironmentDispatchJobResponse> = {},
  privateKey = environmentKeyPair.privateKey,
): RelayEnvironmentDispatchJobResponse {
  const requestProof = decodeRequestProof<RelayCloudDispatchJobProofPayload>(request.proof);
  const payload = {
    iss: `t3-env:${requestProof.environmentId}`,
    aud: "https://relay.example.test",
    sub: requestProof.environmentId,
    jti: "dispatch-job-response-jti",
    iat: requestProof.iat,
    exp: requestProof.exp,
    environmentId: requestProof.environmentId,
    jobId: requestProof.jobId,
    accepted: true,
    ...overrides,
  } satisfies RelayEnvironmentDispatchJobResponseProofPayload;
  return {
    accepted: payload.accepted,
    proof: signTestJwt(payload, RELAY_DISPATCH_JOB_RESPONSE_TYP, privateKey),
    ...bodyOverrides,
  };
}

function connectorTestLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
  options?: {
    readonly links?: EnvironmentLinks.EnvironmentLinks["Service"];
    readonly allocations?: ManagedEndpointAllocations.ManagedEndpointAllocations["Service"];
    readonly machine?: Machines.MachineRecord | null;
    readonly membershipOrganizationId?: string | null;
    readonly allowLocalMachineEndpoints?: boolean;
  },
) {
  const unexpectedMachineCall = () => Effect.die("unexpected machine store call");
  const unexpectedOrganizationCall = () => Effect.die("unexpected organization call");
  return EnvironmentConnector.layer.pipe(
    Layer.provide(NodeCryptoLayer.layer),
    Layer.provide(Layer.succeed(EnvironmentLinks.EnvironmentLinks, options?.links ?? makeLinks())),
    Layer.provide(
      Layer.succeed(
        ManagedEndpointAllocations.ManagedEndpointAllocations,
        options?.allocations ?? makeAllocations(),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Machines.Machines,
        Machines.Machines.of({
          create: unexpectedMachineCall,
          getById: unexpectedMachineCall,
          listForOrganization: unexpectedMachineCall,
          countActiveForOrganization: unexpectedMachineCall,
          getBySeedHash: unexpectedMachineCall,
          getActiveByEnvironmentId: () => Effect.succeed(options?.machine ?? null),
          recordComputeRef: unexpectedMachineCall,
          claimEnrollment: unexpectedMachineCall,
          deprovision: unexpectedMachineCall,
          remove: unexpectedMachineCall,
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Organizations.Organizations,
        Organizations.Organizations.of({
          ensureForUser: unexpectedOrganizationCall,
          getMembershipForUser: ({ userId }) =>
            Effect.succeed(
              options?.membershipOrganizationId == null
                ? null
                : {
                    organization: {
                      organizationId: options.membershipOrganizationId,
                      name: "Acme",
                      createdAt: "2026-08-19T00:00:00.000Z",
                    },
                    userId,
                    role: "member" as const,
                    joinedAt: "2026-08-19T00:00:00.000Z",
                  },
            ),
          listMembers: unexpectedOrganizationCall,
          countAdmins: unexpectedOrganizationCall,
          countMembers: unexpectedOrganizationCall,
          updateMemberRole: unexpectedOrganizationCall,
          removeMember: unexpectedOrganizationCall,
          addMember: unexpectedOrganizationCall,
          rename: unexpectedOrganizationCall,
          deleteOrganization: unexpectedOrganizationCall,
        }),
      ),
    ),
    Layer.provide(
      RelayConfiguration.layer({
        ...settings,
        ...(options?.allowLocalMachineEndpoints === undefined
          ? {}
          : { allowLocalMachineEndpoints: options.allowLocalMachineEndpoints }),
      }),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
  );
}

function makeAllocations(
  allocation: ManagedEndpointAllocations.ManagedEndpointAllocation | null = {
    userId: "user_123",
    environmentId: "env-connector-test",
    hostname: "env.example.test",
    tunnelId: "tunnel-id",
    tunnelName: "tunnel-name",
    dnsRecordId: "dns-record-id",
    readyAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
  },
): ManagedEndpointAllocations.ManagedEndpointAllocations["Service"] {
  return {
    get: () => Effect.succeed(allocation),
    reserve: () => Effect.die("unused"),
    recordTunnel: () => Effect.die("unused"),
    recordDns: () => Effect.die("unused"),
    markReady: () => Effect.die("unused"),
    claimRelease: () => Effect.die("unused"),
    claimDeprovision: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    removeClaimed: () => Effect.die("unused"),
  };
}

function makeLinks(
  overrides: Partial<EnvironmentLinks.RelayLinkedEnvironmentRecord> = {},
): EnvironmentLinks.EnvironmentLinks["Service"] {
  return {
    upsert: () => Effect.void,
    listUsersForEnvironment: () => Effect.succeed([]),
    listDeliveryUsersForEnvironment: () => Effect.succeed([]),
    listPublicKeysForEnvironment: () => Effect.succeed([environmentKeyPair.publicKey]),
    listForUser: () => Effect.succeed([]),
    getForUser: () =>
      Effect.succeed({
        environmentId: "env-connector-test" as never,
        label: "Connector Test Environment",
        endpoint: {
          httpBaseUrl: "https://env.example.test/",
          wsBaseUrl: "wss://env.example.test/ws",
          providerKind: "cloudflare_tunnel",
        },
        linkedAt: "2026-05-25T00:00:00.000Z",
        environmentPublicKey: environmentKeyPair.publicKey,
        ...overrides,
      }),
    revokeForUser: () => Effect.succeed(false),
  };
}

describe("EnvironmentConnector", () => {
  it.effect("loads the environment link and managed allocation concurrently", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);
      const bothStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waitForPeer = Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(started, (value) => value + 1);
        if (count === 2) {
          yield* Deferred.succeed(bothStarted, undefined);
        }
        yield* Deferred.await(release);
      });
      const links = makeLinks();
      const allocations = makeAllocations();
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.sync(() => {
          const healthRequest = decodeHealthRequestBody(requestBodyText(request));
          return HttpClientResponse.fromWeb(
            request,
            Response.json(signHealthResponse(healthRequest), { status: 200 }),
          );
        });
      const status = Effect.gen(function* () {
        const connector = yield* EnvironmentConnector.EnvironmentConnector;
        return yield* connector.status({
          userId: "user_123",
          environmentId: "env-connector-test" as never,
        });
      }).pipe(
        Effect.provide(
          connectorTestLayer(execute, {
            links: {
              ...links,
              getForUser: (input) => waitForPeer.pipe(Effect.andThen(links.getForUser(input))),
            },
            allocations: {
              ...allocations,
              get: (input) => waitForPeer.pipe(Effect.andThen(allocations.get(input))),
            },
          }),
        ),
      );

      const fiber = yield* Effect.forkChild(status);
      yield* Deferred.await(bothStarted);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);

      expect(yield* Ref.get(started)).toBe(2);
    }),
  );

  it.effect("checks linked environment health through the managed endpoint", () => {
    const seenUrls: Array<string> = [];
    const seenProofs: Array<RelayCloudEnvironmentHealthProofPayload> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        seenUrls.push(request.url);
        seenProofs.push(decodeRequestProof(healthRequest.proof));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signHealthResponse(healthRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.status({
        userId: "user_123",
        environmentId: "env-connector-test",
      });

      expect(seenUrls).toEqual(["https://env.example.test/api/t3-connect/health"]);
      expect(seenProofs[0]).toMatchObject({
        iss: "https://relay.example.test",
        aud: "t3-env:env-connector-test",
        sub: "user_123",
        environmentId: "env-connector-test",
        scope: ["environment:status"],
      });
      expect(result).toMatchObject({
        environmentId: "env-connector-test",
        status: "online",
        descriptor: {
          environmentId: "env-connector-test",
          label: "Connector Test Environment",
        },
      });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects manual endpoints before sending a health request", () => {
    let requestCount = 0;
    const execute = () =>
      Effect.sync(() => {
        requestCount += 1;
        throw new Error("unexpected request");
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.result(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentConnectNotAuthorized(result.failure)).toBe(true);
        if (isEnvironmentConnectNotAuthorized(result.failure)) {
          expect(result.failure).toMatchObject({
            operation: "status",
            reason: "endpoint_provider_not_managed",
          });
        }
      }
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            endpoint: {
              httpBaseUrl: "https://127.0.0.1/",
              wsBaseUrl: "wss://127.0.0.1/ws",
              providerKind: "manual",
            },
          }),
        }),
      ),
    );
  });

  it.effect("checks a relay-provisioned Docker machine through its local endpoint in dev", () => {
    const seenUrls: Array<string> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        seenUrls.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signHealthResponse(healthRequest), { status: 200 }),
        );
      });
    const machine: Machines.MachineRecord = {
      machineId: "machine-local",
      organizationId: "organization-1",
      role: "agent_executor",
      label: "Local Docker Executor",
      computeKind: "docker",
      computeRef: "container-local",
      seedExpiresAt: "2100-01-01T00:00:00.000Z",
      environmentId: "env-connector-test",
      environmentPublicKey: environmentKeyPair.publicKey,
      endpointHttpBaseUrl: "http://127.0.0.1:23000",
      endpointWsBaseUrl: "ws://127.0.0.1:23000",
      endpointProviderKind: "manual",
      createdByUserId: "user_admin",
      enrolledAt: "2026-08-19T01:00:00.000Z",
      deprovisionedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
    };

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.status({
        userId: "user_member",
        environmentId: "env-connector-test",
      });

      expect(seenUrls).toEqual(["http://127.0.0.1:23000/api/t3-connect/health"]);
      expect(result).toMatchObject({
        environmentId: "env-connector-test",
        endpoint: {
          httpBaseUrl: "http://127.0.0.1:23000",
          wsBaseUrl: "ws://127.0.0.1:23000",
          providerKind: "manual",
        },
        status: "online",
      });
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: {
            ...makeLinks(),
            getForUser: () => Effect.succeed(null),
          },
          allocations: makeAllocations(null),
          machine,
          membershipOrganizationId: "organization-1",
          allowLocalMachineEndpoints: true,
        }),
      ),
    );
  });

  it.effect("rejects a non-loopback manual endpoint from a machine in dev", () => {
    let requestCount = 0;
    const execute = () =>
      Effect.sync(() => {
        requestCount += 1;
        throw new Error("unexpected request");
      });
    const machine: Machines.MachineRecord = {
      machineId: "machine-local",
      organizationId: "organization-1",
      role: "agent_executor",
      label: "Local Docker Executor",
      computeKind: "docker",
      computeRef: "container-local",
      seedExpiresAt: "2100-01-01T00:00:00.000Z",
      environmentId: "env-connector-test",
      environmentPublicKey: environmentKeyPair.publicKey,
      endpointHttpBaseUrl: "http://attacker.example.test:23000",
      endpointWsBaseUrl: "ws://attacker.example.test:23000",
      endpointProviderKind: "manual",
      createdByUserId: "user_admin",
      enrolledAt: "2026-08-19T01:00:00.000Z",
      deprovisionedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
    };

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.result(
        connector.status({
          userId: "user_member",
          environmentId: "env-connector-test",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          operation: "status",
          reason: "endpoint_provider_not_managed",
        });
      }
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: {
            ...makeLinks(),
            getForUser: () => Effect.succeed(null),
          },
          allocations: makeAllocations(null),
          machine,
          membershipOrganizationId: "organization-1",
          allowLocalMachineEndpoints: true,
        }),
      ),
    );
  });

  it.effect("rejects stale managed endpoints before sending a mint request", () => {
    let requestCount = 0;
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const execute = () =>
      Effect.sync(() => {
        requestCount += 1;
        throw new Error("unexpected request");
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.result(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentConnectNotAuthorized(result.failure)).toBe(true);
        if (isEnvironmentConnectNotAuthorized(result.failure)) {
          expect(result.failure).toMatchObject({
            operation: "connect",
            reason: "managed_endpoint_mismatch",
          });
        }
      }
      const resolutionSpan = spans.find(
        (span) => span.name === "relay.environment_connector.resolve_managed_endpoint",
      );
      expect(Object.fromEntries(resolutionSpan?.attributes ?? [])).toMatchObject({
        "relay.authorization.allocation_hostname": "env.example.test",
        "relay.authorization.allocation_has_ready_at": true,
        "relay.authorization.allocation_has_tunnel_id": true,
        "relay.authorization.allocation_has_dns_record_id": true,
        "relay.authorization.linked_http_base_url": "https://attacker.example.test/",
        "relay.authorization.linked_ws_base_url": "wss://attacker.example.test/ws",
        "relay.authorization.resolved_http_base_url": "https://env.example.test/",
        "relay.authorization.resolved_ws_base_url": "wss://env.example.test/ws",
      });
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            endpoint: {
              httpBaseUrl: "https://attacker.example.test/",
              wsBaseUrl: "wss://attacker.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
          }),
        }),
      ),
      Effect.provideService(Tracer.Tracer, tracer),
    );
  });

  it.effect("rejects unready managed endpoint allocations before sending a request", () => {
    let requestCount = 0;
    const execute = () =>
      Effect.sync(() => {
        requestCount += 1;
        throw new Error("unexpected request");
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.result(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentConnectNotAuthorized(result.failure)).toBe(true);
        if (isEnvironmentConnectNotAuthorized(result.failure)) {
          expect(result.failure).toMatchObject({
            operation: "status",
            reason: "managed_endpoint_allocation_not_ready",
          });
        }
      }
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          allocations: makeAllocations({
            userId: "user_123",
            environmentId: "env-connector-test",
            hostname: "env.example.test",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
            dnsRecordId: "dns-record-id",
            readyAt: null,
            updatedAt: "2026-05-25T00:00:00.000Z",
          }),
        }),
      ),
    );
  });

  it.effect("rejects signed health responses with stale checkedAt timestamps", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signHealthResponse(
              healthRequest,
              environmentKeyPair.privateKey,
              {},
              {
                checkedAt: "2026-05-24T00:00:00.000Z",
              },
            ),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("reports offline status when the managed endpoint health request fails", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              _tag: "EnvironmentHttpInternalServerError",
              message: "Environment is unavailable.",
            },
            { status: 500 },
          ),
        ),
      );

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.status({
        userId: "user_123",
        environmentId: "env-connector-test",
      });

      expect(result).toMatchObject({
        environmentId: "env-connector-test",
        status: "offline",
        error: "Managed endpoint health request failed: Environment is unavailable.",
        traceId: expect.any(String),
      });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects health responses with a mismatched top-level environment id", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signHealthResponse(healthRequest, environmentKeyPair.privateKey, {
              environmentId: "other-env" as RelayEnvironmentHealthResponse["environmentId"],
            }),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects health responses with an unsigned top-level descriptor mutation", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        const response = signHealthResponse(healthRequest);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              ...response,
              descriptor: {
                ...response.descriptor,
                label: "Tampered Environment Label",
              },
            } satisfies RelayEnvironmentHealthResponse,
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects health responses when the linked environment public key is malformed", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signHealthResponse(healthRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            environmentPublicKey: "not a pem public key",
          }),
        }),
      ),
    );
  });

  it.effect("mints a one-time environment credential through the linked endpoint", () => {
    const seenUrls: Array<string> = [];
    const seenProofs: Array<RelayCloudMintCredentialProofPayload> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        seenUrls.push(request.url);
        seenProofs.push(decodeRequestProof(mintRequest.proof));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signMintResponse(mintRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.connect({
        userId: "user_123",
        environmentId: "env-connector-test",
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        deviceId: "device-123",
      });

      expect(seenUrls).toEqual(["https://env.example.test/api/t3-connect/mint-credential"]);
      expect(seenProofs[0]).toMatchObject({
        iss: "https://relay.example.test",
        aud: "t3-env:env-connector-test",
        sub: "user_123",
        environmentId: "env-connector-test",
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        cnf: { jkt: "client-proof-key-thumbprint" },
        deviceId: "device-123",
        scope: ["environment:connect"],
      });
      expect(result).toMatchObject({
        environmentId: "env-connector-test",
        credential: "pairing_credential",
        endpoint: {
          httpBaseUrl: "https://env.example.test/",
          wsBaseUrl: "wss://env.example.test/ws",
        },
      });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("only accepts mint responses signed by the user's linked environment key", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signMintResponse(mintRequest, {}, otherEnvironmentKeyPair.privateKey), {
            status: 200,
          }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects mint responses when the linked environment public key is malformed", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signMintResponse(mintRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            environmentPublicKey: "not a pem public key",
          }),
        }),
      ),
    );
  });

  it.effect("rejects environment mint responses with an overlong credential window", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { ...signMintResponse(mintRequest), expiresAt: "2999-01-01T00:00:00.000Z" },
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("dispatches a signed job and takes the environment's signed acceptance", () => {
    const seenUrls: Array<string> = [];
    const seenProofs: Array<RelayCloudDispatchJobProofPayload> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const dispatchRequest = decodeDispatchJobRequestBody(requestBodyText(request));
        seenUrls.push(request.url);
        seenProofs.push(decodeRequestProof(dispatchRequest.proof));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signDispatchJobResponse(dispatchRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.dispatchJob({
        userId: "user_123",
        environmentId: "env-connector-test",
        jobId: RelayJobId.make("job-connector-test"),
        repositoryCanonicalKey: "github.com/acme/app",
        baseBranch: "main",
        instruction: "Fix the flaky login test.",
      });

      expect(seenUrls).toEqual(["https://env.example.test/api/t3-connect/dispatch-job"]);
      expect(seenProofs[0]).toMatchObject({
        iss: "https://relay.example.test",
        aud: "t3-env:env-connector-test",
        sub: "user_123",
        environmentId: "env-connector-test",
        jobId: "job-connector-test",
        repositoryCanonicalKey: "github.com/acme/app",
        baseBranch: "main",
        instruction: "Fix the flaky login test.",
      });
      expect(result).toEqual({ accepted: true });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("reports a signed refusal as a refusal rather than a failure", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const dispatchRequest = decodeDispatchJobRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signDispatchJobResponse(dispatchRequest, { accepted: false }), {
            status: 200,
          }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      expect(
        yield* connector.dispatchJob({
          userId: "user_123",
          environmentId: "env-connector-test",
          jobId: RelayJobId.make("job-connector-test"),
          repositoryCanonicalKey: "github.com/acme/app",
          baseBranch: "main",
          instruction: "Fix the flaky login test.",
        }),
      ).toEqual({ accepted: false });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects a refusal the unsigned response body flipped to accepted", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const dispatchRequest = decodeDispatchJobRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signDispatchJobResponse(dispatchRequest, { accepted: false }, { accepted: true }),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.dispatchJob({
          userId: "user_123",
          environmentId: "env-connector-test",
          jobId: RelayJobId.make("job-connector-test"),
          repositoryCanonicalKey: "github.com/acme/app",
          baseBranch: "main",
          instruction: "Fix the flaky login test.",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects dispatch answers bound to a different job", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const dispatchRequest = decodeDispatchJobRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signDispatchJobResponse(dispatchRequest, {
              jobId: RelayJobId.make("some-other-job"),
            }),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.dispatchJob({
          userId: "user_123",
          environmentId: "env-connector-test",
          jobId: RelayJobId.make("job-connector-test"),
          repositoryCanonicalKey: "github.com/acme/app",
          baseBranch: "main",
          instruction: "Fix the flaky login test.",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("only accepts dispatch answers signed by the user's linked environment key", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const dispatchRequest = decodeDispatchJobRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signDispatchJobResponse(dispatchRequest, {}, {}, otherEnvironmentKeyPair.privateKey),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.dispatchJob({
          userId: "user_123",
          environmentId: "env-connector-test",
          jobId: RelayJobId.make("job-connector-test"),
          repositoryCanonicalKey: "github.com/acme/app",
          baseBranch: "main",
          instruction: "Fix the flaky login test.",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("gives up on a hung dispatch well inside the relay's request deadline", () => {
    let resolveRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = () => resolve();
    });
    const execute = () =>
      Effect.sync(() => {
        resolveRequestStarted?.();
      }).pipe(Effect.andThen(Effect.never as Effect.Effect<HttpClientResponse.HttpClientResponse>));

    // The handler still has to record the outcome on the job inside the relay's
    // 9s request deadline, so the transport budget has to leave room for it.
    expect(EnvironmentConnector.ENVIRONMENT_DISPATCH_JOB_REQUEST_TIMEOUT_MS).toBeLessThan(9_000);

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const resultFiber = yield* connector
        .dispatchJob({
          userId: "user_123",
          environmentId: "env-connector-test",
          jobId: RelayJobId.make("job-connector-test"),
          repositoryCanonicalKey: "github.com/acme/app",
          baseBranch: "main",
          instruction: "Fix the flaky login test.",
        })
        .pipe(Effect.result, Effect.forkScoped);

      yield* Effect.promise(() => requestStarted);
      yield* TestClock.adjust(
        Duration.millis(EnvironmentConnector.ENVIRONMENT_DISPATCH_JOB_REQUEST_TIMEOUT_MS),
      );
      const result = yield* Fiber.join(resultFiber);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("EnvironmentMintRequestTimedOut");
        expect(result.failure).toMatchObject({
          environmentId: "env-connector-test",
          operation: "dispatch-job",
          timeoutMs: EnvironmentConnector.ENVIRONMENT_DISPATCH_JOB_REQUEST_TIMEOUT_MS,
        });
      }
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), connectorTestLayer(execute))));
  });

  it.effect("times out hung managed endpoint mint requests", () => {
    let resolveRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = () => resolve();
    });
    const execute = () =>
      Effect.sync(() => {
        resolveRequestStarted?.();
      }).pipe(Effect.andThen(Effect.never as Effect.Effect<HttpClientResponse.HttpClientResponse>));

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const resultFiber = yield* connector
        .connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        })
        .pipe(Effect.result, Effect.forkScoped);

      yield* Effect.promise(() => requestStarted);
      yield* TestClock.adjust(
        Duration.millis(EnvironmentConnector.ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS),
      );
      const result = yield* Fiber.join(resultFiber);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("EnvironmentMintRequestTimedOut");
        expect(result.failure).toMatchObject({
          environmentId: "env-connector-test",
          timeoutMs: EnvironmentConnector.ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS,
        });
      }
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), connectorTestLayer(execute))));
  });
});

describe("EnvironmentConnector.resolveAccess", () => {
  const unusedExecute = () => Effect.die("resolveAccess never reaches an environment");
  const noLinks = (): EnvironmentLinks.EnvironmentLinks["Service"] => ({
    ...makeLinks(),
    getForUser: () => Effect.succeed(null),
  });
  const enrolledMachine: Machines.MachineRecord = {
    machineId: "machine-1",
    organizationId: "organization-1",
    role: "agent_executor",
    label: "Executor 1",
    computeKind: "docker",
    computeRef: "container-1",
    seedExpiresAt: "2100-01-01T00:00:00.000Z",
    environmentId: "env-connector-test",
    environmentPublicKey: environmentKeyPair.publicKey,
    endpointHttpBaseUrl: "https://machine.example.test/",
    endpointWsBaseUrl: "wss://machine.example.test/ws",
    endpointProviderKind: "cloudflare_tunnel",
    createdByUserId: "user_admin",
    enrolledAt: "2026-08-19T01:00:00.000Z",
    deprovisionedAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
  };

  it.effect("resolves an enrolled machine for a member of its organization", () =>
    Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const access = yield* connector.resolveAccess({
        userId: "user_member",
        environmentId: "env-connector-test",
        operation: "connect",
      });
      expect(access).toEqual({
        environmentId: "env-connector-test",
        environmentPublicKey: environmentKeyPair.publicKey,
        endpoint: {
          httpBaseUrl: "https://machine.example.test/",
          wsBaseUrl: "wss://machine.example.test/ws",
          providerKind: "cloudflare_tunnel",
        },
        allocationOwnerKey: "org:organization-1",
        source: "machine",
      });
    }).pipe(
      Effect.provide(
        connectorTestLayer(unusedExecute, {
          links: noLinks(),
          machine: enrolledMachine,
          membershipOrganizationId: "organization-1",
        }),
      ),
    ),
  );

  it.effect("answers a non-member exactly like a missing link", () =>
    Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const error = yield* Effect.flip(
        connector.resolveAccess({
          userId: "user_outsider",
          environmentId: "env-connector-test",
          operation: "connect",
        }),
      );
      expect(error).toMatchObject({
        _tag: "EnvironmentConnectNotAuthorized",
        reason: "environment_link_not_found",
      });
    }).pipe(
      Effect.provide(
        connectorTestLayer(unusedExecute, {
          links: noLinks(),
          machine: enrolledMachine,
          membershipOrganizationId: "organization-2",
        }),
      ),
    ),
  );

  it.effect("never resolves a machine that has not enrolled", () =>
    Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const error = yield* Effect.flip(
        connector.resolveAccess({
          userId: "user_member",
          environmentId: "env-connector-test",
          operation: "connect",
        }),
      );
      expect(error).toMatchObject({
        _tag: "EnvironmentConnectNotAuthorized",
        reason: "environment_link_not_found",
      });
    }).pipe(
      Effect.provide(
        connectorTestLayer(unusedExecute, {
          links: noLinks(),
          machine: {
            ...enrolledMachine,
            environmentId: null,
            environmentPublicKey: null,
            endpointHttpBaseUrl: null,
            endpointWsBaseUrl: null,
            endpointProviderKind: null,
            enrolledAt: null,
          },
          membershipOrganizationId: "organization-1",
        }),
      ),
    ),
  );

  it.effect("prefers the caller's own link over the machine path", () =>
    Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const access = yield* connector.resolveAccess({
        userId: "user_123",
        environmentId: "env-connector-test",
        operation: "status",
      });
      expect(access.allocationOwnerKey).toBe("user_123");
      expect(access.source).toBe("link");
    }).pipe(Effect.provide(connectorTestLayer(unusedExecute))),
  );
});
