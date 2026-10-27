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
| which repository workflow matched this trigger                                                                                | which agents run within a step, and in what order          |
| user intent: start, pause, continue, cancel, modify                                                                           | the effect of that intent on thread state                  |

A pipeline step compiles down to: _create thread T in project P on executor E, with these
instructions, this provider instance, this runtime mode — report when it settles._

A repository workflow selects its execution environment explicitly. V1 targets enrolled
organization environments, including self-hosted machines, so jobs and human checkpoints use
repository-shared access. Owner-only personal environments would require a separate sharing
policy before they can host repository workflows. Event-triggered jobs stay
queued at the relay while that environment is offline, rather than being routed to another
machine. This keeps the chosen checkout and execution context predictable, and lets the relay
accept external events independently of environment availability. Queued jobs use the workflow's
current definition when dispatched. Once execution starts, that definition stays fixed through
human checkpoints and rework; later workflow edits apply to queued and future jobs.

Withdrawing an automation connection or its repository authorization stops new event admission
and queued jobs that have not entered a job handoff. A job already being offered may finish
starting and continue with its frozen instructions; use Cancel run to stop it. A missing reply
cannot prove whether work started, so withdrawal does not interrupt reconciliation of that same
handoff. If the environment confirms that it did not start the job, its return to the queue
requires current source authorization before a later handoff.

A signed provider occurrence and all its matching queued jobs commit in one relay transaction.
Retain its semantic identity even when it matches no workflow: retries cannot reinterpret old events
after an edit or a later enable. A trigger Save and admission serialize on the same logical source;
new criteria apply strictly after the database-clock Save boundary. Queued-job admission is separate
from execution handoff and cannot depend on environment availability or provider refresh HTTP.

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

Workspace preparation retains ownership of its setup work, including background programs that
outlive the command that started them. Intermediate Review approvals advance the workflow while
retaining the job's workspace and setup ownership. They do not stop setup programs or previews:
later Agent steps and rework can keep using them without rerunning setup. Each Review still checks
its saved result; unexpected changes block approval. Final job completion confirms setup stopped
and verifies the final result before releasing the workspace; cancellation also requires confirmed
cleanup before release. Current process ancestry alone cannot establish that all of the job's setup
work has stopped.
A manual workflow pause is a separate durable hold on automatic step advancement. The reserved
Agent step, including preparation, finishes at its finalized checkpoint before acknowledging the
hold. Keep the underlying human wait or failure state: Resume removes only that hold. Setup and
previews retain their existing ownership while paused. Accepted holds survive executor restart;
the compatible-reader barrier prevents older servers from silently ignoring them.

Automatic cleanup covers ordinary job-owned background programs. Docker-managed containers
and system services have separately managed lifecycles; projects using them arrange their
cleanup. Their automatic cleanup is outside this workflow slice.

When the planned VM support is introduced, revisit how the VM boundary owns setup work and
confirms cleanup, including VM lifetime, restart recovery, services started inside the VM,
and the effect on other jobs sharing compute. This is an explicit follow-up before VM support ships; the current setup ownership
decision does not decide whether a VM belongs to one job or a long-lived environment.

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

Deleting or archiving a shared thread confirms that its setup work has stopped before hiding
the thread, including previews left running after the setup command finished. If shutdown cannot
be confirmed, the thread stays visible with its queue paused, an explanation, and a way to retry
Stop. Hiding it first would remove the team's recovery path while setup may still be running.
Once deletion or archiving reports failure, that request ends. A later setup exit does not hide
the thread; someone must explicitly request deletion or archiving again after recovery.

Restarting a setup terminal confirms that its setup work stopped before opening a fresh shell.
It does not repeat the setup recipe; rerunning preparation remains an explicit action because
it can repeat side effects.

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
