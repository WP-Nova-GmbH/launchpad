---
status: accepted
---

# A repository owns a set of canonical keys, and executors refuse unregistered ones

A [repository](../internals/glossary.md#repository) is relay-minted and relay-owned, but a
checkout has to be _recognised_ as belonging to one without anyone binding it by hand. We
derive a **canonical key** from the checkout's git remote and match it against the set of keys
a repository owns. One repository has many keys; unmatched checkouts can be bound explicitly,
which adds an alias.

## Why a set and not a single key

`normalizeGitRemoteUrl` (`packages/shared/src/git.ts`) already reduces a remote to
`host/owner/repo`, and `RepositoryIdentityResolver` already derives that plus owner, name, and
provider — cached per git toplevel. Auto-association is therefore nearly free. But a single key
per repository breaks on cases that are normal, not exotic:

- **Mirrors.** One developer's `origin` is `github.com/acme/api`; another's is the internal
  mirror `gitlab.acme.internal/acme/api`. Same code, same pull requests, two keys.
- **Forks.** A fork's `origin` is `github.com/carol/api` while `upstream` is the org's repo, and
  `pickPrimaryRemote` prefers `origin` — so the checkout keys to the fork.

An alias set turns both from modelling problems into a row: `repository_aliases
{ repositoryId, canonicalKey }` with a unique index on `canonicalKey`, so a key can only ever
belong to one repository.

## Unregistered checkouts

Behaviour differs by machine, deliberately:

- **On an [executor](../internals/glossary.md#executor): refuse.** An executor works only on
  repositories an admin registered. Otherwise "which repositories does my organization have"
  degrades into whatever anyone happened to clone onto a machine the org pays for.
- **On a personal machine: derive freely.** Show that the checkout is not part of the
  organization, and offer registration if the user is an admin. A developer's own machine is
  not a place to enforce a catalogue.

## Consequences

- A checkout with **no remote** has no repository identity — `RepositoryIdentityResolver`
  returns `null` — so it is simply not org-governed. It gains identity naturally if a remote is
  added later. No special handling needed.
- **Monorepo subdirectories share one repository**, because the canonical key derives from the
  git toplevel. Access control at repository granularity is intended; targeting _part_ of a
  monorepo is a pipeline-scoping concern, to be solved there rather than by splitting identity.
- Changing this later means re-binding every checkout, so the alias table should land with the
  repository table rather than being retrofitted.
