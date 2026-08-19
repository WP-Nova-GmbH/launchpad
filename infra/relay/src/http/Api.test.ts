import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayEnvironmentAuth, RelayJobId } from "@t3tools/contracts/relay";

import {
  dispatchJobRecord,
  ENVIRONMENT_REJECTED_JOB_DETAIL,
  readJobForUser,
  RELAY_REQUEST_DEADLINE_MS,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  revokeEnvironmentLinkRecord,
  traceRelayHttpRequestWith,
  unlinkEnvironmentRecord,
  verifyRelayClientBearerToken,
  withoutCapturedParentSpan,
} from "./Api.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as Jobs from "../jobs/Jobs.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as Organizations from "../tenancy/Organizations.ts";
import * as Repositories from "../tenancy/Repositories.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

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

describe("relay client authentication", () => {
  it.effect("preserves the existing Clerk session JWT path", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: relaySettings.clerkJwtAudience,
      } as never);

      expect(yield* verifyRelayClientBearerToken(relaySettings, "session-token")).toEqual({
        sub: "user_session",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledWith("session-token", {
        secretKey: "clerk-secret-key",
        audience: relaySettings.clerkJwtAudience,
      });
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );

  it.effect("falls back to Clerk OAuth token verification for the headless CLI", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: true,
          toAuth: () => ({ userId: "user_oauth" }),
        }),
      } as never);

      expect(yield* verifyRelayClientBearerToken(relaySettings, "oauth-token")).toEqual({
        sub: "user_oauth",
        mode: "clerk_oauth_bearer",
      });
      expect(createClerkClient).toHaveBeenCalledWith({
        secretKey: "clerk-secret-key",
        publishableKey: "pk_test_test",
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );
});

describe("relay environment authentication", () => {
  it.effect("preserves credential lookup persistence failures as internal errors", () => {
    const failure = new EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError({
      stage: "lookup-credential",
      cause: "database unavailable",
    });
    const credentials: EnvironmentCredentials.EnvironmentCredentials["Service"] = {
      create: () => Effect.die("unused create"),
      authenticate: () => Effect.fail(failure),
      revokeForEnvironmentPublicKey: () => Effect.die("unused revoke"),
    };

    return Effect.gen(function* () {
      const auth = yield* RelayEnvironmentAuth;
      const error = yield* Effect.flip(
        auth.environmentBearer(Effect.succeed(HttpServerResponse.empty()), {
          credential: Redacted.make("environment-credential"),
          endpoint: {} as never,
          group: {} as never,
        }),
      );

      expect(Predicate.isTagged(error, "RelayInternalError")).toBe(true);
      if (Predicate.isTagged(error, "RelayInternalError")) {
        expect(error.reason).toBe("persistence_failed");
      }
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("https://relay.test/v1/server/link")),
      ),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
      Effect.provideService(HttpRouter.RouteContext, {
        params: {},
        route: {} as never,
      }),
      Effect.provide(
        relayEnvironmentAuthLayer.pipe(
          Layer.provide(Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, credentials)),
        ),
      ),
      Effect.scoped,
    );
  });
});

