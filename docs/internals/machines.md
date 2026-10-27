# Organization machines

> For maintainers. Using Launchpad? See [docs/user](../user/organizations.md#machines).

Organization machines are manually enrolled environments. They share a filesystem and
provider tools with the people allowed to use them, so they are not the isolation boundary
for thread VM mode. Thread VMs have a separate enrollment, credential and placement path;
[ADR-0021](../adr/0021-self-hosted-e2b-replaces-managed-machine-provisioning.md) records why
E2B replaced managed Docker/Hetzner provisioning. Historical compute kinds and review-host
roles remain readable, but the relay refuses new managed provisioning. Legacy managed
compute must be removed on its original host; the retired API cannot confirm its destruction.

## Enrollment and disconnection

An admin connects an existing computer from Organization settings. The relay checks the
organization's machine limit and creates a single-use enrollment seed, stored only as a
hash and expiring after 24 hours. The response delivers the seed once. The admin starts the
server on their hardware with the returned relay URL and seed under a dedicated T3 home.

The server presents the seed inside a proof signed with its own environment key
([machine enrollment](../../apps/server/src/cloud/machineEnrollment.ts)). The relay claims
the seed atomically, provisions a managed endpoint and issues a durable environment
credential anchored by the machine record. An expired, unused enrollment must be disconnected
and created again. See [MachineEnroller](../../infra/relay/src/machines/MachineEnroller.ts).

Disconnecting is admin-triggered. Teardown tombstones the record, revokes credentials and
releases the managed endpoint in retryable order. It does not stop the computer, delete its
files or recover its thread history. Automatically deleting a manually managed machine is
not part of the thread VM lifecycle.

## Trust and access

Personal environment linking and organization enrollment stay disjoint: a linked environment
cannot enroll as a machine, and an enrolled machine cannot become a personal link. The
server enforces the same boundary from its local identity store.

[EnvironmentConnector](../../infra/relay/src/environments/EnvironmentConnector.ts) resolves
current organization membership on every call. A machine outside that organization answers
like a missing link. Relay discovery lists ready organization machines alongside personal
links; machine sync adds and removes their saved connection targets without touching personal
connections. Only managed tunnel endpoints can be called through this connector, including
in development; the retired Docker loopback exception is removed.

The relay signs environment proofs only after checking membership. Organization administrators
have access to these shared environments. Private thread VMs use thread-specific access checks
instead; being an organization administrator does not grant access to a private VM thread.

Managed endpoint allocations use the synthetic owner key `org:<organizationId>` in the existing
user-keyed tables. This keeps machine endpoints separate from Clerk subjects without changing
the table's ownership convention. The shared manual-machine limit is independent of thread VM
allocation limits and lifecycle policy.

## Credentials and provider tools

Manually enrolled agent executors may borrow their organization's GitHub App installation
token. The relay checks the active machine identity and organization connection before
minting. The server keeps the token in memory and passes it only to server-initiated source
control subprocesses, rather than inheritable process-wide environment variables. See
[ADR-0015](../adr/0015-executors-borrow-the-organizations-github-installation.md). Thread VMs
use the separate repository-scoped credential path; they cannot borrow this machine credential.

Provider accounts and organization skills retain their existing manual-executor flow described
in [tenancy](./tenancy.md#provider-accounts). A personal environment does not fetch those
organization accounts. Once enrolled, a manual executor installs missing provider CLIs through
[executorProviderToolchain](../../apps/server/src/provider/executorProviderToolchain.ts).
A failed install appears as a missing provider. E2B thread VMs use the versioned runner template
and support Codex only in the first version.

## Manual executor updates

The relay may name a source repository and ref through `MACHINE_SOURCE_GIT_URL` and
`MACHINE_SOURCE_GIT_REF`. A manually enrolled agent executor running a source checkout checks
that release at startup and every thirty minutes. It fetches with the organization's GitHub
credential, installs the new checkout and exits so its supervisor can restart it. See
[executorSelfUpdate](../../apps/server/src/cloud/executorSelfUpdate.ts). Bundled and personal
installs do not use this path, and thread VM templates are rebuilt explicitly rather than
updating the runner's files in place.
