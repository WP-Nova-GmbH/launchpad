# Org Control Plane Foundation

## Purpose

Turn T3 Code from a per-machine, locally-authoritative tool into an organization-governed
platform, without taking anything away from local use.

The product goal:

- organizations exist, own config, and own the machines their agents run on
- organizations buy **managed executors**; the relay provisions and governs them
- organization admins hold provider credentials centrally; executors use them without
  anyone copying keys around
- a human action triggers an implementation workflow that runs as a job on an executor,
  visible and steerable from any client
- a developer working locally is unaffected — their machine stays theirs

This plan covers the **foundation** — tenancy, machines, config, and the job seam — and the
**pipeline layer** that sits on it: workflows, the job runner, supervised approvals, review apps,
and deliveries.

Vocabulary for everything below is in [docs/internals/glossary.md](../docs/internals/glossary.md),
`Org control plane` section. Decisions are recorded as ADR-0001 … ADR-0012 in
[docs/adr/](../docs/adr/).

## Current State

What exists today, verified against the code:

**Config is per-machine and locally authoritative.**

- `ServerSettings` lives in one `settings.json` under the environment's state dir
  (`apps/server/src/config.ts`), loaded through a `Cache` + `PubSub` + `Semaphore` +
  `fs.watch` service (`apps/server/src/serverSettings.ts`).
- It is written **sparse** — `stripDefaultServerSettings` removes any value equal to its
  default, so "unset" and "explicitly default" are indistinguishable on disk.
- Clients read and patch it over WebSocket RPC (`server.getSettings`, `server.updateSettings`)
  at `orchestration.operate` scope — the same scope every paired client holds.
- Sensitive provider environment variables are split out into `ServerSecretStore`, which is
  **files on disk, mode `0600` in a `0700` directory, unencrypted**.
- `ClientSettings` never reach the server at all: they persist per device in browser
  `localStorage` or via the desktop bridge (`apps/web/src/localApi.ts`).

**The relay is a connectivity broker with zero product config.**

- A Cloudflare Worker deployed by Alchemy (`infra/relay/alchemy.run.ts`,
  `infra/relay/src/worker.ts`), backed by PlanetScale Postgres through Hyperdrive, with
  Drizzle and file-based migrations.
- Eight tables (`infra/relay/src/persistence/schema.ts`): environment links, managed endpoint
  allocations, tunnel limits, environment credentials, mobile devices, live activities, agent
  activity rows, DPoP proofs, delivery attempts. **Every one is keyed by a Clerk `userId`.**
- Three auth middlewares: `RelayClientAuth` (Clerk bearer, verified per request),
  `RelayDpopClientAuth` (relay-minted DPoP token, 30-minute TTL), and `RelayEnvironmentAuth`
  (credential hash → `environmentId` only — **no user, no Clerk, ever**).
- Two signed-JWT legs between relay and environment: environment→relay `publishAgentActivity`,
  and relay→environment `/api/t3-connect/health` and `/api/t3-connect/mint-credential`.
- **No WebSocket and no Durable Objects.** Request/response, a queue consumer, and a cron.

**Managed endpoints already work, outbound-only.**

The relay provisions a Cloudflare Tunnel and DNS record per environment
(`ManagedEndpointProvider`), returns a connector token, and the environment runs `cloudflared`
as a child process with `TUNNEL_TOKEN` (`apps/server/src/cloud/ManagedEndpointRuntime.ts`).
No inbound port is ever opened.

**Orchestration state is machine-local.**

`state.sqlite` holds the event store and its projections; checkpoints are git refs at
`refs/t3/checkpoints/<threadId>/turn/<n>`. `OrchestrationEngine` is a single-fiber, totally
ordered command processor committing event append, projection, and receipt in one SQL
transaction. `ProjectCreateCommand` accepts a **caller-supplied** `projectId`.

**Gaps this plan closes:**

- No organization or tenancy concept anywhere in the relay.
- No product config in the relay — no projects, no provider settings, no pipelines.
- No project identity spanning machines: two checkouts of one repo are two unrelated
  `ProjectId`s.
- No enrollment path for a machine with no human — the link flow requires a signed-in user who
  already has access to the environment.
- No per-project config scope.
- No job model, and no channel to dispatch one.

## Decisions

