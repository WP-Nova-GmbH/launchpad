---
status: accepted
---

# Thread portability is deferred to v1.1, not designed away

Moving a thread from an [executor](../internals/glossary.md#executor) to a user's own machine
— "pull this cloud session into my local session and keep working" — is a wanted feature and
is **out of scope for v1**. It is recorded here rather than dropped because decisions taken
before it ships can quietly make it impossible, and this ADR states what must stay true so
that it remains a feature we can build rather than a rewrite.

## Why it is deferred

Near-term the need is mostly served without moving anything: a client already connects to an
environment over WebSocket, subscribes with `orchestration.subscribeThread`, and steers with
`orchestration.dispatchCommand`. Pointed at an executor, that gives live viewing plus
stop/restart/continue on a cloud thread. What a user usually wants is to _keep going_, not to
have the thread on their laptop. The genuine driver for a real migration is offline work.

## A second, independent argument for building it

[ADR-0011](./0011-work-items-are-durable-and-follow-ups-continue.md) makes follow-ups continue an
existing thread, which **pins a work item to the executor holding it**. With no portability, a
pinned work item cannot be moved, and destroying that executor strands it. So portability is
wanted for two unrelated reasons now — offline work, and unpinning work items from machines — and
the second one grows with the number of long-lived work items in flight.

## The events half is already solved

[ADR-0012](./0012-executors-mirror-their-event-log-to-the-relay.md) mirrors executor event logs to
the relay. A future migration therefore needs to move only checkpoints and re-materialize a
worktree — the event log is already central and replayable. That materially lowers the cost of
building this, without changing the decision to defer it.

## Invariants to preserve

Thread state is machine-local by design ([ADR-0001](./0001-executors-are-long-lived-environments.md)),
so a future migration means moving **both** halves of it. Until it ships, do not break these:

- **Thread events stay self-contained.** No executor-only identifiers, absolute host paths, or
  machine-specific handles baked into event payloads. An event log must be replayable on a
  different machine.
- **Checkpoints stay plain git refs.** `refs/t3/checkpoints/*` under a normal object store is
  what makes checkpoint history movable with `git fetch`. Moving checkpoints into a bespoke
  non-git store would strand every existing thread.
- **Identity stays machine-independent.** A [repository](../internals/glossary.md#repository)
  id is relay-minted and identical everywhere; `workspaceRoot` remains the _only_
  machine-specific field on a project.
- **Projects accept externally-supplied ids.** `ProjectCreateCommand` already takes `projectId`
  in the payload; a migrated thread must be able to land in a project whose id is chosen
  elsewhere.

## Consequences

- v1 answers "I want to take this over" with _attach to the executor and continue there_.
- Anything that would violate an invariant above needs this ADR revisited first, not worked
  around.
