import { createClerkClient } from "@clerk/backend";
import type { RelayUserIdentity } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";

/**
 * Puts a name to a subject id.
 *
 * The relay owns tenancy and deliberately not people: membership rows carry a
 * subject id and nothing else, so a roster has to ask the identity provider who
 * those subjects are. Resolved on read rather than stored, because a copied
 * name is stale the moment somebody edits their profile.
 *
 * Every failure resolves to "unknown" instead of propagating. A directory
 * outage should degrade a roster to subject ids, not take the page down.
 */
export class UserDirectory extends Context.Service<
  UserDirectory,
  {
    readonly lookup: (input: {
      readonly userIds: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, RelayUserIdentity>>;
  }
>()("t3code-relay/tenancy/UserDirectory") {}

/** Clerk's user list caps a page; rosters beyond this are fetched in chunks. */
const LOOKUP_CHUNK_SIZE = 100;

function displayNameOf(user: {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
}): string | null {
  const full = [user.firstName, user.lastName].filter((part) => part && part.trim()).join(" ");
  return full.trim() || user.username?.trim() || null;
}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;

  return UserDirectory.of({
    lookup: Effect.fn("relay.user_directory.lookup")(function* (input) {
      const userIds = [...new Set(input.userIds)].filter((id) => id.length > 0);
      if (userIds.length === 0) {
        return new Map<string, RelayUserIdentity>();
      }
      yield* Effect.annotateCurrentSpan({ "relay.user_directory.count": userIds.length });

      const resolved = yield* Effect.tryPromise(async () => {
        const client = createClerkClient({
          secretKey: Redacted.value(config.clerkSecretKey),
          publishableKey: config.clerkPublishableKey,
        });
        const identities = new Map<string, RelayUserIdentity>();
        for (let offset = 0; offset < userIds.length; offset += LOOKUP_CHUNK_SIZE) {
          const chunk = userIds.slice(offset, offset + LOOKUP_CHUNK_SIZE);
          const page = await client.users.getUserList({ userId: chunk, limit: chunk.length });
          for (const user of page.data) {
            identities.set(user.id, {
              displayName: displayNameOf(user),
              email: user.primaryEmailAddress?.emailAddress?.trim() ?? null,
              imageUrl: user.imageUrl?.trim() || null,
            });
          }
        }
        return identities;
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not resolve subject identities", { cause }),
        ),
        // A roster of subject ids beats no roster at all.
        Effect.orElseSucceed(() => new Map<string, RelayUserIdentity>()),
      );

      return resolved;
    }),
  });
});

export const layer = Layer.effect(UserDirectory, make);
