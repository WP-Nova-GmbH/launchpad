import { type AuthDesktopIdentityRequest } from "@t3tools/contracts";
import { RelayApi } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { relayUrlConfig } from "../cloud/publicConfig.ts";

/** The environment chooses the relay; callers can supply only a session token. */
export const verifyDesktopIdentity = Effect.fn("auth.verifyDesktopIdentity")(function* (
  identity: NonNullable<AuthDesktopIdentityRequest["identity"]>,
) {
  const baseUrl = yield* relayUrlConfig;
  const client = yield* HttpApiClient.make(RelayApi, { baseUrl });
  const user = yield* client.client
    .identity({
      headers: { authorization: `Bearer ${identity.token}` },
    })
    .pipe(Effect.timeout("8 seconds"));
  // A getToken call may finish after Clerk has changed accounts.
  if (user.userId !== identity.accountId) return yield* Effect.fail("account_changed" as const);
  return user;
});