| | |
|---|---|
| [ADR-0001](../docs/adr/0001-executors-are-long-lived-environments.md) | Executors are long-lived environments, not ephemeral workers |
| [ADR-0002](../docs/adr/0002-executor-enrollment-and-tenancy.md) | Per-instance seeded enrollment; executors are single-tenant |
| [ADR-0003](../docs/adr/0003-provider-credentials-are-fetched-by-executors-not-pushed.md) | Provider credentials live in Infisical and are fetched by executors |
| [ADR-0004](../docs/adr/0004-thread-portability-is-deferred-not-designed-away.md) | Thread portability deferred to v1.1, with invariants to preserve |
| [ADR-0005](../docs/adr/0005-relay-owns-jobs-environments-own-threads.md) | The relay owns jobs; environments own threads |
| [ADR-0006](../docs/adr/0006-repositories-own-a-set-of-canonical-keys.md) | Repositories own a set of canonical keys; executors refuse unregistered ones |
| [ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md) | The org layer supplies defaults and authorship, not enforcement |
| [ADR-0008](../docs/adr/0008-job-approvals-are-resolved-by-a-supervisor-model.md) | Job approvals are resolved by a supervisor model that escalates on uncertainty |
| [ADR-0009](../docs/adr/0009-workflow-steps-have-kinds-and-agents-never-push.md) | Workflow steps have kinds; agents never perform irreversible operations |
| [ADR-0010](../docs/adr/0010-review-apps-run-on-org-compute.md) | Review apps run on the organization's own compute |
| [ADR-0011](../docs/adr/0011-work-items-are-durable-and-follow-ups-continue.md) | Work items are durable; follow-ups continue rather than restart |
| [ADR-0012](../docs/adr/0012-executors-mirror-their-event-log-to-the-relay.md) | Executors mirror their event log to the relay; personal machines do not |

Not yet ADR-worthy but settled:

- **Identity.** Clerk provides **authentication only**: a sign-in and a verified subject id.
  Organizations, membership, roles, and invitations live in the relay's own database. Nothing
  about tenancy is delegated to Clerk, so authorization never depends on an external call — the
  relay resolves `subject → organization → role` with a local query, including on the
  environment leg where `RelayEnvironmentAuth` has no user token at all.
- **Naming.** `repository` (relay-owned, spans machines) → `project` (one checkout, own config,
  own threads) → `thread`. No existing concept is renamed; `project.created` and friends are
  persisted event types and stay as they are.
- **Precedence.** On executors, org config is *ownership*, not precedence — there is no human
  editing `settings.json` to lose a fight with. On personal machines org config is **opt-in per
  key**, because a plain file that `fs.watch` reloads within 100ms cannot be enforced against
  its owner. `t3.json` stays out of the config chain: it carries `iconPath` and `scripts`, and
  letting a cloned repo set `binaryPath` would be a supply-chain hole.
- **Client access to executors.** Reuse managed endpoints. Clients connect directly, exactly as
  they do to any environment today; the relay proxies no RPC traffic.

## Scope

**Foundation**

1. Organization model in the relay — members, org roles, repository roles, invitations
2. Repositories and canonical keys
3. Machine provisioning, enrollment, and lifecycle — agent executors and review hosts
4. Org config schema and delivery
5. Provider credential pool backed by Infisical
6. Persistent executor→relay channel

**Pipeline layer**

7. Work items and triggers
8. Workflows — base, org, repository override
9. Jobs and the job runner
10. Supervisor-model approvals
11. Review apps
12. Job events, subscriptions, and channel deliveries
13. Integrations — Linear triggers with write-back

**Out of scope**

- Self-hosted machines — both roles, not just agent execution (ADR-0010)
- Forking or resetting a work item's thread (ADR-0011)
- Thread portability (ADR-0004)
- Spend limits — usage is tracked, nothing is enforced
- A scheduler for review apps; dumb placement only (ADR-0010)

## Work

### Relay

**Platform.** Move off Cloudflare Workers to a VM. Bindings that must be replaced:
`Cloudflare.Queues` (+ DLQ) → a durable queue; `Workers.cron` → an in-process scheduler;
`Tunnel.ReadWriteTunnel` and `DNS.ReadWriteDns` → Cloudflare API calls with a credentialed
token; `Hyperdrive` → a direct `pg` pool; the Alchemy stack → a new deploy story. The Effect
`HttpApi` layer itself ports to `@effect/platform-node` unchanged.

**Schema.** New tables, following the existing one-repository-service-per-table pattern:
organizations, memberships, repositories, **repository aliases** (unique on canonical key),
repository access (with `maintainer` / `developer`), invitations, machines (with role: agent
executor or review host), provider credential references, org config, workflows, repository
workflow overrides, work items, triggers, integrations, jobs, job events, subscriptions. Owner columns are denormalized onto every
row the relay must resolve when only an environment credential is present.

**API.** New `HttpApiGroup`s in `packages/contracts/src/relay.ts`, implemented in
`infra/relay/src/http/Api.ts`, wired in `worker.ts`.

**Channel.** A persistent executor→relay WebSocket. The relay becomes stateful: connection
registry, reconnect/backoff, heartbeats. Cross-instance routing (Postgres `LISTEN/NOTIFY` or
Redis) is needed **before** the second relay instance, not after.

**Job state.** `queued → dispatched → running → awaiting_review → paused → done / failed`,
driven by the existing `RelayAgentAwarenessPhase` feed rather than a second reporting path.