function relayUnlinkTestLayer(input?: {
  readonly withTransaction?: RelayDb.RelayTransactions["Service"]["withTransaction"];
  readonly getForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["getForUser"];
  readonly revokeForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["revokeForUser"];
  readonly revokeCredential?: EnvironmentCredentials.EnvironmentCredentials["Service"]["revokeForEnvironmentPublicKey"];
  readonly prepareDeprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["prepareDeprovision"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
}) {
  return Layer.mergeAll(
    Layer.succeed(
      RelayDb.RelayTransactions,
      RelayDb.RelayTransactions.of({
        withTransaction: input?.withTransaction ?? ((effect) => effect),
      }),
    ),
    Layer.succeed(
      EnvironmentLinks.EnvironmentLinks,
      EnvironmentLinks.EnvironmentLinks.of({
        upsert: () => Effect.die("unused upsert"),
        listUsersForEnvironment: () => Effect.die("unused listUsersForEnvironment"),
        listDeliveryUsersForEnvironment: () => Effect.die("unused listDeliveryUsersForEnvironment"),
        listPublicKeysForEnvironment: () => Effect.die("unused listPublicKeysForEnvironment"),
        listForUser: () => Effect.die("unused listForUser"),
        getForUser: input?.getForUser ?? (() => Effect.succeed(null)),
        revokeForUser: input?.revokeForUser ?? (() => Effect.succeed(false)),
      }),
    ),
    Layer.succeed(
      EnvironmentCredentials.EnvironmentCredentials,
      EnvironmentCredentials.EnvironmentCredentials.of({
        create: () => Effect.die("unused create"),
        authenticate: () => Effect.die("unused authenticate"),
        revokeForEnvironmentPublicKey: input?.revokeCredential ?? (() => Effect.succeed(false)),
      }),
    ),
    Layer.succeed(
      ManagedEndpointProvider.ManagedEndpointProvider,
      ManagedEndpointProvider.ManagedEndpointProvider.of({
        provision: () => Effect.die("unused provision"),
        prepareDeprovision: input?.prepareDeprovision ?? (() => Effect.succeed(null)),
        deprovision: input?.deprovision ?? (() => Effect.void),
        release: () => Effect.die("unused release"),
      }),
    ),
  );
}

const linkedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Environment 1",
  endpoint: {
    httpBaseUrl: "https://environment-1.example.test/",
    wsBaseUrl: "wss://environment-1.example.test/ws",
    providerKind: "cloudflare_tunnel",
  },
  environmentPublicKey: "public-key",
  linkedAt: "2026-07-28T00:00:00.000Z",
} as const;

describe("relay environment unlink", () => {
  it.effect("revokes the link and its credentials in one database transaction", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      expect(
        yield* revokeEnvironmentLinkRecord({
          userId: "user-1",
          environmentId: "environment-1",
          environmentPublicKey: "public-key",
        }),
      ).toBe(true);
      expect(calls).toEqual(["transaction", "link", "credential"]);
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          withTransaction: (effect) => {
            calls.push("transaction");
            return effect;
          },
          revokeForUser: () =>
            Effect.sync(() => {
              calls.push("link");
              return true;
            }),
          revokeCredential: () =>
            Effect.sync(() => {
              calls.push("credential");
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("commits database revocation before deprovisioning the managed endpoint", () => {
    const calls: Array<string> = [];
    const deprovisionTarget = {
      userId: "user-1",
      environmentId: "environment-1",
      hostname: "environment-1.example.test",
      tunnelId: "tunnel-1",
      tunnelName: "environment-1-tunnel",
      dnsRecordId: "dns-1",
      readyAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "generation-before-unlink",
    } satisfies ManagedEndpointProvider.ManagedEndpointDeprovisionTarget;

    return Effect.gen(function* () {
      expect(
        yield* unlinkEnvironmentRecord({
          userId: "user-1",
          environmentId: "environment-1",
        }),
      ).toBe(true);
      expect(calls).toEqual([
        "prepare",
        "lookup",
        "transaction",
        "link",
        "credential",
        "deprovision",
      ]);
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          withTransaction: (effect) => {
            calls.push("transaction");
            return effect;
          },
          getForUser: () =>
            Effect.sync(() => {
              calls.push("lookup");
              return linkedEnvironmentRecord;
            }),
          revokeForUser: () =>
            Effect.sync(() => {
              calls.push("link");
              return true;
            }),
          revokeCredential: () =>
            Effect.sync(() => {
              calls.push("credential");
              return true;
            }),
          prepareDeprovision: () =>
            Effect.sync(() => {
              calls.push("prepare");
              return deprovisionTarget;
            }),
          deprovision: (request) =>
            Effect.sync(() => {
              expect(request.target).toBe(deprovisionTarget);
              calls.push("deprovision");
            }),
        }),
      ),
    );
  });

  it.effect("does not deprovision when database revocation fails", () => {
    const calls: Array<string> = [];
    const failure = new EnvironmentCredentials.EnvironmentCredentialRevokePersistenceError({
      environmentId: "environment-1",
      cause: "database unavailable",
    });

    return Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          unlinkEnvironmentRecord({
            userId: "user-1",
            environmentId: "environment-1",
          }),
        ),
      ).toBe(failure);
      expect(calls).toEqual(["prepare", "transaction", "link", "credential"]);
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          withTransaction: (effect) => {
            calls.push("transaction");
            return effect;
          },
          getForUser: () => Effect.succeed(linkedEnvironmentRecord),
          revokeForUser: () =>
            Effect.sync(() => {
              calls.push("link");
              return true;
            }),
          revokeCredential: () =>
            Effect.sync(() => {
              calls.push("credential");
            }).pipe(Effect.andThen(Effect.fail(failure))),
          prepareDeprovision: () =>
            Effect.sync(() => {
              calls.push("prepare");
              return null;
            }),
          deprovision: () =>
            Effect.sync(() => {
              calls.push("deprovision");
            }),
        }),
      ),
    );
  });

  it.effect("retries deprovisioning after the link is already revoked", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      expect(
        yield* unlinkEnvironmentRecord({
          userId: "user-1",
          environmentId: "environment-1",
        }),
      ).toBe(false);
      expect(calls).toEqual(["prepare", "deprovision"]);
    }).pipe(
      Effect.provide(
        relayUnlinkTestLayer({
          prepareDeprovision: () =>
            Effect.sync(() => {
              calls.push("prepare");
              return null;
            }),
          deprovision: () =>
            Effect.sync(() => {
              calls.push("deprovision");
            }),
        }),
      ),
    );
  });
});

