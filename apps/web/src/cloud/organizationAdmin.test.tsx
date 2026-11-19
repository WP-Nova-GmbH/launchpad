import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import {
  ManagedRelay,
  ManagedRelayTenancy,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  RelayOrganizationId,
  RelayRepositoryId,
  type RelayGithubConnection,
  type RelayGithubInstallationCandidate,
  type RelayOrganizationMembership,
  type RelayRepositorySummary,
} from "@t3tools/contracts/relay";

const fixture = vi.hoisted(() => ({
  getToken: vi.fn(async () => "token"),
  runPromise: undefined as unknown as <A, E>(
    program: Effect.Effect<A, E, ManagedRelayTenancy.ManagedRelayTenancyClient>,
  ) => Promise<A>,
  client: undefined as unknown as ManagedRelayTenancy.ManagedRelayTenancyClient["Service"],
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isSignedIn: true, userId: "account", getToken: fixture.getToken }),
}));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));
vi.mock("./linkEnvironment", () => ({ decodedRelayClientError: () => (error: unknown) => error }));
vi.mock("../lib/runtime", async () => {
  const Context = await import("effect/Context");
  const Effect = await import("effect/Effect");
  const { ManagedRelayTenancy } = await import("@t3tools/client-runtime/relay");
  const context = () => Context.make(ManagedRelayTenancy.ManagedRelayTenancyClient, fixture.client);
  return {
    runtime: {
      contextEffect: Effect.sync(context),
      runPromise: <A, E>(
        program: Effect.Effect<A, E, ManagedRelayTenancy.ManagedRelayTenancyClient>,
      ) => fixture.runPromise(program),
    },
  };
});

import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { useManagedRelayOrganizationCatalog } from "./managedRelayState";
import { useOrganizationAdmin } from "./organizationAdmin";

const membership: RelayOrganizationMembership = {
  organization: {
    organizationId: RelayOrganizationId.make("organization"),
    name: "Organization",
    createdAt: "2026-10-20",
  },
  userId: "account",
  role: "admin",
  joinedAt: "2026-10-20",
};
const repository: RelayRepositorySummary = {
  repository: {
    repositoryId: RelayRepositoryId.make("repository"),
    organizationId: membership.organization.organizationId,
    name: "Registered repository",
    canonicalKeys: ["github.com/acme/repository"],
    createdAt: "2026-10-20",
  },
  role: "maintainer",
};
let remoteRepositories: ReadonlyArray<RelayRepositorySummary>;
let admin: ReturnType<typeof useOrganizationAdmin>;
let catalog: ReturnType<typeof useManagedRelayOrganizationCatalog>;
let renderer: ReactTestRenderer | undefined;
function Probe() {
  const currentAdmin = useOrganizationAdmin();
  const currentCatalog = useManagedRelayOrganizationCatalog();
  useLayoutEffect(() => {
    admin = currentAdmin;
    catalog = currentCatalog;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appAtomRegistry.reset();
  remoteRepositories = [];
  fixture.client = {
    getOrganization: () => Effect.succeed(membership),
    getAccessRemoval: () =>
      Effect.succeed({ revision: 0, status: "completed", pendingEnvironmentIds: [] }),
    listMembers: () => Effect.succeed([]),
    listRepositories: () => Effect.succeed(remoteRepositories),
    listOrganizationProjects: () => Effect.succeed([]),
    listInvitations: () => Effect.succeed([]),
    listProviderAccounts: () => Effect.succeed([]),
    listAccess: () => Effect.succeed([]),
    listMachines: () => Effect.succeed([]),
    listSkills: () => Effect.succeed([]),
    getGithubConnection: () => Effect.succeed({ connection: null, configured: false }),
    registerRepository: () =>
      Effect.sync(() => {
        remoteRepositories = [repository];
        return repository;
      }),
    deleteRepository: () =>
      Effect.sync(() => {
        remoteRepositories = [];
        return { ok: true };
      }),
  } as unknown as ManagedRelayTenancy.ManagedRelayTenancyClient["Service"];
  setManagedRelaySession(appAtomRegistry, {
    accountId: "account",
    readClerkToken: async () => "token",
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  appAtomRegistry.reset();
  vi.unstubAllGlobals();
});

const runRelayRequests = Effect.gen(function* () {
  const calls = yield* Queue.unbounded<Effect.Effect<void>>();
  fixture.runPromise = <A, E>(
    program: Effect.Effect<A, E, ManagedRelayTenancy.ManagedRelayTenancyClient>,
  ) =>
    new Promise<A>((resolve, reject) => {
      Queue.offerUnsafe(
        calls,
        program.pipe(
          Effect.provideService(ManagedRelayTenancy.ManagedRelayTenancyClient, fixture.client),
          Effect.matchCause({
            onFailure: (cause) => reject(Cause.squash(cause)),
            onSuccess: resolve,
          }),
        ),
      );
    });
  yield* Effect.forever(Queue.take(calls).pipe(Effect.flatMap((call) => call))).pipe(
    Effect.forkScoped,
  );
});

it.effect(
  "updates an already-mounted repository catalog after registration and removal in Settings",
  () =>
    Effect.gen(function* () {
      yield* runRelayRequests;
      yield* Effect.promise(async () => {
        await act(async () => {
          renderer = create(
            <AppAtomRegistryProvider>
              <Probe />
            </AppAtomRegistryProvider>,
          );
        });
        await act(async () => admin.refresh());
        expect(admin.snapshot?.repositories).toEqual([]);
        expect(catalog.data?.repositories).toEqual([]);

        await act(async () => {
          expect(
            await admin.registerRepository({
              name: repository.repository.name,
              canonicalKey: repository.repository.canonicalKeys[0]!,
            }),
          ).toBe(true);
        });
        expect(admin.snapshot?.repositories).toEqual([repository]);
        expect(catalog.data?.repositories).toEqual([repository]);

        await act(async () => {
          expect(await admin.deleteRepository(repository.repository.repositoryId)).toBe(true);
        });
        expect(admin.snapshot?.repositories).toEqual([]);
        expect(catalog.data?.repositories).toEqual([]);
      });
    }),
);

async function mountAdmin() {
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Probe />
      </AppAtomRegistryProvider>,
    );
  });
  await act(async () => admin.refresh());
}

