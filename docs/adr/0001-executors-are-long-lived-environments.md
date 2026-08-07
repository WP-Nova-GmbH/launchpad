---
status: accepted
---

# Executors are long-lived environments, not ephemeral workers

The relay is growing into an org control plane that provisions the compute agents run
on. We considered making those machines ephemeral — created per run and destroyed
afterwards — which is the natural shape for a pipeline product. We rejected it: an
executor is a **long-lived** environment that the relay provisions once and that
persists across runs.

## Considered options

- **Long-lived (chosen).** The relay provisions a machine once; it persists and behaves
  like any other environment. Machine-local state stays machine-local.
- **Ephemeral compute, persistent volume.** The machine is recreated per run and
  reattaches a surviving disk.
- **Ephemeral and stateless.** All durable state moves to the relay; executors become
  disposable workers.

## Why

A T3 environment is durably stateful and every piece of that state is machine-local:

- `<stateDir>/state.sqlite` is the orchestration **event store plus its projections** —
  it _is_ the thread history, not a cache of it.
- Checkpoints are **git refs inside the workspace** (`refs/t3/checkpoints/<threadId>/turn/<n>`),
  so turn diffs and revert depend on that machine's git object store.
- Provider homes (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, shadow homes) hold live provider auth.

Making executors stateless is therefore not a persistence swap. `OrchestrationEngine`
serializes every command through a single fiber and commits event append, projection, and
the command receipt inside one SQL transaction — a design that assumes a local
single-writer SQLite. Relocating it to the relay turns orchestration into a distributed
consensus problem, and checkpoints would _still_ be lost unless every turn also pushed
`refs/t3/checkpoints/*` to a remote.

The persistent-volume variant looked like a compromise but has the worse failure mode: a
volume is a single-writer resource and there is no lease protocol here, so two executors
racing for one disk corrupts SQLite and leaves a half-written worktree.

## Consequences

- Executor cost is per-machine-lifetime, not per-run. Idle executors cost money, and reclamation
  needs an explicit policy rather than a timeout. Since
  [ADR-0012](./0012-executors-mirror-their-event-log-to-the-relay.md) the _record_ survives
  reclamation — what is still lost is the live worktree, checkpoint history, and the ability to
  continue a pinned work item in place.
- "The relay provisions compute" stays a _provisioning_ problem and does not become a
  _state-architecture_ problem.
- If a later pipeline feature needs durability that outlives a machine, that state belongs
  in a pipeline model owned by the relay, **above** threads — not by relocating the
  environment's event store.
- Moving to ephemeral executors later is a deliberate, earned migration, not a
  configuration change.
