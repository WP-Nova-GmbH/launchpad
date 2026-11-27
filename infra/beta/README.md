# Deploy the internal beta

Use a clean checkout on the AMD64 Linux host as the deployment user with
sudo access. The host needs [E2B's native prerequisites](../../docs/operations/e2b-host-setup.md#prepare-the-linux-host),
Docker Compose 2.30 or newer, `jq`, `openssl`, and [`vp`](../../docs/operations/development.md#first-checkout).
Keep E2B's host-network listeners private with the host or upstream firewall.
The deployment installs the separate guest firewall and uses E2B's stock host setup.

Create a named Cloudflare tunnel with a published application route from the
beta hostname to `http://127.0.0.1:8610`. Use a hostname directly under its active
Cloudflare zone. The separate Cloudflare API token needs Cloudflare Tunnel Edit
for the account and Zone Read and DNS Edit for the zone. Launchpad uses it to
create VM routes and the deployment discovers the account from the zone.
Use the beta Clerk instance and its `t3-relay` JWT template with audience `t3-code-relay`.
[Tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
· [Clerk setup](../../docs/operations/connect-setup.md#jwt-template)

```sh
config="${XDG_CONFIG_HOME:-$HOME/.config}/launchpad-beta/beta.env"
test -e "$config" || install -D -m 0600 infra/beta/beta.env.example "$config"
```

Fill the five values in that file once. If the compute host has a public address
behind NAT, set `E2B_HOST_ADDRESSES` to its complete list of private and public
addresses. Then deploy:

```sh
./scripts/deploy-beta.sh
```

Use `--env-file /path/to/beta.env` for another private config file. The command
builds the checked-out relay commit, prepares stock E2B, verifies the AMD64
runner, applies database migrations, and checks public relay health. The relay
database uses host port `5433`, and E2B uses `5434`. Host port `5432` is available
for llima-web. The relay and connector readiness endpoints use loopback ports
`8610` and `8611`. Relay state is stored under `/var/lib/launchpad-beta` and its
database uses the `launchpad-beta_postgres` Docker volume.

Run the same command after checking out a newer commit or changing integration
credentials. The script reuses the existing PostgreSQL volume and E2B deployment.
The relay stops briefly for database migrations after the runner is verified.
After a host reboot, rerun it to restore the E2B host prerequisites. Once the
beta is up, connect the GitHub App, Codex account, and Linear workflow source
in Launchpad. Enable Linear admission after verifying webhook delivery.
