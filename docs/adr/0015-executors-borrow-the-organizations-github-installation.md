---
status: accepted
---

# Executors borrow the organization's GitHub App installation for source control

A managed [agent executor](../internals/glossary.md#executor) authenticates to GitHub with a
short-lived **installation token** that the [relay](../internals/glossary.md#relay) mints from the
organization's GitHub App installation, at the executor's request, when the executor needs one.
Nobody signs in on an executor. Connecting GitHub once, in Organization settings, is what grants
the organization's fleet access to the connected repositories.

## Why

Cloning, pushing, and opening pull requests on an executor need a GitHub credential, and neither
credential that already existed could be the answer.

A person's `gh auth login` is that person's session. It has to be performed by hand on every
executor, it names one human as the author of fleet work, and it outlives that human's membership
in the organization. A runner token pinned into the machine's environment
([ADR-0009](./0009-workflow-steps-have-kinds-and-agents-never-push.md)) is a long-lived secret an
operator has to create, distribute, and rotate per machine — exactly the manual step managed
compute exists to remove.

The organization already holds the right credential. Connecting GitHub installs the relay's App on
the organization's account, and the relay mints tokens from that installation on request today to
list repositories. Handing an executor the same kind of token gives it precisely the access the
organization granted the App — the connected repositories, with the App's permissions — and nothing
else.

## How it works

- The relay exposes one environment-authenticated endpoint. It answers only for an active,
  enrolled agent executor whose environment key matches the presented credential, resolves that
  machine's organization, and mints a token from the organization's installation. An organization
  that has not connected GitHub gets a not-found the executor reads as "no credential".
- The executor requests a token when one of its own git or `gh` subprocesses needs it, keeps it in
  memory, refreshes it five minutes before expiry, and never writes it to disk or into its own
  process environment. It reaches child processes through the same seam a runner token does —
  `GH_TOKEN` on server-initiated VCS subprocesses only — so provider processes and agents never
  inherit it.
- git learns the token through the GitHub CLI's credential helper, which the executor configures
  per clone; `gh` reads `GH_TOKEN` directly. Executor images and bootstrap install `gh` for this.
- Personal machines are untouched: the credential service is not provided there, and ambient
  logins keep working. An explicit runner token on any machine still wins, so an operator can pin
  one.

## Relation to ADR-0003

[ADR-0003](./0003-provider-credentials-are-fetched-by-executors-not-pushed.md) forbids the relay
from pushing provider secrets so that revocation never depends on reaching a machine. An
installation token is a different kind of credential and keeps that property. It is minted per
request rather than stored anywhere; it expires within the hour on its own; and revoking it means
disconnecting GitHub in Organization settings (the relay refuses further mints) or uninstalling the
App on GitHub (outstanding tokens die). No long-lived secret ever leaves the relay, and the relay's
database still holds only the installation id.

## Consequences

- **The App's permissions bound what executors can do.** Cloning needs _Contents: read_, pushing
  needs _Contents: write_, pull requests need _Pull requests: write_. An organization that grants
  less sees the corresponding operation fail as a credentials error.
- **Fleet work is authored by the App.** Commits and pull requests made with an installation token
  come from the App's bot account, not from the person who triggered the work. Attributing
  automated work to a human is out of scope here.
- **GitHub only.** GitLab, Bitbucket, and Azure DevOps executors still need a credential configured
  by hand. The seam is provider-neutral; the mint is not.
- **On-machine exposure is unchanged** from ADR-0003: a process on the executor running as the same
  user can read the token from a live git process's environment. Single-tenancy
  ([ADR-0002](./0002-executor-enrollment-and-tenancy.md)) remains the bound.
- **Settings reports what is true.** `gh auth status` cannot vouch for an installation token — it
  has no user behind it — so discovery on an executor reports GitHub as authenticated through the
  organization's installation instead of repeating the CLI's answer.

## Amendment: the App itself is created from the app

The whole point is that nobody runs anything by hand, so the relay's GitHub App must not require a
terminal either. An organization admin creates it from Organization settings through GitHub's
manifest flow; the relay receives the App's private key on GitHub's callback and stores it sealed
(AES-GCM under a key derived from the relay's own cloud mint key) in `relay_github_apps`.

This is the one secret the relay keeps in Postgres, and it is the relay's own identity rather than
an organization's credential — which is why ADR-0003's reasoning does not apply: there is nothing
to revoke per executor, and the sealed value is inert without the relay's configuration. Operators
who prefer to hold the key themselves can still configure `GITHUB_APP_*`, which wins when set.
