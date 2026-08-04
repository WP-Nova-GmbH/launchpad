# Org Control Plane — Agent Implementation Brief

Instructions for an agent implementing the org control plane. Work **one milestone at a time**,
open a pull request per coherent unit, and run the review protocol at the end of this document
before opening any of them.

## Read first

| document | what it gives you |
|---|---|
| [AGENTS.md](../AGENTS.md) | how to work in this repo at all — verification, PR rules, the three ways to hurt yourself. **Not restated here.** |
| [docs/internals/glossary.md](../docs/internals/glossary.md) | vocabulary. Several words are deliberately disowned; check before naming anything. |
| [docs/adr/](../docs/adr/) 0001–0013 | the decisions. Binding — see below. |
| [21-org-control-plane-foundation.md](./21-org-control-plane-foundation.md) | what is being built and why |
| [22-org-control-plane-roadmap.md](./22-org-control-plane-roadmap.md) | milestone order, what each proves |

Read the ADRs before writing code, not after a review flags one. They are short.

## The ADRs are binding

If your implementation contradicts an ADR, **stop**. Do not work around it, and do not silently
choose the other option. Either you have found a case the ADR did not consider — in which case say
so and propose an amendment — or the implementation is wrong. Both outcomes need a human. An ADR
quietly violated in code is worse than one that was never written.

Amending an ADR is normal and several already carry amendments. Violating one without saying so
is not.

## Invariants

These are the mistakes a competent implementation makes by default. Each one has already cost a
design discussion; none is obvious from the code.

**Orchestration and threads**

1. **Never wait on receipts in production.** `RuntimeReceiptBus` is publish-only in production —
   its own header says *"Production code should only call `publish`"*. The authoritative
   turn-settled signal is **the session leaving `running` status**
   (`settledTurnStateForSessionStatus` in `projector.ts`), which is what already drives
   `RelayAgentAwarenessPhase`. Use receipts in **tests**, for determinism. That is what they exist
   for.
2. **Never rename `project.*` or `thread.*` event types.** They are persisted strings in every
   environment's event log. A rename is a migration of history, not a refactor.
3. **A thread has one authoritative environment.** Mirrors are read replicas
   ([ADR-0012](../docs/adr/0012-executors-mirror-their-event-log-to-the-relay.md),
   [ADR-0013](../docs/adr/0013-personal-threads-mirror-to-a-user-scoped-store.md)). Nothing
   dispatches commands against a mirror.
4. **Preserve [ADR-0004](../docs/adr/0004-thread-portability-is-deferred-not-designed-away.md)'s
   invariants** even though portability is deferred: events stay self-contained and replayable,
   checkpoints stay plain git refs, identity stays machine-independent, and `workspaceRoot` stays
   the only machine-specific field on a project.

**Config and layering**

5. **Layered config must be patch-shaped** — `optionalKey` throughout, presence means intent.
   `ServerSettings` is the counter-example: every field carries `withDecodingDefault`, so it
   cannot express "no opinion," and `stripDefaultServerSettings` destroys the distinction on write.
   Copying its shape into an override layer silently overrides everything.
6. **On executors, org config is rendered, not merged.** There is no competing editor, so there is
   no precedence engine to build. Precedence only exists on personal machines, and there it is
   **opt-in per key** and the user always wins
   ([ADR-0007](../docs/adr/0007-the-org-layer-is-defaults-not-enforcement.md)).
7. **`t3.json` stays out of the config chain.** It carries `iconPath` and `scripts`. A cloned
   repository must never be able to set `binaryPath`.
8. **Project config is fields on the project aggregate, not a settings overlay.** `ServerSettings`
   has no project dimension and its consumers cannot acquire one — `BackgroundPolicy` publishes one
   snapshot per process, `observability` configures process-wide exporters, `providerInstances`
   hydrate a registry of long-lived managed servers.

**Secrets and identity**

9. **No secret ever lands in relay Postgres.** References only; executors resolve them from
   Infisical at provider session spawn and never persist the value
   ([ADR-0003](../docs/adr/0003-provider-credentials-are-fetched-by-executors-not-pushed.md)).
10. **Clerk is authentication only.** Organizations, membership, roles, and invitations are
    relay-owned. Never read tenancy from a Clerk claim, and never bake `org_id` into a DPoP token —
    resolve `subject → organization → role` locally, so a 30-minute token never carries 30-minute
    stale authorization.
11. **The two mirrors never share a table or an access path.** One store with a visibility column
    is one wrong `WHERE` clause from disclosure. Separate stores make the mistake impossible.
12. **Integration and chat credentials stay on the relay.** They never reach a machine where agents
    run shell commands.

