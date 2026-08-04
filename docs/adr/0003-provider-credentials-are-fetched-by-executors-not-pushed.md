---
status: accepted
---

# Provider credentials are fetched by executors from Infisical, never pushed by the relay

Organizations own the provider API keys their [executors](../internals/glossary.md#executor)
run on. We store those secrets in **Infisical**, keep only *references* in the relay's
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
*source*, independent of the relay link, the config channel, and whether the machine can be
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
  Always qualify them as *Infisical project* / *Infisical environment* in code and docs.
