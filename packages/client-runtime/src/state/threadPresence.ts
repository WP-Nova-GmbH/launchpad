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
  readonly email: string | null;
  readonly userId: string | null;
  readonly clientDetails: string | null;
  readonly isSelf: boolean;
}

const nonEmpty = (value: string | null | undefined) => value?.trim() || null;

const EMPTY_PEOPLE: ReadonlyArray<ThreadPresencePerson> = [];

/**
 * One entry per person on the thread. Connections of the same signed-in user
 * merge; a session without a user is its own entry. The viewer's own user is
 * dropped so a second device of theirs stays quiet.
 */
export function collapseThreadPresence(
  participants: ReadonlyArray<ThreadPresenceParticipant>,
  threadId: ScopedThreadRef["threadId"],
  viewer: ThreadPresenceSnapshot["viewer"] | null,
  includeViewer = false,
): ReadonlyArray<ThreadPresencePerson> {
  const people = new Map<string, ThreadPresencePerson>();
  for (const participant of participants) {
    if (participant.threadId !== threadId) continue;
    const isSelf =
      participant.user !== null
        ? participant.user.userId === viewer?.userId
        : participant.sessionId === viewer?.sessionId;
    if (isSelf && !includeViewer) continue;
    const key =
      participant.user === null
        ? `session:${participant.sessionId}`
        : `user:${participant.user.userId}`;
    const existing = people.get(key);
    const device =
      [participant.clientOs, participant.clientBrowser].filter(Boolean).join(" · ") ||
      (participant.clientDeviceType === "unknown" ? "Client" : participant.clientDeviceType);
    people.set(key, {
      key,
      displayName:
        existing?.displayName ??
        nonEmpty(participant.user?.displayName) ??
        (participant.user === null ? (nonEmpty(participant.clientLabel) ?? device) : null),
      imageUrl: existing?.imageUrl ?? nonEmpty(participant.user?.imageUrl),
      email: existing?.email ?? nonEmpty(participant.user?.email),
      userId: participant.user?.userId ?? null,
      clientDetails: participant.user === null ? device : null,
      isSelf: (existing?.isSelf ?? false) || isSelf,
      typing: (existing?.typing ?? false) || participant.typing,
    });
  }
  return people.size === 0 ? EMPTY_PEOPLE : [...people.values()];
}

export function threadPresenceName(person: ThreadPresencePerson): string {
  return person.displayName ?? person.email ?? "Member";
}

export function threadPresenceInitials(person: ThreadPresencePerson): string {
  if (!person.displayName) return person.email?.slice(0, 1).toUpperCase() ?? "?";
  const parts = person.displayName.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

function nameOf(person: ThreadPresencePerson): string {
  return threadPresenceName(person);
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
    const includeViewer = key.startsWith("all:");
    const ref = parseThreadKey(includeViewer ? key.slice(4) : key);
    let previousSnapshot: ThreadPresenceSnapshot | null = null;
    let previousValue = EMPTY_PEOPLE;
    return Atom.make((get): ReadonlyArray<ThreadPresencePerson> => {
      const snapshot = Option.getOrNull(
        AsyncResult.value(get(snapshotAtom({ environmentId: ref.environmentId, input: {} }))),
      );
      if (snapshot === previousSnapshot) {
        return previousValue;
      }
      previousSnapshot = snapshot;
      previousValue =
        snapshot === null
          ? EMPTY_PEOPLE
          : collapseThreadPresence(
              snapshot.participants,
              ref.threadId,
              snapshot.viewer ?? null,
              includeViewer,
            );
      return previousValue;
    }).pipe(
      Atom.setIdleTTL(PRESENCE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-presence-people:${key}`),
    );
  });

  return {
    /** Everyone else on this thread, for the thread view to render. */
    peopleAtom: (ref: ScopedThreadRef) => peopleAtomFamily(threadKey(ref)),
    participantsAtom: (ref: ScopedThreadRef) => peopleAtomFamily(`all:${threadKey(ref)}`),
    /** Tell the environment which thread this client is on and whether it is typing. */
    report: createEnvironmentRpcCommand(runtime, {
      label: "environment-thread-presence:report",
      tag: ORCHESTRATION_WS_METHODS.reportThreadPresence,
    }),
  };
}
