import {
  AuthCurrentSessionPresentation,
  AuthSessionStreamError,
  requiresClientLabel,
  type AuthClientSession,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { SessionStore } from "./SessionStore.ts";

export const currentSessionPresentation = (
  session: AuthClientSession,
): AuthCurrentSessionPresentation => ({
  sessionId: session.sessionId,
  client: session.client,
  needsClientLabel: requiresClientLabel(session) && !session.client.label?.trim(),
  ...(session.user ? { user: session.user } : {}),
});

const samePresentation = Schema.toEquivalence(Schema.NullOr(AuthCurrentSessionPresentation));

/** Publishes only this client's presentation; queued changes are invalidations. */
export const currentSessionChanges = (sessionId: AuthSessionId) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sessions = yield* SessionStore;
      // Subscribe before reading to retain a rename racing the initial snapshot.
      const changes = yield* sessions.subscribeChanges;
      const read = () =>
        sessions.getActive(sessionId).pipe(
          Effect.map((active) =>
            Option.isSome(active) ? currentSessionPresentation(active.value) : null,
          ),
          Effect.mapError((error) => new AuthSessionStreamError({ message: error.message })),
        );
      const initial = yield* read();
      const updates = changes.pipe(
        Stream.filter(
          (change) =>
            (change.type === "clientUpserted"
              ? change.clientSession.sessionId
              : change.sessionId) === sessionId,
        ),
        Stream.mapEffect(() => read()),
      );
      return Stream.concat(Stream.make(initial), updates).pipe(
        Stream.changesWith(samePresentation),
      );
    }),
  );
