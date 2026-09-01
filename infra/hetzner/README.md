# Self-hosted relay on Hetzner Cloud

Terraform for WP Nova's self-hosted relay: one Hetzner Cloud server carrying the whole hosted
control plane. The roadmap's platform move (M4) takes the relay off Cloudflare Workers onto a VM;
this is that VM. On the one machine:

- **Postgres** — the relay database, loopback-only, password generated on the box.
- **The relay** — the Node entry (`infra/relay/scripts/dev-server.ts`, the real HTTP surface,
  authorization, and SQL) as a Docker container built from
  [`infra/relay/Dockerfile`](../relay/Dockerfile), supervised by the `launchpad-relay` systemd
  unit on `127.0.0.1:8610`.
- **Caddy** — TLS for the relay domain, reverse-proxying to the relay.
- **Docker** — org machines provision as sibling containers on this host, booting the executor
  image built from `infra/executor-image/Dockerfile`.

Deploys ship the developer's local working tree with `deploy.sh` — rsync to the host, build the
images there, migrate, restart. No Git remote is involved, so unpublished work deploys exactly as
it is on disk, and the host never needs a Node toolchain.

## Provision

Requirements: Terraform, a Hetzner Cloud API token from the dedicated Launchpad project, and an
SSH public key at `~/.ssh/<name>.pub` for each name in `ssh_keys`.

```sh
cp terraform.tfvars.example terraform.tfvars   # fill in token and domain
terraform init
terraform apply
```

Then point the `relay_domain` A record at the `relay_public_ip` output — **DNS only** (grey
cloud), not proxied, so Caddy can complete its certificate issuance. Caddy retries until the
record resolves.

First boot installs Docker and Caddy, creates the database, and installs the service unit.
Progress is in `/var/log/launchpad-provision.log`; if a transient step failed, re-run
`bash /opt/provision/provision.sh` as root — it is idempotent.

## Deploy

From the repository, with the working tree you want live:

```sh
infra/hetzner/deploy.sh
```

The host defaults to `root@<relay_public_ip>` from this module's Terraform state; pass
`user@host` to override. The first build is slow (full dependency install in both images);
afterwards the pnpm store is cached by lockfile and deploys are mostly rsync plus a rebuild.

## Finish: operator secrets

The relay restarts until its secrets exist. Fill `/etc/launchpad-relay/relay.env` on the server
from [`../relay/.env.example`](../relay/.env.example) — Clerk keys and audience at minimum, plus
`GITHUB_APP_*` and `HETZNER_API_TOKEN` (same Launchpad project) if those features are in use —
then `systemctl restart launchpad-relay`.

`DEV_RELAY_DATABASE_URL` and `DEV_RELAY_ISSUER` are already set in
`/etc/launchpad-relay/provisioned.env`; do not repeat them.

## Operate

- Deploy: `infra/hetzner/deploy.sh` (rsync, build, migrate, restart, health check).
- Apply migrations alone, on the host: `launchpad-relay-migrate`.
- Logs: `journalctl -u launchpad-relay -f`.
- The server has Hetzner backups enabled; the database lives on the machine, so treat those
  backups as the recovery story.

Changing `cloud-init.yaml.tftpl` does not touch a live server — cloud-init runs once at first
boot and Terraform is told to ignore `user_data` drift so an edit cannot silently replace the
machine (and its database). Apply host-level changes by hand or by re-running an updated
`/opt/provision/provision.sh`, and keep the template as the record for the next machine.

## Current limits

The Node relay entry does not yet replace every Cloudflare binding (that is the rest of M4):
managed Cloudflare tunnels are refused, APNs delivery is dropped rather than queued, and org
machines run as Docker containers on this host rather than as separate Hetzner servers. Those
containers advertise loopback endpoints (`127.0.0.1:<port>`), which clients elsewhere cannot
reach — publicly reachable machine endpoints arrive with the rest of the platform move.
