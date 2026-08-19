# Glossary

> For maintainers. Using T3 Code? See [docs/user](../user/).

This is a living glossary for T3 Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)
- [Org control plane](#org-control-plane)
- [Flagged ambiguities](#flagged-ambiguities)

## Concepts

### Project and workspace

#### Project

One checkout of a [repository](#repository) on one machine — the unit that owns its own config and its own threads. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Five drivers ship built in: Codex, Claude, Cursor, Grok, and OpenCode. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Org control plane

The cloud-side layer that owns organizations and the config they govern. Distinct from an
environment, which owns execution.

#### Relay

The cloud control plane, in `infra/relay`. Users know it as **T3 Connect**. It brokers
connectivity between clients and environments, and is becoming the owner of
organization-scoped data. _Avoid_: "the backend", "the server" — [server](#server) already
means something else.

#### Server

The per-machine process in `apps/server`. Never use "server" for the [relay](#relay). When
referring to the machine and everything it owns rather than the process, say
[environment](#environment).

#### Environment

One running server plus the machine, filesystem, provider credentials, and state it owns.
An environment is durably stateful: its `state.sqlite` holds the orchestration event store
and projections, and its checkpoints are git refs in its own workspaces.

#### Organization

The unit of governance in the [relay](#relay). Every user belongs to exactly one, created
at signup unless they were invited into an existing one. An organization owns
[executors](#executor) and the config pushed to them.

#### Org role

A member's standing in an [organization](#organization): `member` or `admin`. Organization-wide.
Admins own members, the [credential pool](#credential-pool), [executors](#executor), org
workflows, and quotas.

#### Repository role

A member's standing on one [repository](#repository): `maintainer` or `developer`. Maintainers
configure the repository and override its workflow; developers work in it. Having no repository
role means having no access to that repository.

Both roles, organization membership, and invitations live in the [relay](#relay)'s own database.
Clerk provides **authentication only** — a sign-in and a verified subject id. Nothing about
tenancy is delegated to it.

#### Invitation

A single-use, expiring token that moves its holder into an [organization](#organization) at a
stated [org role](#org-role). The [relay](#relay) stores only the token's hash, so the value
exists exactly once — in the response that created it. Redeeming one needs the token _and_ a
verified email address matching the invitation. Accepting means **leaving** the organization the
holder is currently in, which is why it is refused while that one still holds members or
repositories. See [tenancy.md](./tenancy.md).

#### Repository

The relay-owned identity of a codebase, spanning every machine that checks it out. One
repository has many [projects](#project) — one per checkout, on executors and on users'
own machines alike — and owns a set of [canonical keys](#canonical-key) by which those
checkouts recognise it ([ADR-0006][adr6]). Access control lives here: users are granted access
to a repository, not to an individual checkout. _Avoid_: "global project", "cloud project".

#### Canonical key

A git remote reduced to `host/owner/repo` by `normalizeGitRemoteUrl`. The natural key that
associates a checkout with a [repository](#repository); a repository owns several, so mirrors
and forks resolve to the same one. Distinct from the repository's relay-minted id, which is
what access control and jobs actually reference.

#### Cloud thread, local thread

A [thread](#thread) running in a project on an [executor](#executor) versus one on a user's
own machine. Not distinct types — the same thread concept, distinguished only by which
[environment](#environment) hosts it. Moving one to the other is deferred; see [ADR-0004][adr4].

#### Executor

An [environment](#environment) whose compute the [relay](#relay) provisions and whose
config an [organization](#organization) governs. Executors are **long-lived** — provisioned
once and persisted across runs, because environment state is machine-local ([ADR-0001][adr1])
— and **single-tenant**: one executor serves exactly one organization ([ADR-0002][adr2]).
_Avoid_: "runner", "worker", "agent machine".

#### Managed executor

An [executor](#executor) whose machine an organization buys through the product and the
relay provisions. Contrast **self-hosted executor**: a machine the organization runs itself
and registers with the relay. Only managed executors exist today.

#### Enrollment

How a newly provisioned [executor](#executor) proves to the [relay](#relay) that it is the
machine the relay just created. Distinct from **linking**, the human-driven flow by which a
user connects their own [environment](#environment). See [ADR-0002][adr2].

#### Environment credential

The secret that authenticates an [environment](#environment) to the [relay](#relay), stored
by the relay as a hash in `relay_environment_credentials`. Never a provider secret — see
[provider credential](#provider-credential).

#### Provider credential

An [organization](#organization)-owned secret (an API key) for a [provider](#provider),
stored in Infisical. The [relay](#relay) holds only a reference to it; the
[executor](#executor) resolves that reference itself at provider session start. See
[ADR-0003][adr3].

#### Credential pool

The catalogue of [provider credentials](#provider-credential) an organization holds. A
**scoped set** that admins bind to executors — not a rotation mechanism. Selection from the
pool happens at provider session start, because provider secrets reach a provider as
process environment variables and are fixed at spawn.

#### Workflow

An ordered set of [steps](#step) describing how work gets implemented and reviewed. Layered:
a base workflow ships with the product, an [organization](#organization) adapts it into one or
more named workflows, and a [repository](#repository) selects one and may override any part of
it ([ADR-0007][adr7]).

#### Step

One unit of a [workflow](#workflow), of kind `agent` (run a thread to settle), `action` (a
deterministic operation such as push or open a pull request), or `gate` (wait for a condition).
Agents never perform `action` operations — the [job runner](#job-runner) does ([ADR-0009][adr9]).

#### Job

One run of a [workflow](#workflow) against a [repository](#repository). The [relay](#relay) owns
its coarse state — `queued → dispatched → running → awaiting_review → paused → done / failed` —
and nothing finer ([ADR-0005][adr5]).

#### Job runner

The [executor](#executor)-side component that executes a [job](#job): materializes the project,
drives each [step](#step), evaluates gates, and reports transitions upward. The relay triggers;
the runner orchestrates.

#### Work item

The durable unit of work an [organization](#organization) wants implemented. Either created in
the app or referencing an external issue, and owning a sequence of [jobs](#job) — which is what
makes a follow-up request meaningful rather than a fresh start. Distinct from `task`, which in
this codebase is a provider-runtime concept internal to a [session](#session).

#### Trigger

What starts a [job](#job) on a [work item](#work-item): a person acting in the app, an external
state change such as an issue entering a watched column, or a follow-up request on work already
done.

#### Integration

An [organization](#organization)-level connection to an external service — Linear, Slack, Teams.
Credentials live on the [relay](#relay) and never reach a machine where agents run shell
commands. Integrations are bidirectional: the relay reads issue state and writes back, moving
columns and posting links.

#### Mirror

A read replica of a [thread](#thread)'s event log held by the [relay](#relay). Two exist and share
only their transport: the **organization mirror**, always on for [executors](#executor)
([ADR-0012][adr12]), and the **personal mirror**, opt-in per [project](#project) on a machine a
person owns and readable by that person alone ([ADR-0013][adr13]). Neither is authoritative — the
[environment](#environment) remains the single ordered writer, and nothing dispatches against a
mirror.

#### Job event

A fact the [relay](#relay) records about a [job](#job) — `paused`, `failed`, `completed`,
`review_app_ready` — or a custom one emitted by a `notify` [step](#step). The only thing
[subscriptions](#subscription) route on.

#### Subscription

A rule routing [job events](#job-event) to a destination. Per organization or per
[repository](#repository); distinct from a person's device preferences, which route
[device alerts](#delivery) instead.

#### Delivery

One attempt to get a message to a destination, with retry, dead-lettering, and per-attempt
failure recording (`relay_delivery_attempts`). A **device alert** is a delivery to one person's
device via APNs, driven by their awareness preferences. A **channel message** is a delivery to a
Slack or Teams channel, driven by a [subscription](#subscription). Two sources, one pipeline.

#### Review app

A running instance of the customer's application, deployed from a branch so a human can click
through it before approving. Runs on the organization's own compute via a
`provision_review_app` [step](#step) ([ADR-0010][adr10]). _Avoid_: "review environment" —
[environment](#environment) already means a machine running a server.

#### Machine role

What a relay-provisioned machine is for: an **agent executor** (runs [jobs](#job)) or a **review
host** (runs [review apps](#review-app)). One provisioning path, one enrollment story, two roles.

#### Supervisor model

The model that answers approval requests during a [job](#job) in place of a human, returning
approve, deny, or escalate ([ADR-0008][adr8]). Configured per organization.

#### Infisical project, Infisical environment

Infisical's own containers for secrets. Always qualified, never bare: unqualified
[project](#project) and [environment](#environment) always mean ours.

## Flagged ambiguities

#### Project config

Not a settings scope. It means the fields on the [project](#project) aggregate that set defaults
for things created _inside_ that project — model selection, scripts, thread environment mode.
`ServerSettings` has **no project dimension**: `BackgroundPolicy` publishes one snapshot per
process, `observability` configures process-wide exporters, and `providerInstances` hydrate a
registry of long-lived managed servers. The test for whether a key belongs on a project: does it
influence what gets _created in_ the project, or does it configure _the machine_?

#### Workspace

Overloaded, and deliberately **not** used as a domain term. It appears as `workspaceRoot`
(the filesystem path of a [project](#project)), in [workspace-layout.md][2], and in the
definition of [worktree](#worktree) ("an isolated workspace for a thread"). A per-machine
checkout with its own config and threads is a **project**; the identity spanning machines is
a [repository](#repository). Do not introduce a fourth meaning.

#### Task

Provider-runtime internal only — `RuntimeTaskId`, `task.started`, `task.progress`,
`task.completed`. It is a unit of agent work inside a [session](#session), **not** a unit of
product work. The thing a person wants built is a [work item](#work-item); one run of a workflow
against it is a [job](#job).

#### Notification

Not a domain term — it has meant four different things: an APNs push to a device, an iOS Live
Activity, an in-app provider-update notice, and a message posted to a team channel. Say which:
[job event](#job-event) (the fact), [subscription](#subscription) (the routing rule), or
[delivery](#delivery) (the attempt, device alert or channel message).

#### Session

Means the **live provider-backed runtime** attached to a thread — it dies and restarts many
times within one thread's life. When someone says "the session" and means the durable
conversation and its history, they mean [thread](#thread). Stop, restart, and continue act on
a thread; the session is what churns underneath.

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]
- [Tenancy](./tenancy.md)
- [Machines](./machines.md)

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[adr1]: ../adr/0001-executors-are-long-lived-environments.md
[adr2]: ../adr/0002-executor-enrollment-and-tenancy.md
[adr3]: ../adr/0003-provider-credentials-are-fetched-by-executors-not-pushed.md
[adr4]: ../adr/0004-thread-portability-is-deferred-not-designed-away.md
[adr5]: ../adr/0005-relay-owns-jobs-environments-own-threads.md
[adr6]: ../adr/0006-repositories-own-a-set-of-canonical-keys.md
[adr7]: ../adr/0007-the-org-layer-is-defaults-not-enforcement.md
[adr8]: ../adr/0008-job-approvals-are-resolved-by-a-supervisor-model.md
[adr9]: ../adr/0009-workflow-steps-have-kinds-and-agents-never-push.md
[adr10]: ../adr/0010-review-apps-run-on-org-compute.md
[adr12]: ../adr/0012-executors-mirror-their-event-log-to-the-relay.md
[adr13]: ../adr/0013-personal-threads-mirror-to-a-user-scoped-store.md
