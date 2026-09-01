---
status: accepted
---

# Executors enroll with a per-instance seeded identity and are single-tenant

An [executor](../internals/glossary.md#executor) is a machine the relay provisions, so the
existing environment-link flow does not apply to it: that flow is rooted in _a signed-in
human who already has access to the machine_, and a freshly created VM has no human. We
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
- Network isolation protects the _registration endpoint_ from outside callers. It does not
  contain credentials, because the untrusted code runs on machines inside the perimeter.
- The existing human-in-the-loop link flow stays in place for user-owned environments.
  Executor enrollment is a **second, parallel** trust path, not a replacement.
- Self-hosted executors (planned later) cannot use network restriction and will need their
  own enrollment story — most likely an org-scoped, revocable registration token.

## Amendment: no network restriction while the relay runs on Cloudflare Workers

As built in M2, the registration endpoint is **not** network-restricted. The relay is a
Cloudflare Worker until the M4 platform move, and a Worker has no internal network to
restrict to; the machines it creates (Hetzner Cloud servers in production, Docker
containers on the developer's host in dev) reach it over the public internet like every
other caller.

The controls that stand in: the seed is **single-use** (consumed atomically at
enrollment), **expiring** (24 hours), stored **only as a hash**, and presented inside a
proof **signed by the machine's own fresh key**, which binds the registered public key to
whoever holds the seed. An environment someone already linked can never enroll, and an
enrolled machine can never be linked, so neither trust path can be laundered into the
other. Revisit the network restriction when M4 puts the relay on a VM — though by then
the seed mechanics will have carried the load alone, which is also what the self-hosted
case (above) always required.

## Amendment: self-hosted machines enroll with the same seed

Self-hosted machines exist, and the "own enrollment story" predicted above turned out to
be no new mechanism at all. The previous amendment already conceded that the single-use
expiring seed carries the full load without a network perimeter — so the self-hosted path
changes only who delivers it: an admin creates the machine record, the relay returns the
seed exactly once in that response (the invitation-token delivery story), and the admin
runs it on their own hardware. Everything from the enroll call onward is identical.

The org-scoped, revocable _reusable_ registration token was considered and rejected: a
reusable credential would need its own storage, rotation, and revocation surface, and a
leak would let an outsider enroll machines until someone noticed. A per-machine
single-use seed is dead the moment it is used and worthless 24 hours after it is minted,
and "revocation" is deprovisioning the one machine it names. Single-tenancy, the
two-trust-path separation, and the seed mechanics are unchanged.
