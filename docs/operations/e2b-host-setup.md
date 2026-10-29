# E2B host setup

Launchpad uses unmodified E2B Embed, built from the source revision in
[`stock-runtime.lock.json`](../../infra/e2b/stock-runtime.lock.json), with SDK 2.61.0.
It needs no E2B cloud account, LaunchDarkly account, or runtime patches. Launchpad's
runner image, guest workload gate and external snapshot collector remain separate
from E2B itself.

For everyday startup and moving a thread, use [VM development](vm-development.md).
This guide prepares the dedicated Linux compute host once. The relay and Launchpad
server can run elsewhere; each thread VM contains its own server and workspace.

## macOS development only

Skip this section on native Linux. Apple silicon needs M3 or newer, macOS 15 or
newer, and a current Lima. Create a **new** dedicated host; these commands do not
upgrade an existing installation:

```sh
brew install lima
limactl create --name=launchpad-e2b --tty=false --vm-type=vz --arch=aarch64 \
  --cpus=4 --memory=16 --disk=64 --nested-virt \
  --mount-none --containerd=none \
  --set='.portForwards = [
    {"guestPort":3000,"hostIP":"127.0.0.1","hostPort":3000},
    {"guestPort":3002,"hostIP":"127.0.0.1","hostPort":3002},
    {"guestPort":5008,"hostIP":"127.0.0.1","hostPort":5008},
    {"guestIP":"0.0.0.0","guestIPMustBeZero":false,"guestPortRange":[1,65535],"proto":"any","ignore":true}
  ]' template:ubuntu-24.04
limactl start launchpad-e2b --tty=false
limactl shell --workdir=/ launchpad-e2b
```

The final ignore rule prevents Lima from forwarding E2B's PostgreSQL port to the
Mac. Otherwise a database client could connect to E2B instead of another project's
database. Only API, sandbox proxy and template-upload ports are forwarded, on Mac
loopback. No Mac workspace directories are mounted into the host.

The 64 GiB virtual disk is a logical size, not a backup budget. Images, snapshot
layers and build caches consume real Mac storage as they grow. Use
[snapshot collection](e2b-snapshot-cleanup.md) and monitor both host and Mac free space.
A VM's whole-host disk is separate from its thread guests' disks.

Copy the setup scripts and firewall files from `infra/e2b/` into this host, or use
a checkout inside Linux. With no shared mounts, files on the Mac are not implicitly
available inside Lima. `limactl copy` transfers individual files. Do not copy `.env`,
credentials, build caches or VM state with the source.

## Prepare the Linux host

