---
status: accepted
---

# Workflow steps have kinds, and agents never perform irreversible operations

Workflows have Agent steps, closed Action operations, and explicit human Review/Input checkpoints rather than making every step "run an agent." Deterministic operations that leave the workspace are `action` steps
executed by the job runner, which means **agents never push, never open pull requests, and never
merge**.

| kind               | what it is                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `agent`            | start or continue the job thread, send step instructions, wait for its turn to settle        |
| `action`           | a defined deterministic operation: push, open a pull request, provision a review app, notify |
| `review` / `input` | wait for a human response, with a result-bound Review or contextual Input                    |

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

## Why human checkpoints are steps

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

## Publishing binds to the prepared result

Push commits and publishes the saved result; Open PR cannot implicitly push. The accepted job fixes the repository, remote, base and job branch. A runner-created commit may change HEAD only when its tree still matches the saved checkpoint, so commit hooks cannot upload unreviewed changes. Review and completion verify that authorized HEAD rather than the pre-commit Agent HEAD.

Publishing receipts survive suffix invalidation during rework. The sequence can run again without forgetting a remote effect: retries observe the intended commit/ref, and all generations bind to one PR. A first PR's stable job marker permits recovery after a lost reply; once recorded, its exact identity remains authoritative even if someone edits the body. Missing, ambiguous or incomplete evidence blocks another creation. Closed/merged PRs require attention rather than replacement.

Local command stopping and remote outcome are separate facts. Workflow Git/forge mutations use the native owner boundary with capture before arm, durable command results and full-stop proof. A stopped command may still have published remotely. Lost ownership retains capacity until stopping is proven; a new boot on the same recorded host can prove it, while an app restart or database move cannot. Revisit that proof when VM execution is added. These constraints span native execution, the runner and relay; ordinary chat Git commands keep their existing lifecycle.

## Consequences

- The runner needs credentials to push and to open pull requests. Those are runner-held, not
  agent-visible, and should not be materialized into any agent's process environment.
- `action` types are a closed, versioned set. Adding one is a product decision, not
  configuration — a workflow cannot define an arbitrary new side effect.
- Agent steps that legitimately need to commit locally still may; the restriction is on
  operations that escape the checkpointed workspace.
