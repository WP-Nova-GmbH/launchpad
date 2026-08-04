---
status: accepted
---

# Work items are durable, and follow-ups continue rather than restart

A [job](../internals/glossary.md#job) is not the top-level unit of product work. A **work item**
is: the durable thing an organization wants implemented, owning a sequence of jobs. A follow-up
request — "also change X" — **continues** the existing thread rather than starting a fresh job,
which pins that work item to the [executor](../internals/glossary.md#executor) holding its thread.

## Triggers

Three shapes, and they are not variations of one thing:

| trigger | shape | requires |
|---|---|---|
| a person acts in the app | imperative | nothing new |
| an issue enters a watched state | external state change | an [integration](../internals/glossary.md#integration), inbound webhooks, **and write-back** |
| a follow-up on completed work | continuation | knowing what was already implemented |

The third is why work items must be durable: "an issue that was implemented" is only meaningful
if something outlived the job that implemented it.

## Reference and snapshot

A work item referencing an external issue stores **both** the external id and a **snapshot of the
instruction text taken at dispatch**. The reference is what write-back needs — moving a column,
posting a pull-request link. The snapshot is what correctness needs: without it, editing the issue
mid-job silently changes what a running agent was told, and there is no way to reconstruct the
actual instruction afterwards. Same replayability requirement as
[ADR-0004](./0004-thread-portability-is-deferred-not-designed-away.md).

## Continuation

A follow-up reuses the thread, worktree, branch, and pull request on the executor that ran the
original job. The alternative — a new job each time — pays for a fresh clone and a cold re-reading
of the codebase on every round of review feedback, and discards reasoning the agent already did.

**This pins a work item to one machine.** Threads are machine-local
([ADR-0001](./0001-executors-are-long-lived-environments.md)) and thread portability is deferred
([ADR-0004](./0004-thread-portability-is-deferred-not-designed-away.md)), so there is no mechanism
to move a pinned work item. That is accepted, with a defined degraded path:

- executor available → continue the thread
- executor gone or unreachable → **new job on another executor**, fresh thread, same branch,
  surfaced as degraded rather than failing silently

Forking a work item's thread, or resetting it to start clean, are wanted and deferred.

## Consequences

- **Executor reclamation is a product decision, not an operations one.** Destroying an executor
  breaks continuation for every work item pinned to it. Since
  [ADR-0012](./0012-executors-mirror-their-event-log-to-the-relay.md) the history survives, so the
  failure mode is degraded — a follow-up starts a new job with a cold thread — rather than lost
  work. Reclamation should still warn about what it is unpinning.
- **Integrations are bidirectional and org-credentialed.** Reading issue state and writing back
  both use organization credentials held on the relay, never on a machine running agents — the
  same placement as chat tokens.
- Work items give the "box you drop a task definition into" a home, and give the app a unit to
  show progress against that survives more than one run.
