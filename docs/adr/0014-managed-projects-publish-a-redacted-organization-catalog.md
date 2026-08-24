---
status: accepted
---

# Managed projects publish a redacted organization catalog

Every managed agent executor publishes a redacted snapshot of its active
[projects](../internals/glossary.md#project) to the [relay](../internals/glossary.md#relay). The
relay retains that snapshot while the executor is offline and serves it as an organization-scoped,
read-only project catalog.

This catalog may ship before the full organization event mirror in
[ADR-0012](./0012-executors-mirror-their-event-log-to-the-relay.md). It is a discovery projection,
not an alternative thread-history store.

## Why

The relay already owns durable organization, repository, and machine records, but clients built
their Start and Add Project views only from live environment snapshots. Turning an executor off
therefore made its projects disappear and also hid relay-owned repositories from the place where a
user chooses work. An organization administrator in particular appeared to have no projects unless
they held a redundant repository grant or the executor happened to be online.

Repository registration and project existence are different facts. Both must remain discoverable:
the registered repository is durable relay state, while the project catalog records the last known
checkout on an organization machine.

## The catalog is deliberately redacted

An entry contains only project id, title, repository canonical key when known, project timestamps,
and its environment and machine identity. It does **not** contain a workspace path, messages,
activities, checkpoints, provider state, or file content.

The executor signs the complete snapshot with its environment key and sends it with the enrolled
environment credential. The relay accepts it only for an active agent executor, replaces older
revisions atomically, and ignores delayed snapshots. Personal environments never publish into this
organization-scoped table.

## Authorization

- Organization admins read every catalog entry and every registered repository without needing a
  repository grant. Administration is already their organization role.
- Members read catalog entries only when the project's canonical key belongs to a repository on
  which they hold a role.
- Projects without a known registered repository identity are visible only to admins.

Authorization is resolved from current relay membership and repository access on every read. It is
not copied into the catalog and never comes from an identity-provider claim.

## The environment remains authoritative

Catalog entries can be shown while their machine is offline, but cannot accept commands. Starting a
thread, opening files, or cloning a repository still requires a connected target environment. A
client must label a catalog-only project as offline instead of presenting it as runnable.

The full event mirror remains necessary for reading chat history offline and for reclaiming an
executor without losing the record. Nothing in this catalog may be used as a command target or
expanded into a second project authority.
