/**
 * Placing an organization's provider account on this machine, for one
 * provider instance.
 *
 * Drivers call `applyOrganizationProviderAccount` while building an
 * instance. An `env` account becomes one variable in the instance's process
 * environment; an `auth_store` account becomes the provider CLI's own auth
 * files in the directory the driver names. Files are written only when the
 * relay's version differs from the one recorded beside them, so a CLI that
 * refreshed its own tokens in the meantime keeps them until the admin shares
 * a new sign-in. Nothing here can fail an instance: a placement problem is
 * logged and the instance comes up without the account.
 *
 * @module provider/organizationProviderAccount
 */
import type { ProviderAccountFile, ProviderAccountProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { OrganizationProviderAccounts } from "../relay/OrganizationProviderAccounts.ts";

/** Sits beside the placed files and records which relay version they came from. */
export const ORGANIZATION_ACCOUNT_MARKER_FILE = ".launchpad-organization-account";

/** A file in the shared account would land outside the provider's auth store. */
export class OrganizationProviderAccountFileEscapesError extends Schema.TaggedErrorClass<OrganizationProviderAccountFileEscapesError>()(
  "OrganizationProviderAccountFileEscapesError",
  {
    filePath: Schema.String,
    directory: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to place '${this.filePath}' outside '${this.directory}'`;
  }
}

export interface AppliedOrganizationProviderAccount {
  readonly label: string;
  readonly version: string;
}

export interface ApplyOrganizationProviderAccountResult {
  readonly environment: NodeJS.ProcessEnv;
  /** The account now backing the instance, or null when the organization holds none for it. */
  readonly account: AppliedOrganizationProviderAccount | null;
}

export const materializeAuthStore = Effect.fn("materializeOrganizationAuthStore")(
  function* (input: {
    readonly directory: string;
    readonly files: ReadonlyArray<ProviderAccountFile>;
    readonly version: string;
  }): Effect.fn.Return<
    "written" | "unchanged",
    PlatformError | OrganizationProviderAccountFileEscapesError,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.resolve(input.directory);
    const marker = path.join(directory, ORGANIZATION_ACCOUNT_MARKER_FILE);
    const placed = yield* fileSystem.readFileString(marker).pipe(Effect.orElseSucceed(() => null));
    if (placed !== null && placed.trim() === input.version) {
      return "unchanged";
    }
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    for (const file of input.files) {
      const target = path.resolve(directory, file.path);
      // The contract already forbids `..`; this is the belt to that suspender.
      if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) {
        return yield* new OrganizationProviderAccountFileEscapesError({
          filePath: file.path,
          directory,
        });
      }
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFileString(target, file.content);
      yield* fileSystem.chmod(target, 0o600);
    }
    yield* fileSystem.writeFileString(marker, input.version);
    yield* fileSystem.chmod(marker, 0o600);
    return "written";
  },
);

export const applyOrganizationProviderAccount = Effect.fn("applyOrganizationProviderAccount")(
  function* (input: {
    readonly provider: ProviderAccountProvider;
    readonly environment: NodeJS.ProcessEnv;
    /** Where this provider keeps its auth store; null when it has none Launchpad can place. */
    readonly authStoreDirectory: string | null;
  }): Effect.fn.Return<
    ApplyOrganizationProviderAccountResult,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const accounts = yield* OrganizationProviderAccounts;
    const account = (yield* accounts.current).get(input.provider);
    if (account === undefined) {
      return { environment: input.environment, account: null };
    }
    const applied = { label: account.label, version: account.version };
    if (account.payload.kind === "env") {
      return {
        environment: { ...input.environment, [account.payload.name]: account.payload.value },
        account: applied,
      };
    }
    if (input.authStoreDirectory === null) {
      yield* Effect.logWarning("organization provider account has no place on this provider", {
        provider: input.provider,
      });
      return { environment: input.environment, account: null };
    }
    const outcome = yield* materializeAuthStore({
      directory: input.authStoreDirectory,
      files: account.payload.files,
      version: account.version,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("organization provider account could not be placed", {
          provider: input.provider,
          directory: input.authStoreDirectory,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as("failed" as const)),
      ),
    );
    if (outcome === "failed") {
      return { environment: input.environment, account: null };
    }
    if (outcome === "written") {
      yield* Effect.logInfo("organization provider account placed", {
        provider: input.provider,
        label: account.label,
        directory: input.authStoreDirectory,
      });
    }
    return { environment: input.environment, account: applied };
  },
);
