# Self-hosted relay on Hetzner Cloud

Terraform for WP Nova's self-hosted relay: one Hetzner Cloud server carrying the whole hosted
control plane. The roadmap's platform move (M4) takes the relay off Cloudflare Workers onto a VM;
this is that VM. On the one machine:

- **Postgres** — the relay database, loopback-only, password generated on the box.
- **The relay** — the Node entry (`infra/relay/scripts/dev-server.ts`, the real HTTP surface,
  authorization, and SQL) as the `launchpad-relay` systemd service on `127.0.0.1:8610`.
- **Caddy** — TLS for the relay domain, reverse-proxying to the relay.
- **Docker** — org machines provision as containers on this host, booting the executor image
  built from `infra/executor-image/Dockerfile`.

Modeled on `llima-web/infrastructure/prod-hetzner`, except configuration happens through
cloud-init at first boot rather than Ansible: one machine, one script, re-runnable by hand.

## Provision

Requirements: Terraform, a Hetzner Cloud API token, and an SSH public key at
`~/.ssh/<name>.pub` for each name in `ssh_keys`.

```sh
cp terraform.tfvars.example terraform.tfvars   # fill in token and domain
terraform init
terraform apply
```

Then point the `relay_domain` A record at the `relay_public_ip` output. Caddy retries its
certificate until the record resolves.

First boot installs Node, Docker, and Caddy, clones the repository, installs dependencies,
applies migrations, and builds the executor image — expect several minutes. Progress is in
`/var/log/launchpad-provision.log`; if a transient step failed, re-run
`bash /opt/provision/provision.sh` as root.

## Finish: operator secrets

The relay restarts until its secrets exist. Create `/etc/launchpad-relay/relay.env` on the server
from [`../relay/.env.example`](../relay/.env.example) — Clerk keys and audience at minimum, plus
`GITHUB_APP_*` and `HETZNER_API_TOKEN` if those features are in use — then:

```sh
systemctl restart launchpad-relay
```

`DEV_RELAY_DATABASE_URL` and `DEV_RELAY_ISSUER` are already set in
`/etc/launchpad-relay/provisioned.env`; do not repeat them.

## Operate

- Deploy the latest `main`: `launchpad-relay-update` (pull, install, migrate, rebuild the
  executor image, restart).
- Apply migrations alone: `launchpad-relay-migrate`.
- Logs: `journalctl -u launchpad-relay -f`.
- The server has Hetzner backups enabled; the database lives on the machine, so treat those
  backups as the recovery story.

Changing `cloud-init.yaml.tftpl` does not touch a live server — cloud-init runs once at first
boot and Terraform is told to ignore `user_data` drift so an edit cannot silently replace the
machine (and its database). Apply config changes on the host, and keep the template as the
record for the next machine.

## Current limits

The Node relay entry does not yet replace every Cloudflare binding (that is the rest of M4):
managed Cloudflare tunnels are refused, APNs delivery is dropped rather than queued, and org
machines run as Docker containers on this host rather than as separate Hetzner servers. Those
containers advertise loopback endpoints (`127.0.0.1:<port>`), which clients elsewhere cannot
reach — publicly reachable machine endpoints arrive with the rest of the platform move.
