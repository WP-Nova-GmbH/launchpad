# Machines

> For maintainers. Using T3 Code? See [docs/user](../user/).

A machine is compute the relay provisions for exactly one organization: an **agent
executor** that runs work, or a **review host** that will run review apps — one
provisioning path and one enrollment story, with the difference costing a role column
([ADR-0010](../adr/0010-review-apps-run-on-org-compute.md)). Machines are long-lived
environments, not ephemeral workers ([ADR-0001](../adr/0001-executors-are-long-lived-environments.md)),
and single-tenant to the organization that bought them
([ADR-0002](../adr/0002-executor-enrollment-and-tenancy.md)). Vocabulary is in the
[glossary](./glossary.md#org-control-plane).

## Lifecycle

An admin provisions a machine from Settings → Organization. The relay checks the
organization's quota, creates the record with a single-use enrollment seed (stored only
as a hash, expiring after 24 hours), and hands the seed to the compute driver — the
record exists before the compute so enrollment can never race an unknown seed, and a
driver failure removes the never-enrolled record.

The machine boots, and its server presents the seed inside a proof signed with its own
freshly generated environment key (`reconcileMachineEnrollment` in
`apps/server/src/cloud/machineEnrollment.ts`, against `MachineEnroller` in
`infra/relay/src/machines/MachineEnroller.ts`). The relay verifies the proof exactly as
it verifies link proofs — stage for stage, replay-guarded — claims the seed atomically,
provisions a managed endpoint, and answers with the durable environment credential. From
then on the machine is an ordinary environment whose credential is anchored by its
machine row instead of a link row.

Status is derived, never stored: tombstoned means deprovisioned, enrolled means ready,
neither means the machine has not called home yet. A machine still waiting when its seed
expires can only be deprovisioned and recreated.

Deprovisioning is **admin-triggered only** in M2 — automatic idle reclamation waits for
the event mirror ([ADR-0012](../adr/0012-executors-mirror-their-event-log-to-the-relay.md)),
because until events are mirrored, destroying the machine destroys the thread history it
holds. Teardown is ordered so a failure part-way stays retryable: tombstone first (the
credential dies with it), then credential revocation, managed endpoint, and compute.

## The two trust paths never mix

Enrollment exists because the link flow is rooted in a signed-in human who owns the
machine, and a provisioned VM has neither. The two stay disjoint in both directions: the
linker refuses an environment that is an enrolled machine (`environment_is_machine`), and
enrollment refuses an environment anyone has linked (`environment_already_linked`). The
server enforces the same boundary from its side — a machine identity in the secret store
makes the link-proof, relay-config, and unlink surfaces refuse.

## Who reaches a machine

Every member of the owning organization, resolved locally on every call — never from a
token claim. `EnvironmentConnector.resolveAccess`
(`infra/relay/src/environments/EnvironmentConnector.ts`) tries the caller's own link
first and falls back to an enrolled machine of their organization; a machine outside
their organization answers exactly like a missing link, so a non-member cannot enumerate
another organization's fleet. Ready machines appear in the client environment list beside
personal links, which is how the existing web, desktop, and mobile clients reach them
without machine-specific code.

On the machine itself, the relay's signed proofs (mint, health, job dispatch) are no
longer pinned to a single linked account — the relay resolves the caller's membership
before signing, so the signature carries the authorization.

## Compute drivers

`MachineComputeProvider` (`infra/relay/src/machines/MachineComputeProvider.ts`) is the
seam between machine records and infrastructure:

- **Hetzner Cloud** (production, `HetznerComputeProvider.ts`): creates a labeled server
  whose cloud-init writes the seeded enrollment env file and runs
  `infra/relay/scripts/machine-bootstrap.sh` — Node, a clone of the configured source
  repository, and a systemd unit. Configured through `HETZNER_*` and `MACHINE_*` in
  `infra/relay/.env`; without a token, provisioning refuses.
- **Docker** (dev, `DockerComputeProvider.ts`): containers on the developer's own host,
  run by the dev relay from the image built with
  `docker build -t t3code-executor-dev -f infra/executor-image/Dockerfile .`. The
  loopback relay origin is rewritten to `host.docker.internal` and the host-mapped port
  is advertised as the machine's endpoint. The dev relay hands out no tunnels, so the
  endpoint is recorded as `manual`, exactly like a publish-only link.

Neither driver destroys compute the other created.

## Endpoints and quota

Managed endpoints reuse `ManagedEndpointProvider` unchanged. Machine allocations live in
the same user-keyed tables under the synthetic owner key `org:<organizationId>`
(`machineEndpointOwnerKey` in `infra/relay/src/machines/Machines.ts`) — renaming the
`user_id` column would drop-and-create it through the migration pipeline, and the prefix
can never collide with a Clerk subject id.

The quota is **one shared per-organization machine limit** across both roles
(`relay_organization_machine_limits`, default 5 in
`infra/relay/src/machines/MachineLimits.ts`), enforced at machine creation. This is the
billing lever for "buy managed machines"; splitting it per role later is a WHERE clause,
not a migration. The check is count-then-insert, same as the managed tunnel limit it is
modeled on: two admins racing can land one machine over — a billing rounding error, not a
security boundary.

## Tables

In `infra/relay/src/persistence/schema.ts`:

| table                               | notes                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `relay_machines`                    | org-bound, role column, seed hash (unique), environment identity and endpoint set at enrollment, `deprovisioned_at` tombstone |
| `relay_organization_machine_limits` | per-organization override of the shared machine quota                                                                         |

`relay_environment_credentials` gained a second validity anchor: a credential lives while
an active link **or** an active machine row backs it.

## Deferred from M2, deliberately

- **ADR-0006's executor half** — an executor refusing checkouts whose canonical key is
  not registered — is still not enforced. The relay can now tell an executor from a
  personal machine, but the refusal belongs in the executor's project-creation path,
  which the job runner's project materialization (M5) reshapes; wiring it into today's
  path would be built twice. [tenancy.md](./tenancy.md) tracks it.
- **Automatic reclamation** waits for the M4 mirror, as above.
- **Cross-org access does not exist** and is not planned: reaching an executor requires
  membership in its organization, full stop.
