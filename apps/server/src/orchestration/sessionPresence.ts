import type {
  AuthClientSession,
  AuthSessionId,
  ThreadPresenceReportInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { SessionStore } from "../auth/SessionStore.ts";
import { ThreadPresenceService } from "./ThreadPresence.ts";

const presentation = (session: AuthClientSession) => ({
  sessionId: session.sessionId,
  user: session.user ?? null,
  clientLabel: session.client.label ?? null,
  clientDeviceType: session.client.deviceType,
  clientOs: session.client.os ?? null,
  clientBrowser: session.client.browser ?? null,
});

/** Keeps session invalidations and activity reports in order for one socket. */
export const makeSessionPresenceReporter = Effect.fn("makeSessionPresenceReporter")(function* (
  connectionId: string,
  sessionId: AuthSessionId,
) {
  const sessions = yield* SessionStore;
  const presence = yield* ThreadPresenceService;
  // Subscribe before the initial read so a rename racing this handshake cannot be lost.
  const changes = yield* sessions.subscribeChanges;
  const mutex = yield* Semaphore.make(1);
  const current = yield* Ref.make(yield* sessions.getActive(sessionId));
  yield* changes.pipe(
    Stream.runForEach((change) => {
      const changedId =
        change.type === "clientUpserted" ? change.clientSession.sessionId : change.sessionId;
      if (changedId !== sessionId) return Effect.void;
      return mutex.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* sessions.getActive(sessionId);
          yield* Ref.set(current, latest);
          if (Option.isSome(latest))
            yield* presence.updatePresentation(connectionId, presentation(latest.value));
          else yield* presence.clear(connectionId);
        }).pipe(
          Effect.catchTag("SessionCredentialVerificationError", () =>
            Effect.logWarning(
              "Failed to refresh session presence; keeping the previous presentation.",
              {
                connectionId,
                sessionId,
              },
            ),
          ),
        ),
      );
    }),
    Effect.orDie,
    Effect.forkScoped,
  );
  return Effect.fn("sessionPresence.report")(function* (input: ThreadPresenceReportInput) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const session = yield* Ref.get(current);
        if (Option.isSome(session))
          yield* presence.report({ connectionId, ...presentation(session.value), ...input });
      }),
    );
  });
});
