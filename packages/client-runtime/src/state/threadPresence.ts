/**
 * Who else is in a thread right now. Ephemeral, per environment: one live
 * subscription per environment, collapsed per thread into people rather than
 * connections so a teammate with two tabs open is one teammate.
 */
import {
  ORCHESTRATION_WS_METHODS,
  type ScopedThreadRef,
  type ThreadPresenceParticipant,
  type ThreadPresenceSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { managedRelaySessionAtom } from "../relay/managedRelayState.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Renew a live typing report no more often than this while keys keep coming. */
export const THREAD_TYPING_RENEW_INTERVAL_MS = 3_000;
/** Pause length after which the client reports that typing stopped. */
export const THREAD_TYPING_IDLE_MS = 4_000;
/** Re-announce the viewed thread so a reconnected socket is not invisible. */
export const THREAD_PRESENCE_HEARTBEAT_MS = 20_000;

const PRESENCE_IDLE_TTL_MS = 60_000;

export interface ThreadPresencePerson {
  readonly key: string;
  readonly displayName: string | null;
  readonly imageUrl: string | null;
  readonly typing: boolean;
}

const EMPTY_PEOPLE: ReadonlyArray<ThreadPresencePerson> = [];

/**
 * One entry per person on the thread. Connections of the same signed-in user
 * merge; a session without a user is its own entry. The viewer's own user is
 * dropped so a second device of theirs stays quiet.
 */
export function collapseThreadPresence(
  participants: ReadonlyArray<ThreadPresenceParticipant>,
  threadId: ScopedThreadRef["threadId"],
  ownUserId: string | null,
): ReadonlyArray<ThreadPresencePerson> {
  const people = new Map<string, ThreadPresencePerson>();
  for (const participant of participants) {
    if (participant.threadId !== threadId) continue;
    if (participant.user !== null && participant.user.userId === ownUserId) continue;
    const key =
      participant.user === null
        ? `connection:${participant.connectionId}`
        : `user:${participant.user.userId}`;
    const existing = people.get(key);
    people.set(key, {
      key,
      displayName: participant.user?.displayName ?? participant.clientLabel ?? null,
      imageUrl: participant.user?.imageUrl ?? null,
      typing: (existing?.typing ?? false) || participant.typing,
    });
  }
  return people.size === 0 ? EMPTY_PEOPLE : [...people.values()];
}

function nameOf(person: ThreadPresencePerson): string {
  return person.displayName ?? "Someone";
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Null when nobody else is here. Typing wins over merely viewing. */
export function threadPresenceLabel(people: ReadonlyArray<ThreadPresencePerson>): string | null {
  if (people.length === 0) return null;
  const typing = people.filter((person) => person.typing);
  if (typing.length > 0) {
    const names = typing.map(nameOf);
    return typing.length === 1 ? `${names[0]} is typing…` : `${joinNames(names)} are typing…`;
  }
  const names = people.map(nameOf);
  return people.length === 1 ? `${names[0]} is here` : `${joinNames(names)} are here`;
}

export function createThreadPresenceAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  const snapshotAtom = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-thread-presence",
    tag: ORCHESTRATION_WS_METHODS.subscribeThreadPresence,
    idleTtlMs: PRESENCE_IDLE_TTL_MS,
  });

  const peopleAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousSnapshot: ThreadPresenceSnapshot | null = null;
    let previousOwnUserId: string | null = null;
    let previousValue = EMPTY_PEOPLE;
    return Atom.make((get): ReadonlyArray<ThreadPresencePerson> => {
      const snapshot = Option.getOrNull(
        AsyncResult.value(get(snapshotAtom({ environmentId: ref.environmentId, input: {} }))),
      );
      const ownUserId = get(managedRelaySessionAtom)?.accountId ?? null;
      if (snapshot === previousSnapshot && ownUserId === previousOwnUserId) {
        return previousValue;
      }
      previousSnapshot = snapshot;
      previousOwnUserId = ownUserId;
      previousValue =
        snapshot === null
          ? EMPTY_PEOPLE
          : collapseThreadPresence(snapshot.participants, ref.threadId, ownUserId);
      return previousValue;
    }).pipe(
      Atom.setIdleTTL(PRESENCE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-presence-people:${key}`),
    );
  });

  return {
    /** Everyone else on this thread, for the thread view to render. */
    peopleAtom: (ref: ScopedThreadRef) => peopleAtomFamily(threadKey(ref)),
    /** Tell the environment which thread this client is on and whether it is typing. */
    report: createEnvironmentRpcCommand(runtime, {
      label: "environment-thread-presence:report",
      tag: ORCHESTRATION_WS_METHODS.reportThreadPresence,
    }),
  };
}
