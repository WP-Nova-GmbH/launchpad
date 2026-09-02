import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as OrganizationProviderAccounts from "../relay/OrganizationProviderAccounts.ts";
import {
  applyOrganizationProviderAccount,
  materializeAuthStore,
  ORGANIZATION_ACCOUNT_MARKER_FILE,
} from "./organizationProviderAccount.ts";

const withTempDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-org-account-" });
      return yield* use(directory);
    }),
  ).pipe(Effect.orDie);

function accountsWith(
  accounts: ReadonlyArray<OrganizationProviderAccounts.OrganizationProviderAccount>,
): OrganizationProviderAccounts.OrganizationProviderAccountsShape {
  return {
    ...OrganizationProviderAccounts.none,
    current: Effect.succeed(new Map(accounts.map((account) => [account.provider, account]))),
  };
}

describe("materializeAuthStore", () => {
  it.effect("writes the files privately and records the version beside them", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outcome = yield* materializeAuthStore({
          directory: path.join(directory, "codex"),
          files: [{ path: "auth.json", content: '{"tokens":1}' }],
          version: "v1",
        });
        expect(outcome).toBe("written");
        const target = path.join(directory, "codex", "auth.json");
        expect(yield* fileSystem.readFileString(target)).toBe('{"tokens":1}');
        const info = yield* fileSystem.stat(target);
        expect((info.mode & 0o777).toString(8)).toBe("600");
        expect(
          yield* fileSystem.readFileString(
            path.join(directory, "codex", ORGANIZATION_ACCOUNT_MARKER_FILE),
          ),
        ).toBe("v1");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a store alone while the version it came from is unchanged", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = [{ path: "auth.json", content: "from-relay" }];
        yield* materializeAuthStore({ directory, files, version: "v1" });
        // The CLI refreshed its own tokens; the relay still holds the same sign-in.
        yield* fileSystem.writeFileString(path.join(directory, "auth.json"), "refreshed-locally");
        expect(yield* materializeAuthStore({ directory, files, version: "v1" })).toBe("unchanged");
        expect(yield* fileSystem.readFileString(path.join(directory, "auth.json"))).toBe(
          "refreshed-locally",
        );
        // A new sign-in shared by the admin replaces it.
        expect(
          yield* materializeAuthStore({
            directory,
            files: [{ path: "auth.json", content: "new-sign-in" }],
            version: "v2",
          }),
        ).toBe("written");
        expect(yield* fileSystem.readFileString(path.join(directory, "auth.json"))).toBe(
          "new-sign-in",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("applyOrganizationProviderAccount", () => {
  it.effect("changes nothing when the organization holds no account for the provider", () =>
    Effect.gen(function* () {
      const result = yield* applyOrganizationProviderAccount({
        provider: "cursor",
        environment: { PATH: "/usr/bin" },
        authStoreDirectory: null,
      });
      expect(result).toEqual({ environment: { PATH: "/usr/bin" }, account: null });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("places an env account as one variable in the instance environment", () =>
    Effect.gen(function* () {
      const result = yield* applyOrganizationProviderAccount({
        provider: "cursor",
        environment: { PATH: "/usr/bin" },
        authStoreDirectory: null,
      }).pipe(
        Effect.provideService(
          OrganizationProviderAccounts.OrganizationProviderAccounts,
          accountsWith([
            {
              provider: "cursor",
              label: "team key",
              version: "v1",
              payload: { kind: "env", name: "CURSOR_API_KEY", value: "key_123" },
            },
          ]),
        ),
      );
      expect(result.environment).toEqual({ PATH: "/usr/bin", CURSOR_API_KEY: "key_123" });
      expect(result.account).toEqual({ label: "team key", version: "v1" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("places an auth store in the provider's directory", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* applyOrganizationProviderAccount({
          provider: "codex",
          environment: {},
          authStoreDirectory: directory,
        }).pipe(
          Effect.provideService(
            OrganizationProviderAccounts.OrganizationProviderAccounts,
            accountsWith([
              {
                provider: "codex",
                label: "someone@example.test",
                version: "v7",
                payload: {
                  kind: "auth_store",
                  files: [{ path: "auth.json", content: '{"tokens":{}}' }],
                },
              },
            ]),
          ),
        );
        expect(result.account).toEqual({ label: "someone@example.test", version: "v7" });
        expect(yield* fileSystem.readFileString(path.join(directory, "auth.json"))).toBe(
          '{"tokens":{}}',
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips an auth store for a provider with nowhere to put it", () =>
    Effect.gen(function* () {
      const result = yield* applyOrganizationProviderAccount({
        provider: "cursor",
        environment: {},
        authStoreDirectory: null,
      }).pipe(
        Effect.provideService(
          OrganizationProviderAccounts.OrganizationProviderAccounts,
          accountsWith([
            {
              provider: "cursor",
              label: "x",
              version: "v1",
              payload: { kind: "auth_store", files: [{ path: "auth.json", content: "{}" }] },
            },
          ]),
        ),
      );
      expect(result).toEqual({ environment: {}, account: null });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
