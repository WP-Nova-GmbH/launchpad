---
status: accepted
---

# The relay owns jobs; environments own threads

Adding organization pipelines gives us two orchestrators: the relay, which dispatches and
tracks pipeline work, and the environment's existing event-sourced `OrchestrationEngine`,
which owns threads and turns. The relay is authoritative for **coarse job state** and for
routing user intent; the environment remains authoritative for **everything inside a
thread**. The relay never models a turn.

## The seam

| Relay | Environment |
|---|---|
| `queued → dispatched → running → awaiting_review → paused → done / failed` | turns, messages, tool calls, approvals, diffs, checkpoints |
| which [executor](../internals/glossary.md#executor), which [repository](../internals/glossary.md#repository), which thread id | what an approval is actually asking |
| which workflow the organization defined for this trigger | which agents run within a step, and in what order |
| user intent: start, pause, continue, cancel, modify | the effect of that intent on thread state |

A pipeline step compiles down to: *create thread T in project P on executor E, with these
instructions, this provider instance, this runtime mode — report when it settles.*

## Why the seam is coarse

`OrchestrationEngine` is deliberately the single ordered writer for thread facts: one fiber
takes commands from a queue, and event append, projection, and the command receipt commit in
one SQL transaction. If the relay were also authoritative over turn-level state there would be
two writers for the same truth and no arbiter, and every reconciliation defect would present
as a race. A coarse seam leaves exactly one authority per fact at every level.

## Job status reuses the awareness feed

Environments already publish `RelayAgentActivityState` per `(environmentId, threadId)` with
phases `starting | running | waiting_for_approval | waiting_for_input | completed | failed |
stale`. That is precisely the step-transition signal a job orchestrator needs. It is promoted
from notification input to job-state input rather than duplicated by a second reporting path.

## Consequences

- The relay cannot answer "what did the agent actually do in step 2." Clients get that from
  the environment.
- Pipeline definitions live in the relay; the *execution* of a step — which agents, which
  order, which reviews — happens inside the job on the executor.
- Awareness publishing stops being optional for executors: it is now load-bearing for job
  progress, not just for notifications.
