# Glossary

Terms whose meaning matters across Launchpad. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime Launchpad controls, such as Codex or Claude Code.                                          |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into Launchpad operations and events.                  |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

## Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.

## Org control plane

The cloud-side layer that owns organizations and the config they govern. Distinct from an
environment, which owns execution. The design lives in [tenancy.md](./tenancy.md) and
[machines.md](./machines.md); the decisions behind it in [docs/adr](../adr/).

### Relay

The cloud control plane, in `infra/relay`. Users know it as **Launchpad Connect**. It brokers
connectivity between clients and environments, and is becoming the owner of
organization-scoped data. _Avoid_: "the backend", "the server" — [server](#server) already
means something else.

### Server

The per-machine process in `apps/server`. Never use "server" for the [relay](#relay). When
referring to the machine and everything it owns rather than the process, say
[environment](#environment).

### Environment

One running server plus the machine, filesystem, provider credentials, and state it owns.
An environment is durably stateful: its `state.sqlite` holds the orchestration event store
and projections, and its checkpoints are git refs in its own workspaces.

### Organization

The unit of governance in the [relay](#relay). Every user belongs to exactly one, created
at signup unless they were invited into an existing one. An organization owns
[executors](#executor) and the config pushed to them.

### Org role

A member's standing in an [organization](#organization): `member` or `admin`. Organization-wide.
Admins own members, the [credential pool](#credential-pool), [executors](#executor), org
workflows, and quotas.

### Repository role

A member's standing on one [repository](#repository): `maintainer` or `developer`. Maintainers
configure the repository and override its workflow; developers work in it. Having no repository
role means having no access to that repository.

Both roles, organization membership, and invitations live in the [relay](#relay)'s own database.
Clerk provides **authentication only** — a sign-in and a verified subject id. Nothing about
tenancy is delegated to it.

### Invitation

A single-use, expiring token that moves its holder into an [organization](#organization) at a
stated [org role](#org-role). The [relay](#relay) stores only the token's hash, so the value
exists exactly once — in the response that created it. Redeeming one needs the token _and_ a
verified email address matching the invitation. Accepting means **leaving** the organization the
holder is currently in, which is why it is refused while that one still holds members or
repositories. See [tenancy.md](./tenancy.md).

### Repository

The relay-owned identity of a codebase, spanning every machine that checks it out. One
repository has many projects — one per checkout, on executors and on users'
own machines alike — and owns a set of [canonical keys](#canonical-key) by which those
checkouts recognise it ([ADR-0006][adr6]). Access control lives here: users are granted access
to a repository, not to an individual checkout. _Avoid_: "global project", "cloud project".

### Organization project catalog

A redacted, relay-owned discovery projection of the last project snapshot published by each
managed agent executor ([ADR-0014][adr14]). It keeps project titles, repository identity, and
machine association visible while an executor is offline, but carries no workspace path or thread
content. The project on its [environment](#environment) remains authoritative; catalog entries are
never command targets. The full event mirror in [ADR-0012][adr12] separately makes thread history
readable offline.

### Canonical key

A git remote reduced to `host/owner/repo` by `normalizeGitRemoteUrl`. The natural key that
associates a checkout with a [repository](#repository); a repository owns several, so mirrors
and forks resolve to the same one. Distinct from the repository's relay-minted id, which is
what access control and jobs actually reference.

### Cloud thread, local thread

A thread running in a project on an [executor](#executor) versus one on a user's
own machine. Not distinct types — the same thread concept, distinguished only by which
[environment](#environment) hosts it. Moving one to the other is deferred; see [ADR-0004][adr4].

### Executor

An [environment](#environment) whose compute the [relay](#relay) provisions and whose
config an [organization](#organization) governs. Executors are **long-lived** — provisioned
once and persisted across runs, because environment state is machine-local ([ADR-0001][adr1])
— and **single-tenant**: one executor serves exactly one organization ([ADR-0002][adr2]).
_Avoid_: "runner", "worker", "agent machine".

### Managed executor

An [executor](#executor) whose machine an organization buys through the product and the
relay provisions. Contrast **self-hosted machine**: compute the organization runs itself
and connects to the relay by hand — same record, same [enrollment](#enrollment), no compute
driver (`self_hosted` compute kind, either [machine role](#machine-role)). An admin creates
it in Settings → Organization, receives the enrollment seed exactly once, and runs the
setup command on the machine themselves. _Avoid_: "manual machine" — `manual` already
names a self-reported, non-routable endpoint.

### Enrollment

How a newly created machine proves to the [relay](#relay) that it is the machine the relay
just created: presenting a single-use seed inside a proof signed with its own fresh key.
The seed travels via the compute driver for a [managed executor](#managed-executor) and via
the admin for a self-hosted machine. Distinct from **linking**, the human-driven flow by
which a user connects their own [environment](#environment). See [ADR-0002][adr2].

### Environment credential

The secret that authenticates an [environment](#environment) to the [relay](#relay), stored
by the relay as a hash in `relay_environment_credentials`. Never a provider secret — see
[provider credential](#provider-credential).

### Provider account

An [organization](#organization)-owned sign-in or key for one provider: either
an environment variable the provider CLI reads, or the CLI's own auth store copied from the
device an admin signed in on. Held **sealed** by the [relay](#relay), one per provider per
organization; enrolled agent [executors](#executor) fetch the set over their environment
credential and place it before building each provider instance. See [ADR-0003][adr3],
organization provider accounts amendment.

### Provider credential

Former name for a [provider account](#provider-account) when the design held API keys in
Infisical and references at the relay. That design was superseded before it was built.

### Credential pool

Former name for the organization's set of [provider accounts](#provider-account). There is
no pool to select from: an organization holds at most one account per provider.

### Skill

A directory with a `SKILL.md` at its root that teaches an agent one thing — the
shape Claude Code, Codex, Cursor, and OpenCode all load. An **organization skill** is one the
[relay](#relay) holds for an [organization](#organization) and every enrolled agent
[executor](#executor) places for each provider CLI; a **project skill** lives in the repository
checkout and is not the relay's business. See [ADR-0016][adr16].

### Installation token

A short-lived GitHub App token the [relay](#relay) mints from an
[organization's](#organization) connected installation, on request, for an enrolled
[executor](#executor). Stored by neither side; it is what the executor's own git and `gh`
subprocesses authenticate with. Not a [provider credential](#provider-credential). See
[ADR-0015][adr15].

### Workflow

An ordered set of [steps](#step) describing how work gets implemented and reviewed. Layered:
a base workflow ships with the product, an [organization](#organization) adapts it into one or
more named workflows, and a [repository](#repository) selects one and may override any part of
it ([ADR-0007][adr7]).

### Step

One unit of a [workflow](#workflow), of kind `agent` (run a thread to settle), `action` (a
deterministic operation such as push or open a pull request), or `gate` (wait for a condition).
Agents never perform `action` operations — the [job runner](#job-runner) does ([ADR-0009][adr9]).

### Job

One run of a [workflow](#workflow) against a [repository](#repository). The [relay](#relay) owns
its coarse state — `queued → dispatched → running → awaiting_review → paused → done / failed` —
and nothing finer ([ADR-0005][adr5]).

### Job runner

The [executor](#executor)-side component that executes a [job](#job): materializes the project,
drives each [step](#step), evaluates gates, and reports transitions upward. The relay triggers;
the runner orchestrates.

### Work item

The durable unit of work an [organization](#organization) wants implemented. Either created in
the app or referencing an external issue, and owning a sequence of [jobs](#job) — which is what
makes a follow-up request meaningful rather than a fresh start. Distinct from `task`, which in
this codebase is a provider-runtime concept internal to a [session](#session).

### Trigger

What starts a [job](#job) on a [work item](#work-item): a person acting in the app, an external
state change such as an issue entering a watched column, or a follow-up request on work already
done.

### Integration

A connection to an external service. Jira and Linear connections are owned by a Launchpad user and carry that user's OAuth permissions. Their read access is granted to an individual prompt; organization membership does not share credentials. [Provider accounts](#provider-account) have a separate organization-sharing model.

### Mirror

A read replica of a thread's event log held by the [relay](#relay). Two exist and share
only their transport: the **organization mirror**, always on for [executors](#executor)
([ADR-0012][adr12]), and the **personal mirror**, opt-in per project on a machine a
person owns and readable by that person alone ([ADR-0013][adr13]). Neither is authoritative — the
[environment](#environment) remains the single ordered writer, and nothing dispatches against a
mirror.

### Job event

A fact the [relay](#relay) records about a [job](#job) — `paused`, `failed`, `completed`,
`review_app_ready` — or a custom one emitted by a `notify` [step](#step). The only thing
[subscriptions](#subscription) route on.

### Subscription

A rule routing [job events](#job-event) to a destination. Per organization or per
[repository](#repository); distinct from a person's device preferences, which route
[device alerts](#delivery) instead.

### Delivery

One attempt to get a message to a destination, with retry, dead-lettering, and per-attempt
failure recording (`relay_delivery_attempts`). A **device alert** is a delivery to one person's
device via APNs, driven by their awareness preferences. A **channel message** is a delivery to a
Slack or Teams channel, driven by a [subscription](#subscription). Two sources, one pipeline.

### Review app

A running instance of the customer's application, deployed from a branch so a human can click
through it before approving. Runs on the organization's own compute via a
`provision_review_app` [step](#step) ([ADR-0010][adr10]). _Avoid_: "review environment" —
[environment](#environment) already means a machine running a server.

### Machine role

What a relay-provisioned machine is for: an **agent executor** (runs [jobs](#job)) or a **review
host** (runs [review apps](#review-app)). One provisioning path, one enrollment story, two roles.

### Supervisor model

The model that answers approval requests during a [job](#job) in place of a human, returning
approve, deny, or escalate ([ADR-0008][adr8]). Configured per organization.

### Infisical project, Infisical environment

Infisical's own containers for secrets. Always qualified, never bare: unqualified
project and [environment](#environment) always mean ours.

## Flagged ambiguities

### Project config

Not a settings scope. It means the fields on the project aggregate that set defaults
for things created _inside_ that project — model selection, scripts, thread environment mode.
`ServerSettings` has **no project dimension**: `BackgroundPolicy` publishes one snapshot per
process, `observability` configures process-wide exporters, and `providerInstances` hydrate a
registry of long-lived managed servers. The test for whether a key belongs on a project: does it
influence what gets _created in_ the project, or does it configure _the machine_?

### Workspace

Overloaded, and deliberately **not** used as a domain term. It appears as `workspaceRoot`
(the filesystem path of a project), and in the
definition of worktree ("an isolated workspace for a thread"). A per-machine
checkout with its own config and threads is a **project**; the identity spanning machines is
a [repository](#repository). Do not introduce a fourth meaning.

### Task

Provider-runtime internal only — `RuntimeTaskId`, `task.started`, `task.progress`,
`task.completed`. It is a unit of agent work inside a [session](#session), **not** a unit of
product work. The thing a person wants built is a [work item](#work-item); one run of a workflow
against it is a [job](#job).

### Notification

Not a domain term — it has meant four different things: an APNs push to a device, an iOS Live
Activity, an in-app provider-update notice, and a message posted to a team channel. Say which:
[job event](#job-event) (the fact), [subscription](#subscription) (the routing rule), or
[delivery](#delivery) (the attempt, device alert or channel message).

### Author

The person who sent a user message, stamped on `thread.message-sent` from the
authenticated session's `AuthSessionUser` (see [environment-auth.md](./environment-auth.md#session-user)).
Present only for sessions minted through the [relay](#relay); a local session has none. A
snapshot of the name at send time, never re-resolved.

### Thread presence

Which connections are viewing a thread and whether they are typing. In-memory on the
[server](#server) (`orchestration/ThreadPresence.ts`), keyed by WebSocket connection, gone
with the connection; typing is a lease that lapses on its own. Streamed to clients through
`orchestration.subscribeThreadPresence`, never written to the event log. _Avoid_: "online
status" — it says nothing about a person, only about an open thread view.

### Session

Means the **live provider-backed runtime** attached to a thread — it dies and restarts many
times within one thread's life. When someone says "the session" and means the durable
conversation and its history, they mean thread. Stop, restart, and continue act on
a thread; the session is what churns underneath.

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
[adr14]: ../adr/0014-managed-projects-publish-a-redacted-organization-catalog.md
[adr15]: ../adr/0015-executors-borrow-the-organizations-github-installation.md
[adr16]: ../adr/0016-organization-skills-are-held-by-the-relay-and-placed-by-executors.md