const queuedJobRecord = {
  jobId: RelayJobId.make("job-1"),
  ownerUserId: "user-1",
  status: "queued",
  environmentId: EnvironmentId.make("environment-1"),
  repositoryCanonicalKey: "github.com/acme/app",
  baseBranch: "main",
  threadId: null,
  detail: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
} satisfies Jobs.RelayJobRecord;

const createJobRequest = {
  environmentId: queuedJobRecord.environmentId,
  repositoryCanonicalKey: queuedJobRecord.repositoryCanonicalKey,
  baseBranch: queuedJobRecord.baseBranch,
  instruction: "Fix the flaky login test.",
} as const;

const unregisteredRepositoriesLayer = (input?: {
  readonly findByCanonicalKey?: Repositories.Repositories["Service"]["findByCanonicalKey"];
  readonly getAccess?: Repositories.Repositories["Service"]["getAccess"];
  readonly getMembershipForUser?: Organizations.Organizations["Service"]["getMembershipForUser"];
}) =>
  Layer.mergeAll(
    Layer.succeed(
      Repositories.Repositories,
      Repositories.Repositories.of({
        register: () => Effect.die("unused register"),
        getById: () => Effect.die("unused getById"),
        findByCanonicalKey: input?.findByCanonicalKey ?? (() => Effect.succeed(null)),
        listForOrganization: () => Effect.die("unused listForOrganization"),
        deleteRepository: () => Effect.die("unused deleteRepository"),
        addAlias: () => Effect.die("unused addAlias"),
        removeAlias: () => Effect.die("unused removeAlias"),
        listAccess: () => Effect.die("unused listAccess"),
        getAccess: input?.getAccess ?? (() => Effect.succeed(null)),
        listAccessForUser: () => Effect.die("unused listAccessForUser"),
        grantAccess: () => Effect.die("unused grantAccess"),
        revokeAccess: () => Effect.die("unused revokeAccess"),
        revokeAllAccessForUser: () => Effect.die("unused revokeAllAccessForUser"),
      }),
    ),
    Layer.succeed(
      Organizations.Organizations,
      Organizations.Organizations.of({
        ensureForUser: () => Effect.die("unused ensureForUser"),
        getMembershipForUser: input?.getMembershipForUser ?? (() => Effect.succeed(null)),
        listMembers: () => Effect.die("unused listMembers"),
        countAdmins: () => Effect.die("unused countAdmins"),
        countMembers: () => Effect.die("unused countMembers"),
        updateMemberRole: () => Effect.die("unused updateMemberRole"),
        removeMember: () => Effect.die("unused removeMember"),
        addMember: () => Effect.die("unused addMember"),
        rename: () => Effect.die("unused rename"),
        deleteOrganization: () => Effect.die("unused deleteOrganization"),
      }),
    ),
  );

