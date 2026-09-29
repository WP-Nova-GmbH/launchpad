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

| Relay                                                                                                                         | Environment                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `queued → dispatched → running → awaiting_review → paused → done / failed`                                                    | turns, messages, tool calls, approvals, diffs, checkpoints |
| which [executor](../internals/glossary.md#executor), which [repository](../internals/glossary.md#repository), which thread id | what an approval is actually asking                        |
| which workflow the organization defined for this trigger                                                                      | which agents run within a step, and in what order          |
| user intent: start, pause, continue, cancel, modify                                                                           | the effect of that intent on thread state                  |

A pipeline step compiles down to: _create thread T in project P on executor E, with these
instructions, this provider instance, this runtime mode — report when it settles._

## Why the seam is coarse

`OrchestrationEngine` is deliberately the single ordered writer for thread facts: one fiber
takes commands from a queue, and event append, projection, and the command receipt commit in
one SQL transaction. If the relay were also authoritative over turn-level state there would be
two writers for the same truth and no arbiter, and every reconciliation defect would present
as a race. A coarse seam leaves exactly one authority per fact at every level.

## Shared prompt queue

People may submit prompts to a shared thread concurrently, without handing control from one
person to another. The environment owns one pending prompt queue, ordered by when it accepts
each submission and visible to everyone authorized to access the thread. Client-local queues
hide other people's pending input and cannot establish one shared acceptance order.

Creating a shared thread durably accepts the thread and its first queued prompt together,
before workspace preparation begins. Required preparation gates delivery, not ownership: if it
fails, the thread and accepted prompts remain, with the queue paused. Rolling back the thread
would discard shared work, including prompts accepted from teammates while preparation was running.

The existing setup-script setting determines what preparation must complete before delivery.
Background setup remains the default and its failure does not pause the queue or stop the agent.
When a script is configured to wait before the agent starts, it must finish successfully; failure
to launch or a failed exit pauses the queue before delivery. This preserves the explicit choice
to run background work while making a required setup failure visible before dependent work starts.

Required preparation interrupted by a server restart stays paused until an authorized teammate
explicitly retries preparation and resumes the queue. Reconnecting alone must not rerun setup
scripts: they may have partially completed before the interruption, so retrying can repeat their
effects. Successful required preparation after that explicit retry permits queued work to continue.

Once the environment acknowledges a queued prompt, closing or restarting the sender's app does
not remove it or pause delivery. Accepted work belongs to the shared thread and continues under
the queue's existing state, independently of the submitting client's connection.
The same ownership applies if the submitter later loses repository access: accepted entries
remain shared work, while further submissions or edits require current access. See
[shared-thread access](../internals/tenancy.md#shared-thread-access).

While the agent is running, sending a prompt queues it by default. Queued prompts wait until
the current turn completes successfully; a tool completion alone does not release them. A person
may explicitly steer a queued prompt into the running turn, making a change to ongoing work an
intentional action.

Anyone authorized to send prompts to the thread may steer a queued entry, including another
person's submission. The prompt retains its original author; who steered it is recorded and shown
separately so delivering someone's words never changes their attribution.

Anyone with access to the thread may edit any queued prompt, regardless of who submitted it.
Queued instructions are shared work; editing them does not require the submitter's approval.
Attribution distinguishes "Submitted by" from "Edited by": keep the original submitter and the
latest editor visible both while queued and after delivery, so an edit is never presented as
someone else's original wording.

Shared-thread prompts carry the same authenticated attribution into the agent's context:
the original submitter, latest editor when present, and the person who steered an entry when
applicable. This lets the shared agent distinguish teammates' contributions and understand
references to them. Attribution describes the conversation; authorization remains the
environment's responsibility.

Concurrent edits must not silently overwrite each other. If a queued prompt changed after a
person began editing it, preserve their draft and require them to review the current entry before
saving a replacement.

Stopping a shared thread interrupts its running turn and pauses automatic delivery from its
shared queue. Pending prompts remain visible and retained until someone explicitly resumes the
queue; stopping work must not immediately start the next person's queued prompt.

Deleting a shared thread waits for confirmation that its required setup has stopped. If shutdown
cannot be confirmed, the thread stays visible with its queue paused, an explanation, and a way to
retry Stop. Hiding it first would remove the team's recovery path while setup may still be running.
Once deletion reports failure, that request ends. A later setup exit does not delete the thread;
someone must explicitly request deletion again after recovery.

Failed turns and provider usage limits also pause automatic delivery, retain all pending prompts,
and show why the queue paused. A teammate must explicitly resume it after addressing the problem;
later instructions may depend on the work that failed and must not automatically run past it.

Delivery and transcript admission are separate durable facts. An entry enters the transcript only
after the provider acknowledges it or the harness consumes it. A process can crash between that
handoff and recording its outcome, so recovery pauses uncertain deliveries for explicit review;
it cannot promise exactly-once execution across every provider. A completed provider turn releases
the next entry only after checkpoint finalization also succeeds.

Activating shared queues or repository policy marks the database as requiring a compatible reader.
Older servers tolerate unknown migration IDs, so adding a migration alone would let a rollback
silently ignore this state. The migration guard in
[Migrations.ts](../../apps/server/src/persistence/Migrations.ts) recognizes the new reader marker;
older servers reject it before serving requests. Draining a queue does not remove that barrier.

## Job status reuses the awareness feed

Environments already publish `RelayAgentActivityState` per `(environmentId, threadId)` with
phases `starting | running | waiting_for_approval | waiting_for_input | completed | failed |
stale`. That is precisely the step-transition signal a job orchestrator needs. It is promoted
from notification input to job-state input rather than duplicated by a second reporting path.

## Consequences

- The relay cannot answer "what did the agent actually do in step 2." Clients get that from
  the environment.
- Pipeline definitions live in the relay; the _execution_ of a step — which agents, which
  order, which reviews — happens inside the job on the executor.
- Awareness publishing stops being optional for executors: it is now load-bearing for job
  progress, not just for notifications.
