---
status: accepted
---

# Workflow steps have kinds, and agents never perform irreversible operations

A workflow step is one of three kinds — `agent`, `action`, or `gate` — rather than every step
being "run an agent." Deterministic operations that leave the workspace are `action` steps
executed by the job runner, which means **agents never push, never open pull requests, and never
merge**.

| kind     | what it is                                                                                   |
| -------- | -------------------------------------------------------------------------------------------- |
| `agent`  | start or continue the job thread, send step instructions, wait for its turn to settle        |
| `action` | a defined deterministic operation: push, open a pull request, provision a review app, notify |
| `gate`   | wait for a condition: human sign-off, a check, a review verdict                              |

## Why not let agents do the tail

An agent can run `git` and `gh`, so "push the branch and open a PR" is expressible as an agent
step. It is also non-deterministic: the agent may not push, may push twice, may write a poor
description, or may decide to do something adjacent.

More importantly it closes the risk left open by
[ADR-0008](./0008-job-approvals-are-resolved-by-a-supervisor-model.md). Supervisor approval
escalates on uncertainty, which gives no protection when the supervisor is _confident and wrong_
about an irreversible action. Removing those actions from agents entirely converts a judgement
problem into a structural one:

> **Agents never push. The runner pushes.**

A `git push` originating from an agent is therefore always anomalous and always deniable — no
legitimate workflow asks an agent for one, so the supervisor needs no judgement about it.

## Why `gate` is a kind and not a flag

A repository owns its workflow definition ([ADR-0007](./0007-the-org-layer-is-defaults-not-enforcement.md)),
including its gates. When a gate is a step, removing it is a visible structural change —
_"this workflow has no human review"_ — rather than a boolean flipped somewhere inside a nested
config object. Since visibility is the only control we have, gates must be shaped so that their
absence is obvious.

## Thread and workspace lifetime

Ordered repository workflows share one thread and prepared worktree for the job. Each Agent
step has a distinct, durable turn identity; human checkpoints bind to that step's saved result.
Rework adds another turn in the same thread and invalidates the selected suffix, keeping prior
responses as history. The current prompt names the inputs and results that still apply. Sharing
the thread keeps setup ownership and cancellation on the existing thread lifecycle rather than
introducing a second set of process owners. Every Agent therefore uses the same provider driver
and compatible continuation identity; per-step model changes follow that provider's conversation
rules. The accepted job pins the identity through native prompt admission, and stopped sessions
resume their saved conversation across compatible instances. Provider reconfiguration must not
silently start new history. Cancellation remains tied to the original runtime's shutdown proof;
removing its configuration does not prove that its process stopped. Strict workflow continuation
ends when the durable job releases ownership, preserving ordinary chat behavior in the retained
thread. Incompatible changes require cancellation and a new job.

## Consequences

- The runner needs credentials to push and to open pull requests. Those are runner-held, not
  agent-visible, and should not be materialized into any agent's process environment.
- `action` types are a closed, versioned set. Adding one is a product decision, not
  configuration — a workflow cannot define an arbitrary new side effect.
- Agent steps that legitimately need to commit locally still may; the restriction is on
  operations that escape the checkpointed workspace.
