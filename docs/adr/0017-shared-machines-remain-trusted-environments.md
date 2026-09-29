---
status: accepted
---

# Shared machines remain trusted environments

Organization machines retain the existing environment-level filesystem and execution boundary.
Shared-thread collaboration does not introduce separate machines or agent sandboxes per repository.
Repository grants govern Launchpad thread discovery and operations; they do not promise
confidentiality from other agents or accessible files on the same host.

Per-repository execution isolation would require separating host APIs, runtime state and reachable
credentials as well as checkout directories. We keep the trusted-machine model to avoid making
that infrastructure change a prerequisite for reliable collaboration. People operating an
organization machine must be trusted with the data and capabilities available on it.

This preserves the current
[filesystem boundary](../internals/environment-auth.md#the-environment-is-the-filesystem-boundary)
and organization single-tenancy in
[ADR-0002](./0002-executor-enrollment-and-tenancy.md). Organization source-control credentials
remain governed by [ADR-0015](./0015-executors-borrow-the-organizations-github-installation.md).

Running environments may continue honoring their last confirmed permissions during relay outages.
We prefer keeping shared machines usable to requiring online authorization for every interaction.
Access removal remains visibly pending until all affected environments confirm enforcement;
cached access may continue meanwhile. Repository-scoped thread checks and enforcement over open
connections are still required as described in
[tenancy](../internals/tenancy.md#shared-thread-access).
