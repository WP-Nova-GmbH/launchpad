---
status: accepted
---

# Self-hosted E2B replaces managed machine provisioning

The planned thread VM mode replaces Launchpad's Docker/Hetzner executor provisioning and
long-lived organization-machine model with self-hosted E2B execution and templates, using
one VM per thread. E2B supplies the VM machinery while Launchpad retains responsibility
for thread access, allocation limits, lifecycle policy and durable conversation history;
maintaining the old provisioning paths as parallel product options would preserve a second
execution model that does not meet the per-thread isolation requirement.

The first version starts from an existing local thread. Its environment uploads the repository
and conversation during the queued move; VM provisioning does not clone or fetch from GitHub.
Direct creation against a repository remote is outside this version. This keeps source-control
authentication on the source machine and avoids making the organization's GitHub App installation
a prerequisite for VM isolation or transfer.

Existing provisioned executors contain only disposable test data, so this replacement does
not require legacy executor-data migration or continued support for the old provisioning
backends. This supersedes [ADR-0001](./0001-executors-are-long-lived-environments.md) for
managed executor provisioning. The old drivers, executor image and relay Docker-socket
mount are removed; compatibility endpoints refuse creation and cannot destroy legacy compute.
Operator cleanup is required for any remaining managed resources. Manual enrollment, the relay
and ordinary local/remote environments remain supported. E2B product rollout is still gated by
the runtime and thread-transfer proofs; retiring the old drivers does not establish readiness.
