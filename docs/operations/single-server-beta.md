# Internal Launchpad workflow beta on one Linux server

Run the relay, PostgreSQL, and stock E2B on one AMD64 Ubuntu 24.04 host.
Desktop, Linear, and workflow VMs reach `https://relay-beta.example.com` through a
named Cloudflare Tunnel to `http://127.0.0.1:8610`. The relay reaches E2B locally.
The E2B guest firewall blocks direct guest access to the host, including its public
IP. Use one VM slot, one test repository, and one Linear team for the first run.
Replace the example hostname with your beta hostname throughout.

| Service                   | Address used by the server            |
| ------------------------- | ------------------------------------- |
| Launchpad relay           | `127.0.0.1:8610`                      |
| llima-web PostgreSQL      | `127.0.0.1:5432`                      |
| Launchpad PostgreSQL      | `127.0.0.1:5433`                      |
| E2B PostgreSQL            | `127.0.0.1:5434`                      |
| E2B API and sandbox proxy | `127.0.0.1:3000` and `127.0.0.1:3002` |

## Prepare the host

Follow the [native E2B prerequisites](e2b-host-setup.md#prepare-the-linux-host),
including Docker with Compose v2 and Buildx. Verify `x86_64`, working KVM, and a
4 KiB-page kernel at version 6.8 or newer. Check E2B's required listener ports
against `sudo ss -ltnp`, including Redis and ClickHouse. Budget about 32 GiB RAM and at least
150 GiB SSD as a starting point for the combined host. Hetzner Cloud instances
lack KVM access for nested guests. [Hetzner Cloud virtualization limits](https://docs.hetzner.com/cloud/servers/faq/#can-i-run-virtual-machines-on-cloud-servers-or-rather-is-nested-virtualization-possible)

Before starting E2B, restrict the provider or upstream firewall to inbound SSH
from your admin network on both IPv4 and IPv6. Stock E2B uses host networking,
so the loopback URLs in the relay settings alone leave the E2B listeners unchanged.
Allow outbound TCP and UDP `7844` for Cloudflare connectors, as well as DNS and
HTTPS for builds, provider APIs, and guest callbacks. Synchronize the server clock.
[Stock E2B Compose](https://raw.githubusercontent.com/e2b-dev/runtime/518278060a154124a80d98f37253f8af77baf478/embed/compose/compose.yaml)
· [Cloudflare tunnel firewall requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)

Set `BETA_COMMIT` to the exact published beta commit containing P07, the relay
startup log fix, and the AMD64 runner. Use it for the relay, runner image, and
desktop installer.

```sh
git clone --branch codex/vm-sandboxing git@github.com:WP-Nova-GmbH/launchpad.git launchpad-beta
cd launchpad-beta
git switch --detach "${BETA_COMMIT:?Set BETA_COMMIT to the beta commit}"
```

Install `vp` as described in [Development](development.md#first-checkout) and run
`vp i --frozen-lockfile` from this checkout before starting or building E2B.

## Deploy the relay

Create a dedicated PostgreSQL container for the relay on `5433`. First create
`/etc/launchpad-relay/postgres.env` as root with mode `0600` and set `POSTGRES_USER`
and `POSTGRES_DB` to `launchpad_relay`. Set `POSTGRES_PASSWORD` to a URL-safe password.

```sh
sudo apt-get update
sudo apt-get install -y jq
sudo install -d -m 0750 /etc/launchpad-relay
sudo install -d -m 0700 /var/lib/launchpad-relay /var/lib/launchpad-relay/thread-artifacts
```

After creating `postgres.env`, start the container and wait for PostgreSQL to
accept TCP connections on the relay's host port. The initial database setup
uses a temporary Unix socket, so the TCP check waits for the regular server.

```sh
sudo docker run -d --name launchpad-relay-postgres --restart unless-stopped \
  --publish 127.0.0.1:5433:5432 --env-file /etc/launchpad-relay/postgres.env \
  --volume launchpad-relay-postgres:/var/lib/postgresql/data postgres:16 &&
  sudo docker run --rm --network host postgres:16 timeout 60s bash -c '
    until pg_isready -q -h 127.0.0.1 -p 5433 -U launchpad_relay -d launchpad_relay; do
      sleep 1
    done
  '
```

Continue when the check succeeds. If it times out, inspect the database logs
with `sudo docker logs launchpad-relay-postgres` before running relay migrations.

Create the following two files as root with mode `0600`. Use the password from
`postgres.env` in the database URL.

`/etc/launchpad-relay/provisioned.env`

```dotenv
DEV_RELAY_DATABASE_URL=postgres://launchpad_relay:<password>@127.0.0.1:5433/launchpad_relay
DEV_RELAY_ISSUER=https://relay-beta.example.com
DEV_RELAY_CLOUD_MINT_PRIVATE_KEY_PATH=/var/lib/launchpad-relay/cloud-mint-private.pem
DEV_RELAY_ARTIFACT_ROOT=/var/lib/launchpad-relay/thread-artifacts
```

`/etc/launchpad-relay/relay.env`

```dotenv
CLERK_PUBLISHABLE_KEY=<beta Clerk publishable key>
CLERK_SECRET_KEY=<beta Clerk secret key>
CLERK_JWT_AUDIENCE=t3-code-relay
APNS_ENABLED=false
LINEAR_WORKFLOW_ADMISSION_ENABLED=false
```

Use your beta Clerk instance and limit sign-in to the internal testers.
Create the `t3-relay` JWT template with `{"aud":"t3-code-relay"}`.
Enable Native API, allow the desktop callback `t3code://app/`, and add
`t3code://app` to the instance's allowed origins. [Clerk setup](connect-setup.md#jwt-template)

Copy the bodies of the `launchpad-relay.service` and `launchpad-relay-migrate`
entries in the [relay cloud-init template](../../infra/hetzner/cloud-init.yaml.tftpl)
to `/etc/systemd/system/launchpad-relay.service` and
`/usr/local/bin/launchpad-relay-migrate`. These use host networking and mount the
relay data directory. The tunnel terminates HTTPS for this setup.

Build the image from committed files so local env files and other checkout state
stay outside the image. Run these commands from the checkout root.

```sh
sudo chmod 0755 /usr/local/bin/launchpad-relay-migrate
git archive --format=tar HEAD | sudo docker build -t launchpad-relay -f infra/relay/Dockerfile - &&
  sudo launchpad-relay-migrate &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable --now launchpad-relay
```

Once the service starts, check `curl -fsS http://127.0.0.1:8610/health`.

## Publish the relay and VM endpoints

Create a named, remotely managed tunnel for the relay. Install `cloudflared` on
the host using Cloudflare's Linux packages and configure it as a boot service.
Keep the connector token in an owner-only file and use `cloudflared tunnel run
--token-file /etc/cloudflared/launchpad-beta.token` in the service. The token-file
option requires cloudflared 2025.4.0 or later. Add a **Published application**
route for `relay-beta.example.com` to `http://127.0.0.1:8610` and route all paths.
Use the proxied tunnel DNS record. [Cloudflare dashboard setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
· [Linux packages](https://pkg.cloudflare.com/) · [Tunnel token-file option](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file)

Launchpad gives each VM its own managed hostname. Use the parent Cloudflare
zone so Universal SSL covers first-level names such as `beta-<hash>.example.com`.
Let Launchpad handle authentication on the relay and VM routes so webhooks and
WebSockets can connect without browser challenges.
[Cloudflare certificate coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)

Verify public relay health from a different machine. Keep this same HTTPS origin
for `DEV_RELAY_ISSUER`, `E2B_PUBLIC_RELAY_URL`, `T3CODE_RELAY_URL`, and provider
callbacks.

```sh
curl -fsS https://relay-beta.example.com/health | jq -e '.ok'
```

## Build and enable the E2B runner

Generate stock E2B for AMD64 with a loopback PostgreSQL binding on `5434`.
Follow [Build the Launchpad runtime](e2b-host-setup.md#build-the-launchpad-runtime)
to install the guest firewall and run the first-time Compose setup. Return to
the Launchpad checkout before using the verified Linux launcher. It uses
non-interactive sudo.

```sh
sudo python3 infra/e2b/build-stock-runtime.py /var/lib/launchpad-e2b \
  --arch amd64 --postgres-host-port 5434
```

```sh
sudo -v
vp run start:vm-host
curl -fsS http://127.0.0.1:3000/health
```

Save the [E2B team key](e2b-host-setup.md#retrieve-the-e2b-api-key) in an
owner-only file. The runner build and smoke check use the same API origin.

```sh
export E2B_API_KEY_FILE="$HOME/.config/launchpad-beta/e2b-api-key"
export E2B_API_URL=http://127.0.0.1:3000
export E2B_SANDBOX_URL=http://127.0.0.1:3002
export E2B_TEMPLATE_FILE="$PWD/infra/relay/.t3/e2b-template-beta-amd64.json"

sudo -v
E2B_API_KEY="$(cat "$E2B_API_KEY_FILE")" vp run build:vm-template
```

Continue only after the build succeeds. A failed build preserves the previous
template selection.

```sh
selection="$E2B_TEMPLATE_FILE"
build_tag="$(jq -er '.templateRef | split(":") | last' "$selection")"
proof_dir="$(mktemp -d)/proof"
vp env exec node infra/relay/scripts/e2b-runner-smoke.mjs \
  --receipt "infra/relay/.t3/e2b-builds/$build_tag.json" \
  --output "$proof_dir" \
  --workflow-isolation
jq -e '.architecture == "x86_64"' "$proof_dir/result.json"
```

Copy the selected `templateRef` and `buildId` from `$selection` to
`/etc/launchpad-relay/relay.env`. Copy the result of
`jq -c . "$proof_dir/workflow-models.json"` as the single-line proof.

```dotenv
E2B_API_URL=http://127.0.0.1:3000
E2B_SANDBOX_URL=http://127.0.0.1:3002
E2B_API_KEY=<E2B team key>
E2B_PUBLIC_RELAY_URL=https://relay-beta.example.com
E2B_HOST_ID=beta-amd64-1
E2B_HOST_ADDRESSES=<comma-separated public and private IPs of the Linux host>
E2B_MAX_RUNNING_VMS=1
E2B_TEMPLATE_REF=<templateRef>
E2B_TEMPLATE_BUILD_ID=<buildId>
E2B_WORKFLOW_MODEL_PROOF=<one-line JSON>
RELAY_THREAD_VM_PROVISIONING_ENABLED=true
RELAY_WORKFLOW_VM_EXECUTION_ENABLED=true

CLOUDFLARE_ACCOUNT_ID=<Cloudflare account ID>
CLOUDFLARE_API_TOKEN=<API token for managed VM endpoints>
RELAY_TUNNEL_ZONE_NAME=example.com
MANAGED_ENDPOINT_NAMESPACE=beta
```

The API token for managed endpoints needs Tunnel Edit, Zone Read, and DNS Edit.
The named relay tunnel keeps its own connector token. Restart the relay and
verify that it loaded the runner configuration. [Managed endpoint settings](../../infra/relay/.env.example)

```sh
sudo systemctl restart launchpad-relay
curl -fsS https://relay-beta.example.com/health |
  jq -e '.ok and .threadVmCapabilities.configured and .workflowVmCapabilities.execution'
```

## Connect the beta organization

Build the desktop installer from the same commit with
`T3CODE_RELAY_URL=https://relay-beta.example.com`,
`T3CODE_CLERK_PUBLISHABLE_KEY` set to the beta public key, and
`T3CODE_CLERK_JWT_TEMPLATE=t3-relay`. On Apple Silicon, use
`vp run dist:desktop:dmg:arm64` and set `T3CODE_DESKTOP_VERSION` to a beta version.
Leave update repository variables unset. A packaged beta shares the normal
desktop profile, so use a separate OS login if you already use packaged
Launchpad on that computer. [Desktop local builds](release.md#local-builds)

1. Sign in as the operator and open **Settings → Organization** to create the
   beta organization. Keep Clerk sign-in restricted to the operator while
   setting up integrations.
2. Configure one GitHub App limited to the test repository with Contents and
   Pull requests write. Set its post-install Setup URL to
   `https://relay-beta.example.com/v1/organization/github-app/installed` and
   leave user OAuth during installation off. In `relay.env`, set
   `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and `GITHUB_APP_PRIVATE_KEY` with the PEM
   on one line using literal `\n` escapes. Restart the relay. Use **Connect
   GitHub** in Organization settings to install or claim the App, then register
   the repository. [GitHub App setup URL](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#adding-or-updating-a-setup-url)
3. In desktop, connect the dedicated account under **Settings → Organization
   → Codex for VMs**. [Codex for VMs](../user/organizations.md#codex-for-vms)
4. If another teammate is reviewing the first run, invite them into the
   Launchpad organization before they sign in. Once they join, grant them a
   repository role that matches the workflow's Review setting.
   [Organization invitations](../user/organizations.md#inviting-people)

## Run one workflow from Linear to GitHub

Configure the Linear OAuth app and Issue webhook using the
[native Linear setup](connect-setup.md#native-linear-workflow-connections).
Get the Launchpad organization ID from the relay database.

```sh
sudo docker exec launchpad-relay-postgres psql -U launchpad_relay -d launchpad_relay \
  -c 'SELECT organization_id, name FROM relay_organizations ORDER BY created_at;'
```

1. Set `LINEAR_WORKFLOW_ORGANIZATION_ID` to that ID. Restart the relay with
   admission off. In **Settings → Organization → Workflow sources**, connect
   the workspace and grant access to the test repository. You can send a sample
   event while admission is off to check webhook delivery.
2. Set `LINEAR_WORKFLOW_ADMISSION_ENABLED=true` and restart the relay. Create a
   VM workflow with **Agent → Review → Push branch → Open PR**, then enable and
   save the Linear trigger. Create one matching Linear issue with a small,
   explicit change for the agent to make.
3. At Review, check the saved diff in desktop. Approve and confirm the run opens
   one PR on its `launchpad/<job-id>` branch. Record the Linear issue, workflow
   run, VM allocation, runner build ID, and PR. Match the allocation's build to
   the AMD64 smoke proof and the PR head to the workflow's published branch.

A completed VM can keep the single slot occupied. For a repeat test, preserve
the first run's evidence and clear its disposable fixture. If needed, set
`RELAY_THREAD_VM_PERMANENT_DELETE_ENABLED=true`, restart the relay, and use
**Delete thread permanently** for that fixture only. This removes its saved
results and workspace as well.

For a planned reboot, finish or safely pause the run and follow the
[E2B restart procedure](e2b-host-setup.md#stop-and-restart). For beta data you
want to keep, back up the Launchpad database on `5433`,
`/etc/launchpad-relay`, and `/var/lib/launchpad-relay` together.