function relayJobsTestLayer(input?: {
  readonly getForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["getForUser"];
  readonly create?: Jobs.Jobs["Service"]["create"];
  readonly getById?: Jobs.Jobs["Service"]["getById"];
  readonly updateStatus?: Jobs.Jobs["Service"]["updateStatus"];
  readonly dispatchJob?: EnvironmentConnector.EnvironmentConnector["Service"]["dispatchJob"];
  readonly tenancy?: Layer.Layer<Repositories.Repositories | Organizations.Organizations>;
}) {
  return Layer.mergeAll(
    input?.tenancy ?? unregisteredRepositoriesLayer(),
    Layer.succeed(
      EnvironmentLinks.EnvironmentLinks,
      EnvironmentLinks.EnvironmentLinks.of({
        upsert: () => Effect.die("unused upsert"),
        listUsersForEnvironment: () => Effect.die("unused listUsersForEnvironment"),
        listDeliveryUsersForEnvironment: () => Effect.die("unused listDeliveryUsersForEnvironment"),
        listPublicKeysForEnvironment: () => Effect.die("unused listPublicKeysForEnvironment"),
        listForUser: () => Effect.die("unused listForUser"),
        getForUser: input?.getForUser ?? (() => Effect.succeed(linkedEnvironmentRecord)),
        revokeForUser: () => Effect.die("unused revokeForUser"),
      }),
    ),
    Layer.succeed(
      Jobs.Jobs,
      Jobs.Jobs.of({
        create:
          input?.create ??
          ((created) =>
            Effect.succeed({
              ...queuedJobRecord,
              jobId: created.jobId,
              ownerUserId: created.ownerUserId,
              environmentId: created.environmentId,
              repositoryCanonicalKey: created.repositoryCanonicalKey,
              baseBranch: created.baseBranch,
            })),
        getById: input?.getById ?? (() => Effect.die("unused getById")),
        updateStatus:
          input?.updateStatus ??
          ((updated) =>
            Effect.succeed({
              ...queuedJobRecord,
              status: updated.status,
              detail: updated.detail,
            })),
      }),
    ),
    Layer.succeed(
      EnvironmentConnector.EnvironmentConnector,
      EnvironmentConnector.EnvironmentConnector.of({
        connect: () => Effect.die("unused connect"),
        status: () => Effect.die("unused status"),
        dispatchJob: input?.dispatchJob ?? (() => Effect.succeed({ accepted: true })),
      }),
    ),
  );
}