**Workflow resolution.** Base → org workflow → repository override, each layer **patch-shaped**
(`optionalKey` throughout, presence means intent). `ServerSettings` is the cautionary example:
every field carries `withDecodingDefault`, so it cannot express "no opinion" and would override
everything. The resolved workflow is what gets dispatched, so the executor never resolves layers.

**Deviation view.** Because overrides are patches, an override **is** a diff. Surfacing "these
repositories deviate from your workflow, and how" is a query, not a permission system — the
compensating control for [ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md).

**Inbound webhooks.** The relay has no webhook endpoint today. Integration triggers need one,
with per-integration signature verification — the first inbound third-party surface it has had.

**Deliveries.** Job events route through subscriptions into the **existing** delivery pipeline
(queue, DLQ, retry, `relay_delivery_attempts`). Slack and Teams are new delivery *kinds*
alongside APNs device alerts, not a new subsystem. Chat integration tokens stay on the relay and
never reach a machine that runs agents.

**Usage tracking, no limits.** Executors forward `ThreadTokenUsageSnapshot` on the job-status
channel and the relay records it per job, repository, and organization. v1 enforces **nothing** —
no concurrency cap, no budget. This is [ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md)
applied to spend: measure and surface it rather than prevent it. Usage cannot be reconstructed
retroactively, so the reporting lands even though nothing consumes it yet.

### Environment / executor

- Enrollment client: present the seeded per-instance credential, exchange for a durable
  environment credential, destroy the seed.
- Org config resolution: render `settings.json` from org config on an executor; apply
  follow-per-key opt-in on a personal machine.
- **Project config is two new fields, not a new scope.** `ProjectMetaUpdateCommand` already
  carries `defaultModelSelection` and `scripts`; add `defaultThreadEnvMode` and
  `newWorktreesStartFromOrigin`. It is **not** an overlay on `ServerSettings`: nothing reads
  settings per project, and the consumers that matter cannot be made to — `BackgroundPolicy`
  publishes one snapshot per process, `observability` configures process-wide exporters, and
  `providerInstances` hydrate a registry of long-lived managed servers. The test for whether a key
  belongs here: does it influence *what gets created in* the project, or does it configure *the
  machine*?
- Infisical fetch at provider session spawn; inject into the child process environment and
  never persist (ADR-0003).
- **Job runner** — the largest new subsystem on the environment side. The relay triggers; the
  executor orchestrates. It accepts a dispatch (repository, base branch, instructions, resolved
  workflow), materializes the project, and then per step: creates a thread, sends the
  instruction, waits for settle, evaluates the gate, and reports the transition upward. Finally
  it runs the tail — push, open a pull request, provision a review app, emit job events.

  Steps have kinds — `agent`, `action`, `gate` ([ADR-0009](../docs/adr/0009-workflow-steps-have-kinds-and-agents-never-push.md)).
  Constraints on the runner:

  - **Agents never push.** Irreversible operations are `action` steps the runner performs, so a
    `git push` from an agent is always anomalous and always deniable. Push and pull-request
    credentials are runner-held and never materialized into an agent's environment.
  - **Gates are evaluated outside the thread being gated.** An agent assessing its own work is
    not a review. Whether an agent spawns subagents *within* a step is a provider capability and
    is not modelled.
  - **Settle detection reuses the existing signal.** The turn-settled transition that already
    feeds `RelayAgentAwarenessPhase` is what the runner waits on — no second mechanism.
- **Supervisor approvals.** Steps run in `approval-required` so approvals are genuinely
  requested; a supervisor model answers them with approve / deny / escalate
  ([ADR-0008](../docs/adr/0008-job-approvals-are-resolved-by-a-supervisor-model.md)). Requests are
  classified by `ProviderRuntimeToolKind` first — `file-read` auto-approves with no model call.
  Escalation pauses the job through the path that already exists: `waiting_for_approval` → the
  awareness feed → relay marks paused → delivery → human resolves via normal steering.
- **Review app driver.** `provision_review_app` with a driver interface; `compose` first. Runs on
  a review host, routed through a managed endpoint, with the application's own config resolved
  from a *separate* Infisical project ([ADR-0010](../docs/adr/0010-review-apps-run-on-org-compute.md)).
  Reaping on pull-request close plus a TTL backstop.

### Clients

- Org admin surfaces: members and invitations, repositories and access, credential pool,
  machines, workflows, and the deviation view.
- "Following org" indication per setting, with opt in and out.
- Job view: coarse state from the relay, thread detail from the executor. Steering a paused job
  — resolving an escalated approval — is a first-class action, not buried in thread UI.
- Cloud thread viewing and steering — **already works** via the existing connect flow plus
  `orchestration.subscribeThread` and `dispatchCommand`.

## Phases

Ordering, milestones, and what each step proves live in
[22-org-control-plane-roadmap.md](./22-org-control-plane-roadmap.md), with ADR references per
milestone. Kept there rather than here so the two do not drift.

## Open Questions

Tracked per milestone in the [roadmap](./22-org-control-plane-roadmap.md#open-questions-carried-into-the-roadmap).
