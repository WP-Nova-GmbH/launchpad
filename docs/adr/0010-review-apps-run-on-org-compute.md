---
status: accepted
---

# Review apps run on the organization's own compute

A finished [job](../internals/glossary.md#job) deploys the branch so a human can click through
it before approving. That deployment — a **review app** — runs on the organization's own
machines: additional provisioned hosts for managed organizations, and their own hardware once
self-hosting exists. We do not delegate to the organization's existing preview infrastructure,
and we do not build a scheduler.

## Naming

"Environment" already means three things (ours, Infisical's, and a deployment target), so a
running instance of the customer's application is a **review app**, never a "review
environment".

## Shape

- **A `provision_review_app` action step** ([ADR-0009](./0009-workflow-steps-have-kinds-and-agents-never-push.md))
  with a **driver interface**. `compose` ships first; other manifest formats slot in behind the
  same action without changing the workflow schema.
- **Roles, not machine kinds.** A provisioned machine is an _agent executor_ or a _review host_.
  Enrollment, tunnels, single-tenancy, and quota all inherit unchanged from
  [ADR-0002](./0002-executor-enrollment-and-tenancy.md). Adding a role costs a column; adding a
  machine kind would cost a subsystem.
- **Review hosts are separate machines from agent executors.** Executors are long-lived and hold
  thread history ([ADR-0001](./0001-executors-are-long-lived-environments.md)); an arbitrary
  customer container that exhausts memory must not be able to take that with it.
- **Routing reuses managed endpoints.** A per-review-app hostname is the existing
  `ManagedEndpointProvider` call with a different origin — no new reverse proxy, no new TLS story.
- **The application's own config comes from Infisical**, in an _Infisical project separate from
  the provider credential pool_. Same resolution mechanism as
  [ADR-0003](./0003-provider-credentials-are-fetched-by-executors-not-pushed.md), different
  domain: `DATABASE_URL` and third-party keys are not provider credentials and must not share a
  namespace with them.
- **Scheduling stays dumb.** Least-loaded host, or a single designated review host per
  organization. An organization that already runs Kubernetes or Nomad can be pointed at it later;
  v1 does not contain a scheduler.

## Seeded test accounts

"Log in as this user" is repository knowledge, not platform knowledge. The repository declares
both the seed command and which credentials to surface; the platform never invents an account.
Because those credentials are then posted into a chat channel, the driver surfaces them only when
the target is declared **disposable** — the failure mode to prevent is someone pointing the
driver at shared staging and having its credentials broadcast to a team channel.

## Consequences

- Review apps must be reaped when their pull request merges or closes, with a TTL backstop.
  Without it, "available hardware" stops being available and it presents as a capacity problem
  rather than a cleanup bug.
- Self-hosted support now spans both roles, so it is coupled to review apps rather than being
  purely an agent-execution concern.
- We take on the customer's deployment topology for the compose case. Applications that do not
  run from a manifest in their own repository are out of scope until a driver exists for them.
