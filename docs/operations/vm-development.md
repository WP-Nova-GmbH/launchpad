# Set up VM support for development

This setup lets you move a local Codex thread into its own private VM. Run commands
from the repository root. The desktop app and relay run on your computer; E2B runs
the thread VMs on a Linux host.

## 1. Prepare the VM host once

Install the checkout's dependencies with `vp i`, then follow
[E2B host setup](e2b-host-setup.md#macos-development-only). On a Mac, this uses the
dedicated `launchpad-e2b` Lima VM. On Linux, use the native host instructions.
For a new installation, prepare the Linux host and
[build the supported patched runtime](e2b-host-setup.md#build-the-launchpad-runtime),
including its host safeguards. The optional
unmodified upstream checks are not required. Reuse an existing supported
installation if you already have one. Once the Linux host is running, start its
E2B services from the Launchpad checkout:

```sh
vp run start:vm-host
```

The command verifies and starts the existing installation at
`/var/lib/launchpad-e2b`, including the API, orchestrator and sandbox proxy. On a
Mac, that path is inside Lima; on Linux, it is on the native host. If your existing
installation is elsewhere, set `E2B_RUNTIME_DIR` in `infra/relay/.env` to its absolute
Linux path. Shell environment variables take precedence. Keep that installation
in place; the override selects it without moving or copying its files.

Startup downloads missing dependency images at the installation's pinned versions.
The locally built Launchpad runtime images must already exist; they are not rebuilt
or downloaded by this command.
The upstream `base-template` job is left to optional smoke tests; Launchpad builds
its own runner image in step 3.

The Linux host must already be running. This command does not create Lima VMs,
build images or start the relay. For a separate Linux machine, run it from a
Launchpad checkout on that machine.

## 2. Configure the relay once

Create `infra/relay/.env` from [the example](../../infra/relay/.env.example) if it
does not exist. Otherwise, edit the existing file. Set these values, replacing the
placeholders and `example.com` with your Cloudflare domain:

```dotenv
CLERK_PUBLISHABLE_KEY=<Clerk publishable key>
CLERK_SECRET_KEY=<Clerk secret key>
CLERK_JWT_AUDIENCE=t3-code-relay

CLOUDFLARE_API_TOKEN=<Cloudflare API token>
CLOUDFLARE_ACCOUNT_ID=<Cloudflare account ID>
RELAY_API_ZONE_NAME=example.com
RELAY_TUNNEL_ZONE_NAME=example.com
MANAGED_ENDPOINT_NAMESPACE=dev-alex

E2B_API_URL=http://127.0.0.1:3000
E2B_SANDBOX_URL=http://127.0.0.1:3002
E2B_API_KEY=<self-hosted E2B team key>
E2B_HOST_ID=local-lima
E2B_MAX_RUNNING_VMS=1
```

The loopback E2B URLs above assume Lima's forwarded ports. Use reachable management
URLs for a separate Linux host. Use the actual Cloudflare zone name, such as
`example.com`, rather than an undelegated subdomain. Choose your own development
namespace instead of `dev-alex`.

Get the Clerk keys from your Clerk application's API keys page. Get the E2B key
from your self-hosted installation using [these instructions](e2b-host-setup.md#retrieve-the-e2b-api-key).
On a new host, the first E2B startup generates its team credentials. Then complete
the guide's team restore, lifetime and capacity configuration and run
`vp run start:vm-host` again before starting Launchpad with VM support.
The Cloudflare API token needs tunnel editing for the account, and Zone Read plus
DNS Edit for the zone; the relay uses DNS editing for individual VM endpoints.

On macOS with the loopback E2B URLs above, `dev:vm` detects the existing
`launchpad-e2b` Lima host's IP addresses automatically. Leave `E2B_HOST_ADDRESSES`
unset or blank; any explicitly configured addresses are preserved. Detection
does not start or recreate Lima, and does not modify your `.env` file.

For native Linux or a separate host, set `E2B_HOST_ADDRESSES` to that host's IP
addresses, separated by commas. These addresses are blocked from VM outbound
access to protect the compute host.

## 3. Let startup build the runner image

The first `vp run dev:vm` builds and selects the runner image automatically if
none is selected. Later starts reuse it. Your Linux host and its E2B services
must already be running; the command does not start Lima or E2B.

Packaging uses one temporary Debian Bookworm container on the Linux host, with
Linux dependencies built from your current checkout. The container and temporary
build files are removed afterward. On macOS it uses `launchpad-e2b`; on native
Linux it uses the local Docker host.

With the local Lima URLs above, startup also prepares build memory automatically.
After packaging finishes, it temporarily reserves and verifies at least 12 GiB of
unreserved hugepage memory for E2B's image build, then restores the original pool
after success, failure or cancellation. It leaves the saved host configuration
unchanged. Other hosts need their build memory sized manually using the
[host setup instructions](e2b-host-setup.md#prepare-the-linux-host).

After changing Launchpad's server or runner tools, rebuild explicitly:

```sh
vp run build:vm-template
```

No archive paths, checksums or template IDs need to be copied. Restart `dev:vm`
after rebuilding. Failed builds preserve the previous image selection.

## 4. Prepare the relay database

With Docker running:

```sh
docker compose up -d --wait postgres
vp run --filter launchpad-relay db:migrate
```

Repeat migrations after pulling database schema changes.

## 5. Start the app

```sh
vp run dev:vm
```

The command checks configuration and prepares the runner image, then creates or
reuses the dedicated relay tunnel and its proxied CNAME automatically. With the
example above, the tunnel is `launchpad-relay-dev-alex` and its hostname is
`relay-dev-alex.example.com`. No dashboard setup is needed.

Existing DNS must already point to that tunnel; the command stops if it finds a
conflicting record instead of overwriting it. Once the route is ready, it starts
the relay, Cloudflare connector and desktop app with matching URLs.

## 6. Move a thread

Sign in to Launchpad Connect, open a local Codex thread, and choose
**Run on → Private VM**. If prompted, connect the local environment for thread moves.
The move uploads the repository, files and conversation. During preparation, choose
personal Codex sign-in or the organization's connected **Codex for VMs** account.
An admin connects that account from local desktop or web first; see
[Codex for VMs](../user/organizations.md#codex-for-vms).

## Updating Codex VM authentication

Apply the relay database migrations and deploy the updated relay before enabling the new guest
build. Build the runner with `vp run build:vm-template`, then restart `dev:vm` to select it.
For a deployed relay, set `E2B_TEMPLATE_REF` and `E2B_TEMPLATE_BUILD_ID` to the successful build's
immutable reference and build ID; these determine `settings.compute.templateId` for new allocations.
Confirm a newly created VM uses that build before choosing organization Codex.

Changing the selected template does not upgrade running VMs or saved snapshots. Older guests
cannot finish preparation with managed Codex until they support it. Keep personal sign-in for
those guests, or move the thread back to a machine and into a VM built from the new template.
Verify sign-in and concurrent work with a dedicated test account before enabling this for normal use.

## Later startups

Start your existing Linux host, then run from the Launchpad checkout:

```sh
vp run start:vm-host
docker compose up -d --wait postgres
vp run dev:vm
```

The image, tunnel and published hostname are reused. `Ctrl+C` stops the relay, connector
and desktop started by the command. It leaves the database, E2B host and thread
VMs running; stop those separately when finished.
