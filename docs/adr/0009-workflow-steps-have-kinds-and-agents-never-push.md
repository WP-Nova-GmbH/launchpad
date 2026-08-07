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
| `agent`  | create a thread, send instructions, wait for it to settle                                    |
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

A repository may override any part of its workflow ([ADR-0007](./0007-the-org-layer-is-defaults-not-enforcement.md)),
including removing gates. When a gate is a step, removing it is a visible structural deviation —
_"this repository dropped your review gate"_ — rather than a boolean flipped somewhere inside a
nested config object. Since visibility is the only control we have, gates must be shaped so that
their absence is obvious.

## Consequences

- The runner needs credentials to push and to open pull requests. Those are runner-held, not
  agent-visible, and should not be materialized into any agent's process environment.
- `action` types are a closed, versioned set. Adding one is a product decision, not
  configuration — a workflow cannot define an arbitrary new side effect.
- Agent steps that legitimately need to commit locally still may; the restriction is on
  operations that escape the checkpointed workspace.