it.effect("retains GitHub data as unverified until its own reads recover", () =>
  Effect.gen(function* () {
    yield* runRelayRequests;
    yield* Effect.promise(async () => {
      const connection: RelayGithubConnection = {
        installationId: "installation",
        accountLogin: "acme",
        accountType: "Organization",
        connectedByUserId: "account",
        connectedAt: "2026-10-20",
      };
      const mutationError = new ManagedRelay.ManagedRelayRequestFailedError({
        action: "register relay repository",
        cause: "Registration failed",
      });
      const connectionError = new ManagedRelay.ManagedRelayRequestFailedError({
        action: "read relay GitHub connection",
        cause: "Connection check failed",
      });
      const repositoriesError = new ManagedRelay.ManagedRelayRequestFailedError({
        action: "list relay GitHub repositories",
        cause: "Installation token rejected",
      });
      let readFailure: "connection" | "repositories" | null = null;
      let installationId = connection.installationId;
      fixture.client = {
        ...fixture.client,
        getGithubConnection: () =>
          readFailure === "connection"
            ? Effect.fail(connectionError)
            : Effect.succeed({
                connection: { ...connection, installationId },
                installUrl: "https://example.test/install",
                appSlug: null,
                setupCallbackUrl: null,
              }),
        listGithubRepositories: () =>
          readFailure === "repositories" ? Effect.fail(repositoriesError) : Effect.succeed([]),
        registerRepository: () => Effect.fail(mutationError),
      };
      await mountAdmin();
      expect(admin.snapshot?.github.connection).toEqual(connection);
      expect(admin.githubReadError).toBeNull();

      await act(async () => {
        await admin.registerRepository({
          name: "Repository",
          canonicalKey: "github.com/acme/repository",
        });
      });
      expect(admin.error).toBe(mutationError.message);
      expect(admin.githubReadError).toBeNull();

      readFailure = "connection";
      await act(async () => admin.refresh());
      expect(admin.githubReadError).toBe(connectionError.message);
      expect(admin.githubConnectionVerified).toBe(false);
      expect(admin.snapshot?.github.connection).toEqual(connection);

      readFailure = "repositories";
      await act(async () => admin.refresh());
      expect(admin.githubReadError).toBe(repositoriesError.message);
      expect(admin.githubConnectionVerified).toBe(true);
      expect(admin.snapshot?.github.connection).toEqual(connection);

      installationId = "replacement";
      await act(async () => admin.refresh());
      expect(admin.githubReadError).toBe(repositoriesError.message);
      expect(admin.githubConnectionVerified).toBe(false);
      expect(admin.snapshot?.github.connection).toEqual(connection);

      readFailure = null;
      await act(async () => admin.refresh());
      expect(admin.githubReadError).toBeNull();
      expect(admin.error).toBeNull();
      expect(admin.githubConnectionVerified).toBe(true);
      expect(admin.snapshot?.github.connection).toEqual({ ...connection, installationId });
    });
  }),
);

it.effect("installation lookup can be retried without setting a global settings error", () =>
  Effect.gen(function* () {
    yield* runRelayRequests;
    yield* Effect.promise(async () => {
      const error = new ManagedRelay.ManagedRelayRequestFailedError({
        action: "list relay GitHub installations",
        cause: "Upstream unavailable",
      });
      const installation: RelayGithubInstallationCandidate = {
        installationId: "installation",
        accountLogin: "acme",
        accountType: "Organization",
        createdAt: "2026-10-20",
        connected: false,
      };
      const list = vi
        .fn<ManagedRelayTenancy.ManagedRelayTenancyClient["Service"]["listGithubInstallations"]>()
        .mockReturnValueOnce(Effect.fail(error))
        .mockReturnValueOnce(Effect.succeed([installation]));
      fixture.client = { ...fixture.client, listGithubInstallations: list };
      await mountAdmin();

      await expect(admin.listGithubInstallations()).rejects.toThrow(error.message);
      expect(admin.error).toBeNull();
      expect(admin.githubReadError).toBeNull();
      await expect(admin.listGithubInstallations()).resolves.toEqual([installation]);
      expect(list).toHaveBeenCalledTimes(2);
      expect(admin.error).toBeNull();
    });
  }),
);
