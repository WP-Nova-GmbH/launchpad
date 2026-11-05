import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import { ManagedRelayTenancy, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  RelayOrganizationId,
  RelayRepositoryId,
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

it.effect(
  "updates an already-mounted repository catalog after registration and removal in Settings",
  () =>
    Effect.gen(function* () {
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
