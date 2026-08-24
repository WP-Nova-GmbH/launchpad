---
status: accepted
---

# Executors mirror their full event log to the relay

[Executors](../internals/glossary.md#executor) stream their complete orchestration event log to
the [relay](../internals/glossary.md#relay) over the persistent channel, into an
**organization-scoped** store. Checkpoints are **not** mirrored.

Machines a person owns are covered separately by
[ADR-0013](./0013-personal-threads-mirror-to-a-user-scoped-store.md): they mirror too, but opt-in
and into a **user-scoped** store the organization cannot read. The two stores share a transport and
nothing else.

[ADR-0014](./0014-managed-projects-publish-a-redacted-organization-catalog.md) allows a much smaller,
redacted project-discovery projection to precede this mirror. That catalog does not contain or
replace thread history.

## Why

Three things fall out of one mechanism:

- **Reclaiming a machine stops destroying the record.** Previously, destroying an executor
  destroyed the thread history it held ([ADR-0001](./0001-executors-are-long-lived-environments.md))
  and orphaned every work item pinned to it
  ([ADR-0011](./0011-work-items-are-durable-and-follow-ups-continue.md)).
- **A cloud thread stays readable when its executor is offline.** Clients connect directly to
  environments, so today an offline executor means its history is simply unavailable.
- **Thread portability gets much cheaper.** [ADR-0004](./0004-thread-portability-is-deferred-not-designed-away.md)
  requires event logs to be self-contained and replayable elsewhere. If they are already mirrored,
  the events half of a migration is solved and only checkpoints remain.

Personal machines were originally excluded here on privacy grounds. That concern was right but the
conclusion was too broad: the problem is _where the data lands and who can read it_, not mirroring
itself. ADR-0013 resolves it with a separate user-scoped store rather than by declining the
feature.

## What is not mirrored

**Checkpoints stay on the machine.** They are bulk git objects, and their value is largely
superseded once the branch is pushed and a pull request exists — the diff a reviewer wants is on
the pull request, not in `refs/t3/checkpoints/*`. Losing them costs intra-thread revert, not the
work. Mirroring them would mean shipping every intermediate working-tree state off the machine, at
a cost far above what it buys.

## The mirror is derived, never authoritative

The executor remains the single ordered writer for thread facts
([ADR-0005](./0005-relay-owns-jobs-environments-own-threads.md)). The relay's copy is a read
replica: it is written only by the mirror stream, and nothing may dispatch commands against it.
Treating it as writable would recreate exactly the two-authorities problem that seam exists to
avoid.

## Mechanics

Batched, with sequence-number-based resume — not a push per event. AGENTS.md names "sending too
much data over websockets" as a known performance sin in this codebase, and this is the largest new
data flow in the design. Volume is bounded by job activity rather than by all usage, which is the
main reason the personal-machine exclusion matters beyond privacy.

## Consequences

- **Retention applies to this store only.** Organization-scoped mirrored events are retained
  indefinitely; personal-mirror retention is decided separately in ADR-0013 and must not inherit
  this default.
- **Mirrored events are retained indefinitely.** There is no expiry or rollup; relay storage grows
  with job activity forever. Events are append-only and go cold once a job settles, so tiering old
  ranges out of Postgres is available later as an optimization, not a prerequisite.
- **Indefinite retention is a default, not an exemption from deletion.** Offboarding an
  organization, removing a repository, and honouring an erasure request all still need a delete
  path. Mirrored events contain message content and code, so this is the first place the design
  accumulates customer data at rest beyond connectivity metadata.
- Executor reclamation becomes an ordinary operation for the _record_, though it still discards the
  live worktree, checkpoint history, and the ability to continue a pinned work item in place.
- The relay can serve thread history for clients directly, which is a new read path distinct from
  the direct client↔executor connection and must not be confused with it.
