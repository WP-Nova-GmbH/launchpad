---
status: accepted
---

# Personal threads mirror to a user-scoped store the organization cannot read

Threads on a machine a person owns mirror to the [relay](../internals/glossary.md#relay) so their
history is readable when that machine is off. They land in a **user-scoped** store: access-controlled
to the subject alone, with no administrator path. This is a **second mirror**, not an extension of
[ADR-0012](./0012-executors-mirror-their-event-log-to-the-relay.md) — same transport, opposite
ownership.

## Why separate from the executor mirror

|  | executor mirror (ADR-0012) | personal mirror (this) |
|---|---|---|
| whose work | the organization's — it paid for the machine | the **user's** |
| legitimate readers | org members with repository access | the subject, and nobody else |
| on offboarding | stays with the organization | leaves with the user, or is deleted |
| enabled | always, for executors | **opt-in per project** |

A person has **one** T3 install. The organization's repository, a side project, and possibly work
for another client all produce threads in the same `state.sqlite`. A shared store — or a rule that
classifies visibility by whether the repository happens to be registered — puts that material in
front of their employer. Registration state is also the worst possible basis for a privacy
boundary: it can change without the user noticing, and it is wrong in both directions (personal
content in an org repository, org content in an unregistered one).

## Replication for reading, not multi-device writing

A thread has one authoritative environment
([ADR-0005](./0005-relay-owns-jobs-environments-own-threads.md)); two devices writing one thread is
the two-writers problem. The personal mirror is a **read replica**, exactly as the executor mirror
is. "Continue this on my other laptop" is thread portability
([ADR-0004](./0004-thread-portability-is-deferred-not-designed-away.md)), still deferred — and
"use it from my phone" already works by connecting to the machine that owns the thread. The gap
this closes is narrower and real: **reading your history when that machine is off**.

## Consequences

- **Offboarding is a flow that must exist.** When a person leaves an organization their personal
  threads are still theirs, so leaving must export or delete them — never silently transfer them.
  Nothing does this today.
- **Opt-in per project.** Uploading local work to a company-operated relay is a choice the machine's
  owner makes, consistent with [ADR-0007](./0007-the-org-layer-is-defaults-not-enforcement.md):
  nothing is imposed on a machine its owner controls.
- **The relay now holds personal data**, with deletion, export, and subject-access obligations that
  are stronger than for organization data. Indefinite retention as chosen for the executor mirror
  should not be assumed here without deciding it separately.
- **The two mirrors must not share a table or an access path.** A single store with a
  visibility column is one wrong query away from disclosure; separate stores make the mistake
  impossible rather than unlikely.
- **The guarantee depends on the relay being vendor-operated.** If a customer ever self-hosts the
  relay, "the organization cannot read it" stops being true — they run the database. Personal sync
  on a self-hosted relay would have to be disabled, disclosed, or end-to-end encrypted with a
  user-held key. Same lesson as ADR-0007: enforcement requires a substrate we control.