describe("relay job dispatch", () => {
  it.effect("queues a job, dispatches it, and answers without the owner", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const job = yield* dispatchJobRecord({
        userId: "user-1",
        jobId: RelayJobId.make("job-1"),
        request: createJobRequest,
      });

      expect(calls).toEqual(["create", "dispatch", "update:dispatched"]);
      expect(job).toMatchObject({
        jobId: "job-1",
        status: "dispatched",
        environmentId: "environment-1",
        repositoryCanonicalKey: "github.com/acme/app",
        baseBranch: "main",
        detail: null,
      });
      // The denormalized owner is the relay's business, not the caller's.
      expect(Object.hasOwn(job, "ownerUserId")).toBe(false);
    }).pipe(
      Effect.provide(
        relayJobsTestLayer({
          create: (created) =>
            Effect.sync(() => {
              calls.push("create");
              return { ...queuedJobRecord, jobId: created.jobId };
            }),
          dispatchJob: (dispatched) =>
            Effect.sync(() => {
              calls.push("dispatch");
              expect(dispatched).toMatchObject({
                userId: "user-1",
                environmentId: "environment-1",
                jobId: "job-1",
                instruction: "Fix the flaky login test.",
              });
              return { accepted: true };
            }),
          updateStatus: (updated) =>
            Effect.sync(() => {
              calls.push(`update:${updated.status}`);
              return { ...queuedJobRecord, status: updated.status, detail: updated.detail };
            }),
        }),
      ),
    );
  });

  it.effect("records the dispatch failure on the job before failing the request", () => {
    const updates: Array<{ status: string; detail: string | null }> = [];
    const failure = new EnvironmentConnector.EnvironmentMintRequestTimedOut({
      environmentId: "environment-1",
      operation: "dispatch-job",
      timeoutMs: EnvironmentConnector.ENVIRONMENT_DISPATCH_JOB_REQUEST_TIMEOUT_MS,
    });

    return Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          dispatchJobRecord({
            userId: "user-1",
            jobId: RelayJobId.make("job-1"),
            request: createJobRequest,
          }),
        ),
      ).toBe(failure);
      expect(updates).toEqual([{ status: "failed", detail: "environment_endpoint_timed_out" }]);
    }).pipe(
      Effect.provide(
        relayJobsTestLayer({
          dispatchJob: () => Effect.fail(failure),
          updateStatus: (updated) =>
            Effect.sync(() => {
              updates.push({ status: updated.status, detail: updated.detail });
              return { ...queuedJobRecord, status: updated.status, detail: updated.detail };
            }),
        }),
      ),
    );
  });

  it.effect("settles a signed refusal as a failed job rather than a failed request", () =>
    Effect.gen(function* () {
      const job = yield* dispatchJobRecord({
        userId: "user-1",
        jobId: RelayJobId.make("job-1"),
        request: createJobRequest,
      });

      expect(job).toMatchObject({
        jobId: "job-1",
        status: "failed",
        detail: ENVIRONMENT_REJECTED_JOB_DETAIL,
      });
    }).pipe(
      Effect.provide(
        relayJobsTestLayer({ dispatchJob: () => Effect.succeed({ accepted: false }) }),
      ),
    ),
  );

  it.effect("refuses to record a job for an environment the user has not linked", () => {
    let created = 0;
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        dispatchJobRecord({
          userId: "user-1",
          jobId: RelayJobId.make("job-1"),
          request: createJobRequest,
        }),
      );

      expect(Predicate.isTagged(error, "EnvironmentConnectNotAuthorized")).toBe(true);
      if (Predicate.isTagged(error, "EnvironmentConnectNotAuthorized")) {
        expect(error).toMatchObject({
          environmentId: "environment-1",
          operation: "dispatch-job",
          reason: "environment_link_not_found",
        });
      }
      expect(created).toBe(0);
    }).pipe(
      Effect.provide(
        relayJobsTestLayer({
          getForUser: () => Effect.succeed(null),
          create: (job) =>
            Effect.sync(() => {
              created += 1;
              return { ...queuedJobRecord, jobId: job.jobId };
            }),
          dispatchJob: () => Effect.die("must not dispatch an unlinked environment"),
        }),
      ),
    );
  });

  const registeredRepository: Repositories.RepositoryRecord = {
    repositoryId: "repository-1",
    organizationId: "organization-1",
    name: "app",
    canonicalKeys: [queuedJobRecord.repositoryCanonicalKey],
    createdAt: "2026-08-05T00:00:00.000Z",
  };

  const membershipIn = (
    organizationId: string,
    role: "member" | "admin",
  ): Organizations.OrganizationMembershipRecord => ({
    organization: { organizationId, name: "Acme", createdAt: "2026-08-05T00:00:00.000Z" },
    userId: "user-1",
    role,
    joinedAt: "2026-08-05T00:00:00.000Z",
  });

  it.effect("refuses a dispatch against a registered repository the caller has no role on", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        dispatchJobRecord({
          userId: "user-1",
          jobId: RelayJobId.make("job-1"),
          request: createJobRequest,
        }),
      );

      expect(error).toMatchObject({
        _tag: "RelayTenancyForbiddenError",
        reason: "no_repository_access",
      });
    }).pipe(
      Effect.provide(
        relayJobsTestLayer({
          tenancy: unregisteredRepositoriesLayer({
            findByCanonicalKey: () => Effect.succeed(registeredRepository),
            getMembershipForUser: () => Effect.succeed(membershipIn("organization-1", "member")),
            getAccess: () => Effect.succeed(null),
          }),
          create: () => Effect.die("must not record a job the caller may not dispatch"),
          dispatchJob: () => Effect.die("must not dispatch without repository access"),
        }),
      ),
    ),
  );

  it.effect("refuses a dispatch against another organization's repository", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        dispatchJobRecord({
          userId: "user-1",
          jobId: RelayJobId.make("job-1"),
          request: createJobRequest,
        }),
      );

      expect(error).toMatchObject({
        _tag: "RelayTenancyForbiddenError",
        reason: "no_repository_access",
      });
    }).pipe(
      Effect.provide(
        relayJobsTestLayer({
          tenancy: unregisteredRepositoriesLayer({
            findByCanonicalKey: () => Effect.succeed(registeredRepository),
            // An admin, but of a different organization.
            getMembershipForUser: () => Effect.succeed(membershipIn("organization-2", "admin")),
            getAccess: () => Effect.die("must not consult access outside the organization"),
          }),
          create: () => Effect.die("must not record a job for another organization"),
          dispatchJob: () => Effect.die("must not dispatch for another organization"),
        }),
      ),
    ),
  );

  it.effect("allows a developer to dispatch against their registered repository", () =>
    Effect.gen(function* () {
      const job = yield* dispatchJobRecord({
        userId: "user-1",
        jobId: RelayJobId.make("job-1"),
        request: createJobRequest,
      });

      expect(job).toMatchObject({ jobId: "job-1", status: "dispatched" });
    }).pipe(
      Effect.provide(
        relayJobsTestLayer({
          tenancy: unregisteredRepositoriesLayer({
            findByCanonicalKey: () => Effect.succeed(registeredRepository),
            getMembershipForUser: () => Effect.succeed(membershipIn("organization-1", "member")),
            getAccess: () => Effect.succeed("developer"),
          }),
        }),
      ),
    ),
  );

  it.effect("leaves an unregistered checkout dispatchable on a personal machine", () =>
    Effect.gen(function* () {
      const job = yield* dispatchJobRecord({
        userId: "user-1",
        jobId: RelayJobId.make("job-1"),
        request: createJobRequest,
      });

      expect(job).toMatchObject({ jobId: "job-1", status: "dispatched" });
    }).pipe(Effect.provide(relayJobsTestLayer())),
  );
});

