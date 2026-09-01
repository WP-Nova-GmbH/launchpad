# Tenancy

> For maintainers. Using Launchpad? See [docs/user](../user/).

Organizations, membership, roles, repositories, and invitations live in the relay's own database.
Clerk provides **authentication only** — a sign-in and a verified subject id. Nothing about tenancy
is delegated to it, so `subject → organization → role` is a local query on every authorized path,
including ones that hold no user token at all.

Vocabulary is in the [glossary](./glossary.md#org-control-plane); the decisions behind this are
[ADR-0006](../adr/0006-repositories-own-a-set-of-canonical-keys.md) and
[ADR-0007](../adr/0007-the-org-layer-is-defaults-not-enforcement.md).

## Every subject belongs to exactly one organization

The relay never observes a signup, so there is no moment at which it could provision an
organization ahead of time. Instead the **first authorized request creates one**, with the caller as
its admin (`resolveMembership` in `infra/relay/src/http/TenancyApi.ts`).

"Exactly one" is enforced by the database, not by the service: `relay_organization_members` carries
a unique index on `user_id`. Two concurrent first requests race on that index, and the loser deletes
the organization it had speculatively created rather than leaving an unreachable row behind.

Joining another organization is therefore a **move**, not an addition. Accepting an invitation is
refused while the organization being left still holds other members or repositories — abandoning
them silently would be worse than refusing.

## Roles

| role         | scope          | what it carries                                                                         |
| ------------ | -------------- | --------------------------------------------------------------------------------------- |
| `admin`      | organization   | members, invitations, repository registration, and every repository in the organization |
| `member`     | organization   | can see the roster; sees only repositories they hold a role on                          |
| `maintainer` | one repository | configures it: canonical keys and who has access                                        |
| `developer`  | one repository | works in it                                                                             |

Having no repository role means having no access to that repository, and a member asking about one
gets the same answer as for a repository that does not exist. Telling them otherwise would leak the
catalogue one 404 at a time.

An admin cannot change their own role, and the last admin cannot be removed. Both exist so an
organization cannot end up with nobody able to administer it.

Removing a member also clears every repository grant they held. Left behind, those rows would
silently restore access if the person were ever invited back.

## Repositories and canonical keys

A repository is relay-owned and spans machines; a checkout is recognised as belonging to one by its
**canonical key** — the git remote reduced to `host/owner/repo` by `normalizeGitRemoteUrl`.

One repository owns a **set** of keys, because mirrors and forks are normal rather than exotic
(ADR-0006). The key is the primary key of `relay_repository_aliases`, so a key can only ever belong
to one repository anywhere. The last key cannot be removed: a repository no checkout can match is
unreachable.

Whoever registers a repository becomes its first maintainer — a repository nobody maintains would
be unusable the moment it existed.

### Unregistered checkouts

Behaviour differs by machine, deliberately:

- **On a personal machine: derive freely.** A checkout nobody registered is simply not org-governed.
  Settings → Organization shows admins which visible checkouts are not part of the organization and
  offers to register them.
- **On an executor: refuse.** Still not enforced. Machines exist now (see
  [machines.md](./machines.md)), so the relay can tell an executor from a personal machine — but the
  refusal belongs in the executor's project-creation path, which the job runner's project
  materialization (M5) reshapes; it lands there rather than being built twice.

What _is_ enforced today is the other half: dispatching a job against a canonical key that **is**
registered requires a role on that repository (`requireRepositoryAccessForDispatch` in
`infra/relay/src/http/Api.ts`). An unregistered key stays dispatchable.

## Invitations

An invitation is an email address, a role, and a **single-use token**. Only the token's SHA-256 hash
is stored — the relay has no reason to be able to reproduce a token it already handed out — so the
value exists exactly once, in the response that created it.

Redeeming one requires the token _and_ a Clerk-verified email address matching the invitation, so a
forwarded link cannot be redeemed from another account. Claiming the invitation is the first write
inside the transaction, which is what makes it single use under concurrency.

Creating an invitation for an address supersedes any pending one for the same address, so
re-inviting cannot leave two live tokens behind.

**There is no transactional email provider yet.** The admin who creates an invitation delivers the
link. When a provider lands, it sends the same token and nothing else about the flow changes.

## GitHub connection

An organization connects GitHub by installing the relay's GitHub App — on a whole GitHub
organization, or on selected repositories. What is recorded is the **installation id**, which is not
a secret; access tokens are minted per request and never persisted. The App's private key lives in
relay configuration (`GITHUB_APP_*`) or, when the App was created from Organization settings, in
`relay_github_apps` sealed with AES-GCM under a key derived from the relay's cloud mint key
(`auth/SecretBox.ts`) — so the "no secret in relay Postgres" rule holds in spirit: a database copy
on its own is inert. Configuration wins when both exist.

This is deliberately not "sign in with GitHub". An OAuth token belongs to one person and dies with
their session, so access would not be the organization's. With an installation, **every member
reaches the connected repositories** without holding a GitHub credential of their own — and so do
the organization's managed executors, which clone and push with tokens the relay mints from the
same installation
([ADR-0015](../adr/0015-executors-borrow-the-organizations-github-installation.md)).

Creating the App is a one-time step per relay, done from the organization page: while the relay
has no App, an admin sees **Create the GitHub App** instead of **Connect GitHub**. Both buttons
open a browser journey on relay-hosted pages (`http/GithubAppSetupRoute.ts`), because the desktop
app cannot be a GitHub redirect target and hands every external URL to the system browser:
`/github-app/start` posts the manifest to GitHub; GitHub's `/github-app/created` callback converts
the code, seals the key, stores the App, and sends the admin straight on to GitHub's install page;
GitHub's `/github-app/installed` setup callback claims the installation for the organization. Each
hop carries a state JWT signed by the cloud mint key naming the admin, the organization, and the
return address, so the callbacks trust only the relay's own signature. The client refreshes when
it regains focus; a web return address is redirected to, a desktop one (`t3code://`) gets a page
linking back to the app. `tenancy/GithubAppSetup.ts` owns the flow;
`infra/relay/scripts/create-github-app.ts` is the same manifest for operators who prefer to
configure `GITHUB_APP_*` by hand.

**Known gap.** The relay verifies that a claimed installation exists and refuses one another
organization already claimed, but it cannot yet prove the caller administers that GitHub account —
that would need a user OAuth leg. Claiming someone else's installation means guessing a numeric id
before its owner claims it. Close this before the relay is multi-tenant.

## Tables

All in `infra/relay/src/persistence/schema.ts`:

| table                            | notes                                                               |
| -------------------------------- | ------------------------------------------------------------------- |
| `relay_organizations`            | id and name                                                         |
| `relay_organization_members`     | unique on `user_id` — the "exactly one organization" rule           |
| `relay_organization_invitations` | unique on `token_hash`; `accepted_at` / `revoked_at` decide pending |
| `relay_repositories`             | scoped to an organization                                           |
| `relay_repository_aliases`       | canonical key is the primary key; organization denormalized         |
| `relay_repository_access`        | `(repository, user)`; organization denormalized                     |
| `relay_github_installations`     | one per organization; unique on `installation_id`, holds no secret  |

Machines — the organization's provisioned executors and review hosts — have their own tables and
their own document: [machines.md](./machines.md).

Organization ids are denormalized onto alias and access rows so a checkout can be resolved to its
organization without a join, including on paths that hold no user token.

## Surfaces

- **Relay**: `RelayOrganizationGroup` and `RelayRepositoriesGroup` in
  `packages/contracts/src/relay.ts`, handled in `infra/relay/src/http/TenancyApi.ts`.
- **Clients**: `ManagedRelayTenancyClient` in `packages/client-runtime/src/relay/`. Kept apart from
  `ManagedRelayClient`, which exists to reach an environment and authenticates with DPoP-bound
  tokens; tenancy calls use a plain Clerk bearer.
- **Web and desktop**: Settings → Organization. There is no mobile surface — organization
  administration is a desk task, and mobile has no equivalent settings section.
