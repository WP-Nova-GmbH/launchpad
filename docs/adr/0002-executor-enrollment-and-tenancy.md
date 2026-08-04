---
status: accepted
---

# Executors enroll with a per-instance seeded identity and are single-tenant

An [executor](../internals/glossary.md#executor) is a machine the relay provisions, so the
existing environment-link flow does not apply to it: that flow is rooted in *a signed-in
human who already has access to the machine*, and a freshly created VM has no human. We
seed a **per-instance** private key and registration secret into each executor at creation
time, restrict the registration endpoint to our internal network, and make every executor
**single-tenant to one organization**.

## Considered options

- **Per-instance seeded credential (chosen).** The relay generates key material when it
  creates the VM and injects it into that instance. Presented once at registration, then
  exchanged for a durable environment credential.
- **Cloud provider attestation.** The VM presents a provider-signed instance identity
  document; nothing secret is written to disk. Stronger, but ties enrollment to a specific
  cloud's attestation API — a poor fit for the later self-hosted-executor case.
- **Key baked into the image.** Rejected. Every instance launched from that image shares
  one identity; a single leaked snapshot compromises every executor ever launched, and
  revocation requires an image rebuild.

## Why single-tenant

An executor holds the organization's provider credentials on disk while coding agents run
shell commands on it at runtime modes up to `full-access`. There is no mechanism preventing
an agent from reading those credentials — that is inherent to giving an agent a shell.
Single-tenancy is therefore the only thing bounding the blast radius: a compromised
executor exposes one organization's credentials, not several.

## Consequences

- Utilization is worse than a pooled fleet. Idle single-tenant executors cost money, and
  that is accepted as the price of isolation.
- Network isolation protects the *registration endpoint* from outside callers. It does not
  contain credentials, because the untrusted code runs on machines inside the perimeter.
- The existing human-in-the-loop link flow stays in place for user-owned environments.
  Executor enrollment is a **second, parallel** trust path, not a replacement.
- Self-hosted executors (planned later) cannot use network restriction and will need their
  own enrollment story — most likely an org-scoped, revocable registration token.