describe("relay job reads", () => {
  it.effect("answers the owner's job without the owner", () =>
    Effect.gen(function* () {
      const job = yield* readJobForUser({
        userId: "user-1",
        jobId: RelayJobId.make("job-1"),
      });

      expect(job).toMatchObject({ jobId: "job-1", status: "queued" });
      expect(job !== null && Object.hasOwn(job, "ownerUserId")).toBe(false);
    }).pipe(Effect.provide(relayJobsTestLayer({ getById: () => Effect.succeed(queuedJobRecord) }))),
  );

  it.effect("hides a job owned by another user", () =>
    Effect.gen(function* () {
      expect(
        yield* readJobForUser({
          userId: "user-2",
          jobId: RelayJobId.make("job-1"),
        }),
      ).toBeNull();
    }).pipe(Effect.provide(relayJobsTestLayer({ getById: () => Effect.succeed(queuedJobRecord) }))),
  );

  it.effect("reads a missing job as no job", () =>
    Effect.gen(function* () {
      expect(
        yield* readJobForUser({
          userId: "user-1",
          jobId: RelayJobId.make("job-missing"),
        }),
      ).toBeNull();
    }).pipe(Effect.provide(relayJobsTestLayer({ getById: () => Effect.succeed(null) }))),
  );
});

