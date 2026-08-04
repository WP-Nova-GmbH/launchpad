# Org Control Plane — Implementation Roadmap

Ordering and milestones for [21-org-control-plane-foundation.md](./21-org-control-plane-foundation.md).
That document says *what* and *why*; this one says *in what order* and *what each step proves*.
Decisions are in [docs/adr/](../docs/adr/) and vocabulary in
[docs/internals/glossary.md](../docs/internals/glossary.md). Instructions for an agent picking this
up are in [23-org-control-plane-agent-brief.md](./23-org-control-plane-agent-brief.md).

## Principles behind the ordering

**Prove the novel parts before building the known parts.** The risk here is not organization CRUD
— that is understood work. It is whether the relay-owns-jobs / executor-owns-threads seam
([ADR-0005](../docs/adr/0005-relay-owns-jobs-environments-own-threads.md)) survives contact, whether
a job runner can drive a thread to settle unattended, and whether supervised approvals
([ADR-0008](../docs/adr/0008-job-approvals-are-resolved-by-a-supervisor-model.md)) produce sane
verdicts. All of that is upstream of a great deal of work and none of it is proven.

**The platform move happens when it is forced, not first.** An earlier draft put it first. What
actually requires leaving Cloudflare Workers is **holding persistent connections** for job
dispatch. Organization management is CRUD, and the event mirror is batched append-only upload that
can be an HTTP endpoint authenticated exactly like `publishAgentActivity` is today. Effect
`HttpApi` handlers port mechanically; the expensive ports — queues, cron, tunnel and DNS bindings —
already exist and must be done regardless. So the move lands at **M4**, where the channel needs it.

**Cross-cutting constraint, every milestone.**
[ADR-0004](../docs/adr/0004-thread-portability-is-deferred-not-designed-away.md)'s invariants hold
throughout: thread events stay self-contained and replayable, checkpoints stay plain git refs,
identity stays machine-independent. Thread portability is deferred, not designed away, and any
change that would foreclose it needs that ADR revisited first.

---

## M0 — Walking skeleton

**Goal: trigger a job by hand and watch it open a real pull request.**

| build | deliberately skip |
|---|---|
| one organization record, one admin | invitations, email, roles UI |
| repository registration from a checkout via canonical key | aliases, access grants |
| **manually** registered executor | provisioning, seeded enrollment |
| provider credential as a plain environment variable | Infisical, credential pool |
| **one hard-coded workflow**: implement → review → push → open PR | layering, overrides, deviation view |
| job runner with `agent` / `action` / `gate` steps | review apps, deliveries |
| supervisor approvals with escalation | integrations, work-item lifecycle |
| human trigger, work item as a stub | Linear, follow-ups |

**Governed by** [ADR-0005](../docs/adr/0005-relay-owns-jobs-environments-own-threads.md) ·
[ADR-0008](../docs/adr/0008-job-approvals-are-resolved-by-a-supervisor-model.md) ·
[ADR-0009](../docs/adr/0009-workflow-steps-have-kinds-and-agents-never-push.md)

**Proves:** that the seam holds; that a runner can drive a thread to settle using the same
turn-settled signal that feeds `RelayAgentAwarenessPhase`; that `agents never push` is workable in
practice; that a supervisor's approve/deny/escalate verdicts are usable rather than noise.

**Throwaway:** the hard-coded workflow. The job runner survives; the workflow it runs does not.

---

## M1 — Organizations, repositories, access

Organizations, memberships, org roles (`member` / `admin`), repository roles (`maintainer` /
`developer`), invitations. Repositories with alias sets and canonical-key matching; repository
access. Admin surfaces.

**Governed by** [ADR-0006](../docs/adr/0006-repositories-own-a-set-of-canonical-keys.md) ·
[ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md)

