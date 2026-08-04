---
status: accepted
---

# The org layer supplies defaults and authorship, not enforcement

Across config, workflows, and repository settings, the organization layer is **authoritative
about what the default is** and **not** a mechanism for preventing change. Where something can
be edited by the person it applies to, it is not enforced against them. Control comes from
who is allowed to change a thing, not from marking parts of it immutable.

## Where this shows up

- **Personal machines.** Org config is opt-in per key. `settings.json` is a plain file on a
  machine its owner controls, reloaded by `fs.watch` within 100ms of any edit — anything pushed
  can be edited back, immediately and by design.
- **Executors.** Org config is authoritative, but as *sole authorship* rather than enforcement:
  there is no competing editor on the machine, so nothing has to be locked.
- **Workflows.** A repository may override any part of the org workflow, gates included.
- **Provider credentials.** The exception that proves the rule — those are genuinely enforced,
  and only because enforcement lives outside this system entirely, in Infisical
  ([ADR-0003](./0003-provider-credentials-are-fetched-by-executors-not-pushed.md)).

## Why

Enforcement requires a substrate the organization controls. We have exactly one: the executors
we provision, plus the credentials we never hand over. Everywhere else — a developer's laptop, a
branch in a repository — the person being governed can edit the thing governing them. Building
locks there produces the appearance of policy without policy, which is worse than no policy: it
misleads administrators into believing something is guaranteed when it is not.

## Compensating control: visibility

Every override layer is patch-shaped (`optionalKey` throughout, presence means intent), so an
override **is** a diff against the layer above it. Deviation is therefore queryable without any
extra modelling: administrators get *"these repositories deviate from your workflow, and here is
how"* from a read, not from a permission system.

## Consequences

- Do not build per-field lock flags, immutability markers, or tamper detection. If a proposal
  needs one, the real question is whether the thing belongs on a substrate we control.
- Access control is about **who can edit** — org admin versus member — and that is where
  authorization effort belongs.
- This is not a compliance product. If a customer requires enforced policy, the honest answer is
  that it holds on executors and on credentials, and nowhere else.
