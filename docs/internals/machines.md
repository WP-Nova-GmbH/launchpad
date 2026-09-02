# Machines

> For maintainers. Using Launchpad? See [docs/user](../user/).

A machine is compute bound to exactly one organization — provisioned by the relay or
self-hosted: an **agent executor** that runs work, or a **review host** that will run
review apps — one enrollment story, with the role difference costing a role column
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

A **self-hosted machine** takes the same path minus the driver: the admin connects it
from the same settings section (`connectMachine`, compute kind `self_hosted`), and the
seed comes back exactly once in that response — the invitation-token delivery story. The
UI turns it into a one-line setup command (`T3CODE_MACHINE_ENROLLMENT_SEED`,
`T3CODE_MACHINE_ENROLLMENT_RELAY_URL`, `npx t3 serve` under a dedicated `T3CODE_HOME`)
that the admin runs on their own hardware within the seed's 24 hours. From the enroll
call onward nothing distinguishes the two: same proof, same endpoint provisioning, same
quota, same teardown — minus the compute destroy, since `compute_ref` stays null.

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
  endpoint is recorded as `manual`, exactly like a publish-only link. The development
  connector accepts that endpoint only for a relay-provisioned organization machine and
  only when its HTTP and WebSocket URLs are matching loopback origins. Manual personal
  links remain ineligible for relay routing, and production keeps this escape hatch off.

Neither driver destroys compute the other created, and a self-hosted machine belongs to
no driver at all — its compute is the organization's own, so deprovisioning tombstones
the record, revokes the credential, and releases the endpoint, but destroys nothing.

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

## Source-control credentials

An executor never holds a GitHub login of its own. When one of its server-initiated git or `gh`
subprocesses needs GitHub, the executor asks the relay for an installation token minted from the
organization's connected GitHub App (`mintGithubInstallationToken` in
`infra/relay/src/http/SourceControlApi.ts`, consumed by
`apps/server/src/relay/OrganizationSourceControlCredentials.ts`). The relay answers only for an
active enrolled agent executor whose key matches, and only while the organization is connected.
On the executor the token stays in memory, is refreshed before it expires, and reaches child
processes through `VcsProcess` exactly as a runner token would — never through `process.env`, so
provider processes cannot inherit it. The executor image and bootstrap install `gh` because git
learns the token through its credential helper.
[ADR-0015](../adr/0015-executors-borrow-the-organizations-github-installation.md) has the
reasoning and the limits (GitHub only; the App's permissions bound what executors can do).

## Provider accounts and CLIs

An executor signs in to no provider either. It fetches the organization's provider accounts
from the relay and places them before building each provider instance — see
[tenancy.md](./tenancy.md#provider-accounts) for the flow and
[ADR-0003](../adr/0003-provider-credentials-are-fetched-by-executors-not-pushed.md) for the
decision. The service behind it (`apps/server/src/relay/OrganizationProviderAccounts.ts`) is a
reference with an empty default, provided only to the provider instance registry, so a personal
machine never consults the relay for accounts.

The provider CLIs themselves come with the machine. The executor image and the Hetzner bootstrap
install Codex, Claude Code, OpenCode, and Cursor's agent up front; a self-hosted machine, which
starts from nothing but Node and git, gets them on first start: once enrolled, the server checks
which provider CLIs resolve and installs the missing ones
(`apps/server/src/provider/executorProviderToolchain.ts` — npm packages through the provider
update action, Cursor through its own installer into `~/.local/bin`, which the server adds to its
PATH). A failed install is logged and shows on the provider settings page like any other missing
CLI.

## Executors update themselves

A push to the branch that deploys the relay reaches machines too. The relay names the source and
ref executors follow (`executorReleaseServer.getExecutorRelease`, from `MACHINE_SOURCE_GIT_URL`
and `MACHINE_SOURCE_GIT_REF`, default the GitHub repository's `main`). An enrolled agent executor
running from a source checkout asks on start and every thirty minutes
(`apps/server/src/cloud/executorSelfUpdate.ts`): it fetches the ref through the organization's
GitHub credential — the same `gh auth git-credential` helper clones use — and when the head has
moved resets the checkout to it, runs `pnpm install --frozen-lockfile`, and exits so the service
unit's `Restart=always` brings it back on the new code. A snapshot shipped without `.git` is
turned into a checkout in place the first time. The Docker executor image sets
`T3CODE_EXECUTOR_SELF_UPDATE=0`, because a container updates by being rebuilt; bundled installs
and personal machines never run this at all.

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
