---
status: accepted
---

# Provider credentials are fetched by executors from Infisical, never pushed by the relay

Organizations own the provider API keys their [executors](../internals/glossary.md#executor)
run on. We store those secrets in **Infisical**, keep only _references_ in the relay's
Postgres, and have each executor fetch the value itself using its own Infisical machine
identity at provider session start. The relay never reads, holds, or transmits a provider
secret.

## Considered options

- **Executor-direct (chosen).** Relay pushes `{ provider, label, secretRef }`. The executor
  resolves the reference against Infisical with a per-executor machine identity.
- **Relay-mediated.** Relay reads the secret from Infisical and pushes the value down the
  config channel.
- **Encrypted in relay Postgres.** Envelope encryption with a master key in the relay's
  process config, no external dependency.

## Why

**Revocation stops depending on the config channel.** `RelayEnvironmentAuth` authenticates an
environment by credential hash alone — no user, no session. The relay can still authorize that
request, because organization membership lives in its own database and resolving
`executor → organization → membership` is a local query. What it cannot do is reach a machine
that has stopped listening. Under relay-mediated delivery, an executor that is unreachable, or
whose config channel is degraded, keeps whatever secrets it was last handed. Under
executor-direct, revoking that executor's Infisical machine identity cuts provider access at the
_source_, independent of the relay link, the config channel, and whether the machine can be
contacted at all.

Secondary benefits: the relay's Postgres holds nothing sensitive, so a database dump is
inert and there is no master key to rotate; the config-push channel carries **zero
secrets**, which sharply lowers its security requirements; and Infisical yields a per-machine
audit trail of which executor read which credential when.

## Consequences

- **Infisical availability gates provider sessions.** A session start with an unreachable
  Infisical must fail with a clear error rather than fall back to a stale key of unknown
  validity. A short in-memory cache is acceptable; writing the value to disk is not.
- **Secrets are never persisted on the executor.** They are fetched at spawn and injected
  into the child process environment only — no `ServerSecretStore` entry, so no copy in
  backups or snapshots.
- **On-machine exposure is unchanged.** Agents run as the same user as the provider process
  and can read `/proc/<pid>/environ`. Single-tenancy ([ADR-0002](./0002-executor-enrollment-and-tenancy.md))
  remains the only bound on that blast radius.
- **Infisical's own "organization", "project", and "environment" nouns collide with ours.**
  Always qualify them as _Infisical project_ / _Infisical environment_ in code and docs.

## Amendment: subscription account sessions are environment-local

The credential pool above is for non-human provider credentials used by unattended organization
work. Codex, Claude, and Cursor also support signing their CLIs into a person's subscription. Those
sessions are a different kind of credential: the provider CLI owns a renewable OAuth cache rather
than accepting one secret value at process spawn.

For a long-lived executor, an administrator may therefore complete the provider's native account
login against that executor. The provider CLI persists the resulting session in its own auth store
on the executor's durable volume. The relay neither receives nor stores the session, and the
session is never represented as an Infisical secret reference. It is available to provider
processes on that executor and consequently to organization work placed there.

Account sessions are deliberately **not replicated between executors**. Logging into one executor
does not create an organization-wide credential pool entry, and deprovisioning that executor
destroys its copy. Logout is performed by the same provider CLI on the same executor. This keeps
opaque, provider-specific refresh state at the boundary that understands it while the original
executor-direct API-key design remains the path for fleet-wide unattended credentials.

## Amendment: organization provider accounts are held sealed by the relay and delivered to executors

_Supersedes the decision above and the previous amendment. 2026-09-02._

The requirement that surfaced once executors existed is simpler than the design above: an admin
signs in to Codex, Claude, Cursor, or OpenCode **once**, and every executor of the organization
works with that sign-in. Nobody signs in on a machine, and a machine that joins later needs nothing
done to it. The credential people actually hold is a subscription session, not an API key, so a
design that only distributes keys does not meet it, and one that keeps sessions machine-local
(the previous amendment) makes every new executor a chore.

**Decision.** The relay holds one **provider account** per provider per organization, in
`relay_organization_provider_accounts`, as either one environment variable (an API key or a
long-lived token) or the provider CLI's own auth store copied file for file. The payload is sealed
with `auth/SecretBox.ts` under the relay's cloud mint key, exactly like a GitHub App private key
created from Organization settings. Admins capture an account from their own device
(`server.exportProviderAccount` reads the CLI's store; the admin's client stores it at the relay)
or paste a key. Enrolled agent executors **pull** the set over their environment credential
(`providerAccountsServer.fetchProviderAccounts`), keep it in memory, re-fetch on a timer, and place
it before each provider instance is built: a variable into the instance's environment, an auth
store into the directory that CLI reads. Infisical is not introduced.

**Why this and not the original.** The revocation argument for Infisical assumed a relay that could
not reach its executors; the relay now holds a persistent path to every enrolled machine, and an
account removed at the relay is gone from executors on their next fetch. What Infisical bought
(per-machine identities, a per-read audit trail) was never built and would have been a second
secrets system to run for a handful of rows. Sealing in Postgres keeps the "database dump is inert"
property; the trade is that the cloud mint key now also guards these rows, so rotating it means
re-sealing them.

**Consequences.**

- Invariant 9 of the agent brief becomes: no **plaintext** secret in relay Postgres. Sealed rows
  are allowed; the key never is.
- Provider CLIs refresh OAuth sessions on their own. Executors keep their refreshed copy and the
  relay's version marker beside it; a copy is replaced only when an admin shares a new sign-in. If a
  provider revokes the older refresh token when a newer one is issued, executors can drift out of
  sign-in and the fix is to share again. This is accepted rather than solved.
- The set of providers is closed: Codex, Claude, and OpenCode take a sign-in or a key; Cursor's
  agent keeps no session Launchpad can read and takes a key only; Grok is not covered.
- On-machine exposure is unchanged from the original decision, and an executor still holds the
  account only in memory and in the provider's own store.
- Personal machines are untouched: the executor service is provided only to enrolled agent
  executors, and everywhere else reads as "no accounts".