**Jobs and workflows**

13. **Agents never push, open pull requests, or merge.** Those are `action` steps performed by the
    job runner with runner-held credentials that are never materialized into an agent's process
    environment ([ADR-0009](../docs/adr/0009-workflow-steps-have-kinds-and-agents-never-push.md)).
14. **Set runtime mode explicitly on every step.** `DEFAULT_RUNTIME_MODE` is **`full-access`**.
    Inheriting it gives an unattended agent unrestricted shell on a machine holding org credentials.
15. **Gates are evaluated outside the thread being gated.** An agent assessing its own work is not
    a review.
16. **The relay owns coarse job state; the environment owns everything inside a thread**
    ([ADR-0005](../docs/adr/0005-relay-owns-jobs-environments-own-threads.md)). If the relay starts
    needing turn-level detail, the seam is being violated — stop.

## Working agreement

- **One milestone at a time**, in roadmap order. M0 first.
- **A pull request per coherent unit**, not per milestone. M0 alone is at least four.
- **No speculative generality.** Build what the milestone needs. The roadmap says what each one
  deliberately skips — skip it.
- **Reuse before building.** This codebase already contains a delivery pipeline with retry and DLQ,
  managed endpoint provisioning over Cloudflare Tunnel, an awareness feed with exactly the phases a
  job runner needs, and repository canonical-key normalization. Check before writing a new one.

### Stop and ask when

- an ADR appears wrong or incomplete
- a decision is needed that no ADR covers and the roadmap lists as open
- an invariant above cannot be satisfied
- the work would touch `~/.t3/userdata` or any live install (see AGENTS.md)
- a milestone turns out to depend on one not yet built

## Milestones

Detail and rationale are in the [roadmap](./22-org-control-plane-roadmap.md). Summary of what
"done" means:

**M0 — walking skeleton.** A human-triggered job produces a real pull request. Build the settle
loop first, with **no relay involvement at all**: a service that takes a project and an
instruction, creates a thread, and waits for it to settle. Then step sequencing and `action` steps.
Then supervisor approvals. Only then the minimal relay dispatch. The hard-coded workflow is
throwaway; the runner is not.

**M1 — organizations, repositories, access.** A person signs in, lands in an organization, invites
someone, registers a repository from a checkout, and grants access.

**M2 — machines.** An admin provisions a machine, it enrolls itself, receives a managed endpoint,
and appears as an executor bound to one organization.

**M3 — config and credentials.** Org config reaches an executor; a provider session starts with a
credential the executor fetched from Infisical and never wrote to disk.

**M4 — platform move, channel, mirror.** The relay runs on a VM, holds executor connections,
dispatches a job over one, and receives a mirrored event log.

**M5 — work items, workflows, real job runner.** A work item carries a reference and an instruction
snapshot; a layered workflow resolves and dispatches; a follow-up continues the existing thread.

**M6 — review apps and deliveries.** A finished job deploys a review app and posts its URL to a
channel.

**M7 — integrations.** An issue entering a watched Linear state starts a job, and the result is
written back.

**M8 — personal thread sync.** A user's opted-in threads are readable from another device while the
owning machine is off, and no administrator can read them.

## Review protocol

Run this **before opening each pull request**, on your own work. Report the results in the PR body.

**1. Decision conformance.** For every ADR touching this change, state which one and how the change
conforms. If any conflicts, stop and escalate rather than opening the PR.

**2. Invariant sweep.** Walk the invariant list above. Report only those the change could plausibly
have violated, and say why it does not. "N/A" for the rest is fine — silence is not.

**3. Surface coverage.** Per AGENTS.md, walk entry points, clients, providers, contracts, reverse
states, and connection modes, and say which applied. A reverse state that was added without its
inverse is a bug, not an omission.

**4. Reuse check.** Name what you reused. If you wrote something new that resembles an existing
subsystem — delivery, provisioning, awareness, canonical keys — justify it explicitly.

**5. Tests.** Focused tests for the behaviour changed. No sleeps and no polling; wait on receipts
or worker drains. A test needing a timeout to pass is wrong. Do not run repo-wide checks.

**6. What you did not do.** State explicitly what you skipped, stubbed, or deferred, and why. A
milestone completed with an undisclosed gap is worse than one honestly reported as partial.

**7. Independent pass.** After self-review, `/code-review` gives an adversarial read of the working
diff. Use it for anything touching auth, secrets, the job seam, or either mirror.

## Reporting

Each pull request body: the problem in a sentence or two, then how it was fixed, then the review
protocol results. Conventional commit title. End with the model and harness that did the work, per
AGENTS.md.

Do not open a pull request unless a human explicitly asks for one.