**Notes.** Clerk provides **authentication only** — a sign-in and a verified subject id. Membership,
roles, and invitations are relay-owned, so authorization is a local query on every path including
the environment leg, where there is no user token at all. This milestone includes the
member-management and invitation work a hosted identity product would otherwise have supplied, plus
a **transactional email dependency** that does not exist yet.

Executors refuse checkouts whose canonical key is not registered; personal machines derive freely
and offer registration (ADR-0006).

---

## M2 — Machines

Provisioning, per-instance seeded enrollment, single-tenant binding, machine **roles** (agent
executor / review host), managed endpoint allocation, per-organization quota.

**Governed by** [ADR-0001](../docs/adr/0001-executors-are-long-lived-environments.md) ·
[ADR-0002](../docs/adr/0002-executor-enrollment-and-tenancy.md) ·
[ADR-0010](../docs/adr/0010-review-apps-run-on-org-compute.md)

**Notes.** Enrollment is a **second, parallel** trust path beside the existing human-driven link
flow, not a replacement — a provisioned machine has no signed-in human to vouch for it. Managed
endpoints reuse `ManagedEndpointProvider` unchanged: `cloudflared` dials outbound, so no inbound
port is opened and internal-network isolation holds. `ManagedTunnelLimits` becomes the per-org
quota and the billing lever for "buy managed machines."

**Open:** whether review hosts share the executor quota or have their own.

---

## M3 — Config and credentials

Org config schema and delivery; Infisical integration; the provider credential pool;
follow-per-key on personal machines. Project config lands here as two extra fields on
`ProjectMetaUpdateCommand` (`defaultThreadEnvMode`, `newWorktreesStartFromOrigin`) — not a scope,
so it rides along rather than driving work.

**Governed by** [ADR-0003](../docs/adr/0003-provider-credentials-are-fetched-by-executors-not-pushed.md) ·
[ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md)

**Notes.** The relay stores **references**, never secrets; executors resolve them from Infisical at
provider session spawn and never persist the value. Config carries zero secrets, which keeps the
channel's security requirements low. On executors org config is *ownership* — there is no competing
editor. On personal machines it is opt-in per key, because a file `fs.watch` reloads within 100ms
cannot be enforced against its owner.

---

## M4 — Platform move, channel, job state, event mirror

Move the relay off Cloudflare Workers to a VM. Persistent executor→relay WebSocket, cross-instance
routing, coarse job state fed by the awareness stream, usage tracking with **no enforcement**, and
the executor event mirror.

**Governed by** [ADR-0005](../docs/adr/0005-relay-owns-jobs-environments-own-threads.md) ·
[ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md) ·
[ADR-0012](../docs/adr/0012-executors-mirror-their-event-log-to-the-relay.md)

Scope here is the **organization mirror** only. Personal thread sync is M8 — same transport,
different store and different rules.

**Notes.** This is the only milestone that changes infrastructure, and it changes it because the
persistent channel forces it. Replace: `Cloudflare.Queues` + DLQ, `Workers.cron`,
`Tunnel.ReadWriteTunnel` and `DNS.ReadWriteDns` bindings (→ credentialed API calls), `Hyperdrive`
(→ direct `pg` pool), and the Alchemy deploy story.

Cross-instance routing (Postgres `LISTEN/NOTIFY` or Redis) is needed **before** the second relay
instance, not after. The mirror is batched with sequence-number resume — it is the largest new data
flow in the design — and is a **read replica**: written only by the mirror stream, never dispatched
against.

**Open:** dispatch latency budget, which drives how aggressively the channel reconnects.

---

## M5 — Work items, workflows, the real job runner

Work items with external reference **plus instruction snapshot**. Base workflow, org workflows,
repository overrides, and the deviation view. Job runner generalized from M0. Continuation on
follow-up with the degraded fallback when the pinned executor is gone.

**Governed by** [ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md) ·
[ADR-0009](../docs/adr/0009-workflow-steps-have-kinds-and-agents-never-push.md) ·
[ADR-0011](../docs/adr/0011-work-items-are-durable-and-follow-ups-continue.md)