Use a fresh, dedicated Linux host with KVM, a 4 KiB-page kernel, glibc 2.36 or newer,
Docker and Python 3.12+. ARM64 additionally requires kernel 6.10 or newer. The pinned
[Embed requirements](https://github.com/e2b-dev/runtime/blob/518278060a154124a80d98f37253f8af77baf478/embed/compose/README.md#requirements)
are the reference for the native host dependencies.

On Ubuntu 24.04:

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx \
  curl ca-certificates git rsync iptables nftables e2fsprogs iproute2 python3 \
  linux-image-virtual-hwe-24.04
sudo systemctl enable --now docker
```

Reboot after installing the kernel. For Lima, leave its shell and run
`limactl stop launchpad-e2b`, then `limactl start launchpad-e2b` from the Mac.
Inside Linux, verify `uname -r`, `getconf PAGE_SIZE` and `/dev/kvm` before continuing.

The measured serving minimum is 12 GiB RAM. Use 16 GiB or more for development
packaging and extra guests. Generated configuration reserves 8 GiB as 4096 native
2 MiB hugepages, leaving ordinary memory for Docker and host services. A 4 GiB runner
restore can overlap a snapshot upload; an image build also needs this headroom.
Runtime capacity and storage retention are separate limits.

## Build the Launchpad runtime

Run this **inside the fresh Linux host**, from the directory containing this
checkout's `infra/e2b` files:

```sh
sudo python3 infra/e2b/build-stock-runtime.py /var/lib/launchpad-e2b --arch arm64
```

Use `amd64` on x86 Linux. The builder verifies the source archive checksum, builds
the native API, database migrator, client proxy, dashboard API, tools and SDK helper
images, and exports the native orchestrator binary. It writes `build.json`, immutable
image IDs, artifact checksums and a generated Compose configuration. It starts no
services and refuses an existing output directory.

Keep the generated directory in place: its Compose files bind the verified artifacts.
The default is `/var/lib/launchpad-e2b`. For another location, set `E2B_RUNTIME_DIR`
in the relay's `.env` to that absolute **Linux** path. Choosing another directory
does not migrate existing E2B host storage.

Install the guest firewall before starting the runtime, still inside Linux:

```sh
sudo install -d -m 0755 /etc/launchpad /usr/local/libexec
sudo install -o root -g root -m 0644 infra/e2b/host-firewall.nft /etc/launchpad/host-firewall.nft
sudo install -o root -g root -m 0755 infra/e2b/host-firewall.py /usr/local/libexec/launchpad-host-firewall
sudo install -o root -g root -m 0644 infra/e2b/launchpad-thread-vm-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now launchpad-thread-vm-firewall.service
```

The policy targets native `e2b-*` interfaces and blocks guest access to the compute
host and peer guests. These rules belong inside the dedicated Linux host, including
when it runs in Lima. They do not change the Mac firewall.

Perform first-time native host setup with all E2B writers stopped:

```sh
cd /var/lib/launchpad-e2b
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml run --rm preflight
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml run --rm host-setup
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml run --rm fetch-artifacts
```

Setup and artifact installation take the same host lock as snapshot maintenance.
They refuse another deployment's owner record, existing unowned storage, active
native E2B processes or populated cgroups. Missing dependency artifacts use upstream
checksum verification; the orchestrator comes from the verified source build.
Retry the same deployment after an interrupted setup. Generic host teardown is
disabled because it could remove shared host data.

Then run from the Launchpad checkout on the Mac, or on the native Linux host:

```sh
vp run start:vm-host
```

Startup verifies the receipt, immutable images, native launcher, installed owner and
orchestrator, and current guest firewall. When this deployment is stopped, it restores
native host prerequisites before taking the snapshot-maintenance lock and rechecking
the deployment. It starts the seed, configures its project limits before the first
API start, then starts the native API, orchestrator, dashboard API and sandbox proxy.
Existing correctly configured limits are preserved on restart.
It does not build images, create Lima, start the Launchpad relay or run a keepalive
sidecar. A legacy patched installation is refused rather than silently replaced.

The stock project uses 32 GiB of initial runner build disk and a 30-day continuous
VM limit. The one-time `configure-project.py` helper supports `--max-length-hours`
from 1 to 8760 if another hard cap is required. Changing these limits requires
stopped APIs and a project with no templates; the API caches project limits. Renewing
a lease cannot extend a VM beyond that hard cap. Launchpad's inactivity timers
remain independent.

## Retrieve the E2B API key

The first seed generates a team API key in this deployment's `seed-state` volume.
No E2B cloud account is needed. Inside the Linux runtime directory:

```sh
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml \
  exec -T api cat /run/e2b/team-api-key
```

Copy the value into `E2B_API_KEY` in `infra/relay/.env` and keep it out of Git and
logs. Use `E2B_API_URL=http://127.0.0.1:3000` and
`E2B_SANDBOX_URL=http://127.0.0.1:3002` for the local Lima port forwards. A separate
Linux host needs URLs reachable from the relay.

Use a distinct `E2B_HOST_ID` for a new deployment. `E2B_MAX_RUNNING_VMS` limits
simultaneous starts on that host; the organization's VM policy separately limits
how many thread allocations each user may retain. Set host capacity according to
available RAM rather than increasing it to bypass a failed start.

## Build the Launchpad runner template

From the Launchpad checkout:

```sh
vp run build:vm-template
```

`dev:vm` builds automatically when no image is selected and reuses that selection
on later starts. Rebuild after changing the server or guest tools. Linux packaging
uses one disposable Debian Bookworm container; it transfers source through an
allowlist and removes the container and its temporary files afterward.

The runner includes the packaged server and web client, native dependencies,
resource monitor, Git, GitHub CLI, Python, Node, pnpm and Codex. Tool versions and
checksums live in [`template/install.sh`](../../infra/e2b/template/install.sh).
The guest receives the release archive rather than the Launchpad monorepo.
The standard runner has 2 vCPUs and 4 GiB RAM. Native project disk configuration
provides space before installation; the guest smoke check requires at least 20 GiB
usable afterward. It does not depend on E2B's flag-gated post-install disk growth.

For an existing Linux ARM64 release archive, the lower-level builder is:

```sh
node infra/relay/scripts/e2b-build-template.mjs \
  --server-archive /absolute/server-linux-arm64.tar.gz \
  --server-sha256 <archive-sha256>
```

The selected immutable tag and build are saved in `infra/relay/.t3/e2b-template.json`.
Restart the relay to load a successful new selection. Already created VMs retain
their own image; queued fresh starts use the current selection. Failed builds retain
the previous selection. When builder and relay run separately, copy this selection
file to the relay and set `E2B_TEMPLATE_FILE` to its absolute path.

For relay authentication, database migrations, Cloudflare and app startup, continue
with [VM development](vm-development.md). The E2B management API and proxy must stay
private; the authenticated relay is the clients' entry point.

## Snapshots, backups and restore

A snapshot is a candidate native full disk-and-RAM capture. Launchpad accepts it
as a backup only after native completion matches its immutable build and the exact
closed source checkpoint has been independently published with conversation history
and attachments. Scheduled backups wait for idle work rather than interrupting an
active turn; their interval is a due time, not a maximum recovery-point age.

A managed pause first saves that checkpoint and backup, then pauses the same VM.
A paused final save reuses that exact backup without waking the source. A native
hard-timeout pause alone proves neither a safe checkpoint nor a usable backup.
Explicit resume reserves capacity and refreshes private routing before opening
managed work.

Restoring a deleted VM preserves its saved disk. Native E2B boots immediately, so
Launchpad commits placement before creation, stops the captured old coordinator
through the trusted guest bootstrap, rotates its serving identity, imports the
conversation, and opens the gate only after relay activation. Reset VM instead
rebuilds from the Git commit uploaded during the move and discards workspace changes.

A lost create, pause, connect or snapshot reply does not authorize another request
or release its slot. Native catalog reconciliation can resolve known identities;
missing state alone cannot prove an old request will never arrive. Unresolved
outcomes retain their durable hold for operator investigation.

Logical retention removes native snapshot catalog roots. The external
[collector](e2b-snapshot-cleanup.md) reclaims unused physical disk and RAM layers
during idle-host windows. Keep its deployment receipt and configuration together.

## Existing patched deployments

There is no automatic in-place conversion. Keep the original host, its disks,
Compose files, old release and relay database available while moving actual work
through the old version. Stop the old VM workers before applying relay migrations;
do not run old and new worker versions against the same database. Keep a preserved
old deployment/database separately if it is needed for export. Old snapshots lack the new coordinator/bootstrap proof
and are not native restore sources. Existing allocations remain marked as using the
previous runtime; new workers refuse to resume or clean them up. They preserve
historical receipts and never fabricate a native completion or delete those roots
as routine retention.

Take a consistent relay database backup before migration. The inventory command
expects the current catalog schema, so apply migrations to the stopped deployment
or a separate database copy before using it.

The operator inventory command writes IDs and phases to a private file, omitting
receipt payloads, credentials and conversation contents:

```sh
E2B_MIGRATION_RELAY_DATABASE_URL=<explicit-relay-dsn> \
  vp run --filter launchpad-relay vm:migration inventory <old-host-id> /private/path/inventory.json
```

Stop and drain the old relay's VM workers and its host collector before adding
preservation pins. Use a new output path and a migration-specific pin name:

```sh
E2B_MIGRATION_RELAY_DATABASE_URL=<explicit-relay-dsn> \
  vp run --filter launchpad-relay vm:migration protect <old-host-id> e2b-migration-stock /private/path/protected.json --workers-stopped
```

Unfinished operations block protection until reconciled using their original runtime.
Protection pins preserve catalog roots; they do not convert a snapshot, prove host
quiescence, protect against disk loss, or make stock E2B compatible with an old image.
Preserve the original host storage separately and prepare stock E2B on a fresh host
with a new host ID. Export actual work through the old deployment before retiring it.
Releasing the named migration pins removes that additional preservation hold.
Legacy roots still require explicit retirement through their original runtime or an
operator procedure; native expiry remains disabled for them. Release pins only
after the work and required backups have been preserved.

## Restore release gate

Before enabling a deployment for shared use, verify the installed native runtime,
runner and firewall together. Cover private HTTP/WebSocket ingress, exact source
sealing, native full snapshot completion, deletion and restoration of files and
SQLite data, real coordinator shutdown and identity rotation, and resumption only
after import and activation. Include lost replies, claim expiry, revoked access,
capacity limits, reset, and cancellation. Test physical collection followed by the
first restore of a retained snapshot. A passing unit suite or a template build
alone is insufficient evidence for that boundary.

## Private application previews

Previews require their own cookie-free registrable domain and wildcard DNS/TLS to
the relay. Set `RELAY_THREAD_VM_PREVIEW_BASE_URL`, `RELAY_THREAD_VM_APP_ORIGINS` and
`RELAY_THREAD_VM_AUTH_ORIGINS`; leave previews unset when unused. The relay refuses
shared or unknown cookie boundaries.

The guest authenticates native private ingress and a short-lived relay-signed
preview grant on port 3773. It removes routing credentials before forwarding HTTP
or WebSocket traffic to the selected application port. Application pages must not
receive compute credentials. Opening a preview never resumes paused compute;
placement and access changes revoke its sessions.

## Stop and restart

`Ctrl+C` in `dev:vm` stops its app, relay and connector, leaving the host and VMs
alone. Before shutting down or rebooting the compute host, finish or safely pause
its work, then stop this deployment's services from its Linux runtime directory:

```sh
cd /var/lib/launchpad-e2b
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml stop
```

On the Mac, run `limactl stop launchpad-e2b`. Restart with
`limactl start launchpad-e2b`, then `vp run start:vm-host` from the checkout. On native
Linux, run the same verified launcher after reboot. Explicitly stopped services stay
off until the launcher restores kernel prerequisites and starts them in order.

After an unclean shutdown, Docker may have restarted the orchestrator before host
setup. If the launcher reports missing kernel prerequisites, it refuses to change
them under running services. Safely pause or recover the existing work, explicitly
stop this deployment's services as above, then retry the launcher. Do not run generic
Docker volume cleanup or host teardown against a preserved deployment.

If setup or startup reports interrupted snapshot maintenance, first run the
[collector's recovery](e2b-snapshot-cleanup.md#preview-and-collect) with its original
configuration. Keep the recorded containers and maintenance receipt intact; generic
startup must not replace containers that cleanup still needs to recover.