describe("relay request tracing", () => {
  it.effect(
    "does not parent endpoint spans to an ambient parent captured while building handlers",
    () =>
      Effect.gen(function* () {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const ambientParent = Tracer.externalSpan({
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          sampled: true,
        });
        const endpoint = yield* withoutCapturedParentSpan(
          Effect.context<never>().pipe(
            Effect.map((capturedContext: Context.Context<never>) =>
              Effect.succeed(HttpServerResponse.empty({ status: 204 })).pipe(
                Effect.withSpan("relay.test.endpoint"),
                Effect.provideContext(capturedContext),
              ),
            ),
          ),
        ).pipe(Effect.provideService(Tracer.ParentSpan, ambientParent));
        const request = HttpServerRequest.fromWeb(
          new Request("https://relay.test/v1/mobile/devices?client=mobile", {
            method: "POST",
            headers: {
              authorization: "Bearer secret",
              dpop: "signed-proof",
            },
          }),
        );

        yield* traceRelayHttpRequestWith(endpoint, Layer.succeed(Tracer.Tracer, tracer)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );

        expect(spans.map((span) => span.name)).toEqual(["http.server POST", "relay.test.endpoint"]);
        expect(spans[0]?.kind).toBe("server");
        expect(spans[0]?.attributes.get("url.path")).toBe("/v1/mobile/devices");
        expect(spans[0]?.attributes.get("http.response.status_code")).toBe(204);
        expect(spans[0]?.attributes.get("http.request.header.authorization")).toBe("<redacted>");
        expect(spans[0]?.attributes.get("http.request.header.dpop")).toBe("<redacted>");
        expect(Option.isNone(spans[0]!.parent)).toBe(true);
        expect(Option.getOrUndefined(spans[1]!.parent)?.spanId).toBe(spans[0]?.spanId);
      }),
  );

  it.effect("fails hung requests with a 504 before the client's 10s abort", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/mobile/devices", { method: "POST" }),
      );

      const fiber = yield* traceRelayHttpRequestWith(
        Effect.never,
        Layer.succeed(Tracer.Tracer, tracer),
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(RELAY_REQUEST_DEADLINE_MS));
      const response = yield* Fiber.join(fiber);

      expect(response.status).toBe(504);
      expect(spans[0]?.attributes.get("relay.request.deadline_exceeded")).toBe(true);
      expect(spans[0]?.attributes.get("http.response.status_code")).toBe(504);
    }),
  );
});

describe("relay routing fallback", () => {
  it.effect("redirects the relay root to the API docs", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(new Request("https://relay.test/"));
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(relayDocsRedirectRoute, relayNotFoundRoute, relayCors),
      );
      const response = yield* httpEffect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/docs");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    }).pipe(Effect.scoped),
  );

  it.effect("returns a CORS-compatible 404 response for unmatched paths", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/environmentsd", { method: "GET" }),
      );
      const httpEffect = yield* HttpRouter.toHttpEffect(Layer.merge(relayNotFoundRoute, relayCors));
      const response = yield* httpEffect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );

      expect(response.status).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    }).pipe(Effect.scoped),
  );
});