**Notes.** Every layer is **patch-shaped** (`optionalKey` throughout, presence means intent).
`ServerSettings` is the cautionary example: every field carries `withDecodingDefault`, so it cannot
express "no opinion" and would override everything. Because overrides are patches, an override *is*
a diff — the deviation view is a query, not a permission system, which is the compensating control
for a model where a repository may override anything including gates.

**Open:** which `action` types ship beyond push, open pull request, provision review app, notify.

---

## M6 — Review apps and deliveries

`provision_review_app` with a driver interface, `compose` first. Review-host placement, routing
through managed endpoints, reaping on pull-request close plus a TTL backstop. Job events,
subscriptions, and Slack/Teams as new delivery **kinds** on the existing APNs pipeline.

**Governed by** [ADR-0010](../docs/adr/0010-review-apps-run-on-org-compute.md)

**Notes.** The application's own config resolves from an Infisical project **separate** from the
provider credential pool — `DATABASE_URL` is not a provider credential and must not share a
namespace with one. Seeded test-account credentials are surfaced only when the target is declared
disposable. Chat integration tokens stay on the relay and never reach a machine running agents.

---

## M7 — Integrations

Linear: inbound webhooks with signature verification (the relay's first inbound third-party
surface), watched-state triggers, and write-back — moving columns, posting pull-request links.

**Governed by** [ADR-0011](../docs/adr/0011-work-items-are-durable-and-follow-ups-continue.md)

**Deliberately last.** The human trigger from M5 exercises the entire pipeline, so integrations add
trigger sources rather than unblocking anything. Building webhook verification while the job runner
is still unproven would mean debugging two unknowns at once.

---

## M8 — Personal thread sync

Threads on machines people own mirror to a **user-scoped** store so their history is readable when
that machine is off. Opt-in per project, readable by the subject alone, with no administrator path.
Requires an **offboarding flow** — export or delete on leaving an organization — that does not
exist today.

**Governed by** [ADR-0013](../docs/adr/0013-personal-threads-mirror-to-a-user-scoped-store.md) ·
[ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md)

**Orthogonal to M5–M7.** It needs M4's transport and nothing from the pipeline, so it can be
sequenced independently once the organization mirror is proven. Shipping it second is deliberate:
the transport gets exercised on organization data, where a mistake is a bug, before it carries
personal data, where a mistake is a disclosure.

**Notes.** The two mirrors must not share a table or an access path — a single store with a
visibility column is one wrong query away from disclosure. Retention is decided separately and does
not inherit the organization mirror's indefinite default. The guarantee depends on the relay staying
vendor-operated; a self-hosted relay would need this disabled, disclosed, or end-to-end encrypted.

**Open:** personal-mirror retention; what "export" produces on offboarding.

---

## Dependencies

```
M0 (skeleton) ─── proves the design; nothing depends on it structurally
M1 (orgs, repos) ──┬── M2 (machines) ──┬── M3 (config, credentials)
                   │                   └── M4 (platform, channel, mirror) ── M5 (workflows)
                   └────────────────────────────────────────────────────────── M5
                                                                    M5 ──┬── M6 (review apps, deliveries)
                                                                         └── M7 (integrations)
M4 ── M8 (personal thread sync)   ← orthogonal to M5–M7
```

M0 stands alone by design: it is a probe, not a foundation. If it invalidates a decision, the ADR
changes before M1 starts.

## Open questions carried into the roadmap

| question | blocks |
|---|---|
| Personal-mirror retention — does not inherit the organization mirror's indefinite default | M8 |
| What "export my threads" produces on offboarding | M8 |
| Cross-org linking: can a member of one organization link to another's executor? | M2 |
| Review host quota: shared with executors or separate? | M2 |
| Dispatch latency budget | M4 |
| Transactional email provider | M1 |
| v1 `action` type list | M5 |
| Executor reclamation policy — history survives (ADR-0012) but continuation breaks | M2 |
