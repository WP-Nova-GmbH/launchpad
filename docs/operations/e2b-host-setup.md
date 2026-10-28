# E2B host setup

The target compute machine runs Linux natively. On macOS, Lima supplies that Linux
machine for development. Both follow the same host setup below. The Launchpad app
and relay can run separately from the compute host.

Launchpad VM support uses the pinned E2B runtime with the full Launchpad patch set.
Prepare the Linux host, then [build the Launchpad runtime](#build-the-launchpad-runtime).
The upstream smoke checks and unmodified baseline below are optional maintainer
checks, not prerequisites for normal setup. Deployment-specific recovery and
lifetime proofs remain required before using automatic lifecycle cleanup.

## Start desktop with VM support

Follow the short [VM development guide](vm-development.md) to configure the relay,
build a runner image, start the relay tunnel and move a local thread. The
host preparation and image build requirements are detailed below.

## macOS development only

Skip this section on native Linux. For the local ARM64 setup, use Apple M3 or newer
with macOS 15 or newer and a current [Lima installation](https://lima-vm.io/docs/installation/).
Create the dedicated host once with an explicit port allowlist, then start it:

```sh
brew install lima
limactl create --name=launchpad-e2b --tty=false --vm-type=vz --arch=aarch64 \
  --cpus=8 --memory=24 --disk=160 --nested-virt \
  --mount-none --containerd=none \
  --set='.portForwards = [
    {"guestPort":3000,"hostIP":"127.0.0.1","hostPort":3000},
    {"guestPort":3002,"hostIP":"127.0.0.1","hostPort":3002},
    {"guestPort":5008,"hostIP":"127.0.0.1","hostPort":5008},
    {"guestIP":"0.0.0.0","guestIPMustBeZero":false,"guestPortRange":[1,65535],"proto":"any","ignore":true}
  ]' template:ubuntu-24.04
limactl start launchpad-e2b --tty=false
```

Lima otherwise forwards guest ports automatically, including PostgreSQL on 5432.
That can send a Mac database client to E2B's database instead of another project's
database. Keep the final ignore rule after the allowed ports: Lima uses the first
matching rule. The allowlist exposes only the API (3000), private sandbox proxy
(3002), and template uploads (5008), all on Mac loopback. Lima manages its SSH
connection separately. Add port 3001 explicitly only if you need the E2B dashboard.
For an existing host, safely stop its workloads and Lima, then apply the same
`portForwards` rules with
`limactl edit launchpad-e2b` before starting it again. Check local listeners with
`lsof -nP -iTCP -sTCP:LISTEN` and confirm only the intended service ports are forwarded.

These are starting resources for the outer host and one sandbox, not a validated
capacity limit. The host has its own disk; Mac directories are not shared into it.
See the [Lima command reference](https://lima-vm.io/docs/reference/limactl_start/).

Runtime builds and retained snapshot layers need space in addition to each guest's
usable disk. To enlarge an existing development host, first finish or safely stop
its guest workloads, then run `limactl stop launchpad-e2b`,
`limactl edit launchpad-e2b --disk=160 --tty=false`, and
`limactl start launchpad-e2b --tty=false`. Check the root filesystem with `df -h /`
inside Linux afterward. Expanding the disk avoids discarding retained snapshots;
see [Lima disk resizing](https://lima-vm.io/docs/config/disk/).

Before recovery tests, leave room for a complete reconstructed guest disk as well
as retained snapshots and build caches. A small snapshot diff can expand to the
full logical disk during preparation. The 120 GiB development host filled during
this check; 160 GiB is a starting size, not a retention or VM capacity guarantee.
Do not delete saved disks to make a recovery test pass.

Enter the Linux host to run the remaining commands:

```sh
limactl shell --workdir=/ launchpad-e2b
```

Use `limactl stop launchpad-e2b` and `limactl start launchpad-e2b` from macOS for
later shutdowns and startups. Exiting the Linux shell leaves the VM running.

## Prepare the Linux host

Use a dedicated Ubuntu 24.04 host with working KVM. Check the
[upstream prerequisites](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md#requirements)
for the E2B revision you intend to run. ARM64 snapshot restore requires kernel
6.10 or newer and 4 KiB pages. On ARM64 Ubuntu 24.04, install the HWE kernel:

```sh
sudo apt-get update
sudo apt-get install -y linux-generic-hwe-24.04
```

Reboot the host before continuing. For Lima, exit the guest and run
`limactl restart launchpad-e2b` on macOS, then enter the guest again.

Install the host dependencies inside Linux:

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx \
  curl ca-certificates git iptables nftables rsync e2fsprogs iproute2 python3-venv
sudo systemctl enable --now docker
```

Verify the host before starting E2B:

```sh
uname -r
uname -m
getconf PAGE_SIZE
ls -l /dev/kvm /dev/net/tun
sudo docker version
sudo docker compose version
```

Expect `4096` for page size, both devices, Docker Engine 27+ and Compose 2.24+.
Check upstream resource requirements when sizing sandbox memory reservations.
The 4 GiB Launchpad template needs at least 12 GiB of unreserved hugepage memory
while building: snapshot exports can outlive one step while the next restores its
VM. A 6 GiB pool failed with `mmap memfd: cannot allocate memory` despite free
ordinary RAM. On macOS with both E2B URLs forwarded through loopback,
`dev:vm` and `build:vm-template` temporarily grow and verify the existing
`launchpad-e2b` Lima pool after Linux packaging finishes. They restore the original
pool after build success, failure or cancellation, without changing the saved
E2B Compose configuration.

For other hosts, size build memory manually. On an idle host, `HUGEPAGES=6144`
requests 12 GiB in 2 MiB pages; allow more for concurrent builds and running
sandboxes, while leaving ordinary RAM for host services. Verify the actual
reservation with `grep Huge /proc/meminfo`; a requested pool is not proof it was
allocated. If an idle host cannot allocate the pool, reserve it at boot before
starting Docker. Increasing it on a running host can fail because memory is
fragmented, even after compaction.

The build pool and running capacity are separate checks. Restore the serving pool
after manual builds, or give the host more RAM before configuring concurrent VM
and recovery capacity. Do not lower the capacity check to make admission pass.
The development host uses 24 GiB with a 6 GiB serving pool. After changing host
resources, check the retained VM catalog, firewall, protected cgroups and service
health before admitting work. Keep service connection ports in the saved Compose
configuration; temporary forwarding processes do not survive host restart.

## Optional upstream smoke checks for maintainers

For Launchpad VM support, skip these checks and
[build the patched runtime](#build-the-launchpad-runtime). This section exercises
the upstream stack independently; it does not prepare the Launchpad installation.

Use E2B's own Compose deployment in a directory outside the Launchpad checkout.
It configures the Linux host's kernel modules, network and storage, so it belongs
on the dedicated compute host. It is separate from Launchpad's root
`docker-compose.yaml`, which starts the relay's development PostgreSQL database.

Download `compose.yaml` and `.env` from the **same reviewed E2B commit** using the
[upstream install guide](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md#install).
The initial development checks use commit
`1599d6e79e302449e9285dae33d5ce04e3182254` and the prebuilt images selected by its
Compose defaults, with the E2B JavaScript SDK pinned to `2.46.1`. The Compose commit
does not identify the source revision of each prebuilt service. Image and binary
checksums are recorded in `infra/e2b/runtime.lock.json`; the prebuilt services
do not expose enough provenance to confirm all their source revisions.
This is a tested development baseline, **not a validated recovery configuration**.
From the directory containing those files, run:

```sh
sudo docker compose up -d --wait
sudo docker compose --profile test run --rm smoke
```

The upstream smoke test proves sandbox creation, command execution and port access.
Separately verify pause/resume preserves a test file before integrating Launchpad.
For dashboard access and SDK configuration, follow upstream
[Try it](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md#try-it)
and [Ports](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md#ports).
Keep Lima's explicit port allowlist in place when connecting Mac clients. The
template upload endpoint returns a URL on port 5008, so that forward is required
for builds that copy the runner archive.

## Retrieve the E2B API key

The first startup generates a team API key for this self-hosted installation;
no E2B cloud account is needed. E2B stores it in the `seed-state` Docker volume
as `/run/e2b/team-api-key` inside containers that mount that volume.

On macOS, enter the dedicated Linux host first:

```sh
limactl shell --workdir=/ launchpad-e2b
```

Change to the existing E2B installation's Compose directory. For the standard
upstream stack, read the `E2B_API_KEY` export from:

```sh
sudo docker compose logs ready
```

The Launchpad runtime started in [Build the Launchpad runtime](#build-the-launchpad-runtime)
does not start `ready`. Read the same key through its running `launchpad-keepalive`
service instead, using the same Compose files and project name used at startup:

```sh
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml \
  exec -T launchpad-keepalive cat /run/e2b/team-api-key
```

Copy the key value into `E2B_API_KEY` in `infra/relay/.env`. The template build
command loads that file automatically; existing shell variables take precedence.
Keep the key out of Git.
See upstream [Secrets](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md#secrets)
for key storage and rotation.

## Build the Launchpad runner template

The runner uses a packaged Linux ARM64 CLI archive, including its web client,
native runtime dependencies and resource monitor. The development command builds
that archive from the current checkout in one temporary Debian Bookworm container
on the running Linux host. On macOS it uses the dedicated `launchpad-e2b` Lima
host; on native Linux it uses local Docker. It does not start Lima or E2B, and
removes its container and temporary build files afterward. The thread VM receives
the packaged server, not the Launchpad monorepo.
`infra/e2b/template/Dockerfile` adds Git, GitHub CLI, Python, Node, pnpm and Codex.
Conversation moves validate the saved history and require the destination Codex
to resume it successfully; the source and destination versions do not have to match.
Those development tools are separate from the server's bundled dependencies. The build script
selects the standard resources: 2 vCPUs,
4 GiB RAM and 20 GiB initially free disk. The image requests 21 GiB from E2B because
its ext4 growth is best-effort and filesystem metadata consumes some of the added
space. The runner smoke check requires at least 20 GiB available to its non-root user. Install this checkout's dependencies
before building: its pinned E2B SDK patch forwards the runtime's `minFreeDiskMb`
option. An unpatched 2.46.1 SDK silently drops that setting. The compute host
also requires `BUILD_ENSURE_FREE_DISK_SPACE=true` from the supplied Compose
override: upstream leaves this build phase disabled without LaunchDarkly. The guest smoke test
checks the resulting resources; the requested disk target is not a total-disk cap.

Set `E2B_API_URL`, `E2B_SANDBOX_URL` and `E2B_API_KEY` in `infra/relay/.env`, then run from the
Launchpad checkout to package the current code and build a new runner image:

```sh
vp run build:vm-template
```

`vp run dev:vm` does this automatically when no image is selected, and reuses
the selection on later starts. Use `build:vm-template` explicitly after changing
the server or runner tools. For an existing packaged archive, the lower-level
builder remains available:

```sh
node infra/relay/scripts/e2b-build-template.mjs \
  --server-archive /absolute/path/to/linux-arm64-release.tar.gz \
  --server-sha256 <archive-sha256>
```

The command uses the Dockerfile's pinned tools and saves the selected image to
`infra/relay/.t3/e2b-template.json`. The Node dev relay reads that file at startup,
including the exact build identity; no template IDs need to be copied into `.env`.
Restart the relay after a successful build to use the new selection. Failed
builds preserve the previous selection. Detailed build receipts are kept in
`infra/relay/.t3/e2b-builds`; the lower-level builder accepts `--output` to choose
a new receipt path instead.
For deployments outside the dev runner, update the relay's configured compute template selection
(`settings.compute.templateId`) to the new version and verify the next allocation uses that build.
Existing VMs keep their installed executable; move a thread back to a machine and into a new VM
to pick up updated Git setup. Rebuilding alone does not update running or paused VMs.
When the builder and relay run on separate machines, copy the selection file to
the relay and set `E2B_TEMPLATE_FILE` to its absolute path on both machines.
An existing successful build receipt can also be used as `E2B_TEMPLATE_FILE`
without rebuilding. The selection must belong to the relay's configured `E2B_API_URL`.

Automatic packaging compiles Linux `node-pty` for ARM64 and checks the packaged
server before using it. Prebuilt archives must also contain a matching Linux
native module; Mac and Windows prebuilds cannot run in the guest. The runner
smoke test must still load the module and open a real terminal.

The E2B team's build-time disk allowance must also fit the runner. The seeded
512 MiB allowance is too small: use at least 4096 MiB for `disk_mb` and 2048 MiB
for `default_free_disk_size_mb` in this development setup. These are E2B team
limits, separate from Launchpad's per-user VM count. On the pinned runtime, an
operator can apply an override to the one team used by the relay, copying its
other current limits. Replace `YOUR-E2B-TEAM-ID` before running this against the
E2B database:

```sql
INSERT INTO public.project_limits (
  team_id, max_length_hours, concurrent_sandboxes, concurrent_template_builds,
  max_vcpu, max_ram_mb, disk_mb, events_ttl_days, default_free_disk_size_mb,
  max_disk_size_mb, max_free_disk_size_mb, api_team_rps_list
)
SELECT id, max_length_hours, concurrent_sandboxes, concurrent_template_builds,
  max_vcpu, max_ram_mb, 4096, events_ttl_days, 2048,
  max_disk_size_mb, max_free_disk_size_mb, api_team_rps_list
FROM public.team_limits WHERE id = 'YOUR-E2B-TEAM-ID'::uuid
ON CONFLICT (team_id) DO UPDATE SET
  disk_mb = 4096, default_free_disk_size_mb = 2048, updated_at = now();
```

Check the effective values in `public.team_limits` before building. The standard
21 GiB E2B growth target also needs `max_free_disk_size_mb >= 21504` and enough
`max_disk_size_mb` for the tools plus that free space (at least 25600 MiB). Allocate
additional host storage for build caches, saved disks, and actual project data.

The E2B template upload stages only the verified archive and its checksum. It does not copy local
provider profiles, checkout files or credentials. The receipt records the template
and build IDs and a unique `templateRef` tag on success. Keep that tag assigned to
its recorded build; the relay verifies it before provisioning. Inspect the same
named template after a failed or
interrupted build before retrying. Use the lower-level builder's `--skip-cache` when rebuilding after a
failed snapshot or a host disk-full incident; a new receipt is still required.
OS package repositories remain live even though
the base image, Node download, Codex and pnpm versions are pinned.

The template intentionally does not auto-start the server. The provisioning worker
must install thread-scoped enrollment/import state and establish execution ownership
before starting `launchpad-server`. Building a template alone does not satisfy those
gates or enable VM mode in the app. Verify the resulting guest before enabling
relay provisioning. From a checkout with relay dependencies
installed, run the opt-in smoke test on the trusted build host:

```sh
E2B_API_URL=http://127.0.0.1:3000 E2B_SANDBOX_URL=http://127.0.0.1:3002 \
E2B_API_KEY_FILE=/path/to/host-team-key \
node infra/relay/scripts/e2b-runner-smoke.mjs \
  --receipt /path/to/template-build.json --output /path/to/new-proof-directory
```

It verifies the recorded build tag, starts one disposable private VM, and checks
tool versions, a native PTY, resource monitoring, database creation and the bundled
web client after server readiness. It records resource identities before testing
and removes tagged test allocations afterward. Inspect the cleanup receipt after
an interrupted run. API absence in this test is not proof of physical shutdown,
and this test does not exercise provider authentication or thread enrollment.

## Relay provisioning during integration testing

Provisioning is opt-in. Start a local thread using the default Codex provider and queue a move
to a private VM.
The move uploads its repository, working files and conversation; the VM does not
clone the repository or require a GitHub App installation. Reset VM checks out the
original uploaded commit, retains the conversation and leaves the prompt queue paused.
The template contains no provider login credentials. When preparation needs Codex
sign-in, complete the sign-in step shown in the thread; preparation continues before
the VM becomes its active environment. After reset, explicitly resume the paused
prompt queue. Setup waits for the repository's setup
script even when that script normally runs asynchronously. Failed or uncertain setup
keeps execution blocked.

After preparation, the relay requests a private server start. A guest process lock
prevents duplicate servers after a lost response; reconciliation does not resume paused
VMs. The server listens on guest loopback and keeps execution blocked until the relay
confirms import and setup. Each VM uses its own
Launchpad Connect managed tunnel for client connections. Configure the relay's
Cloudflare managed endpoints before testing this path; the guest receives only its
own connector token, while the Cloudflare API token stays on the relay. The runner
image includes a pinned `cloudflared`, so startup does not download a connector.
Rebuild the runner template before testing upload and reset; older builds use remote
checkout setup. The complete live connection path still needs verification. Do not
enable this as a user-facing feature yet. After applying relay migrations and verifying the host and
template, set these in the relay's protected environment configuration:

```dotenv
RELAY_THREAD_VM_PROVISIONING_ENABLED=true
E2B_HOST_ID=primary-linux
E2B_MAX_RUNNING_VMS=1
E2B_API_URL=http://127.0.0.1:3000
E2B_SANDBOX_URL=http://127.0.0.1:3002
E2B_API_KEY=<host-team-key>
E2B_HOST_ADDRESSES=<host IPv4 and IPv6 addresses, comma separated>
E2B_PUBLIC_RELAY_URL=https://<isolated-test-relay-hostname>
```

The Node dev relay uses the selection file saved by `build:vm-template`.
Existing Cloudflare Worker deployments continue to support their explicit
`E2B_TEMPLATE_REF` and `E2B_TEMPLATE_BUILD_ID` configuration.

The loopback compute URLs above apply when the relay runs on the compute host.
Elsewhere, use a trusted management route; do not publish E2B control ports for
this purpose. Guests need the separate public HTTPS relay route because they
cannot reach the private management network. The relay issuer must match the
issuer that its enrollment API uses. Keep the management key outside guests.

Choose the running limit from the host's reserved guest memory and CPU budget,
leaving room for E2B services and restore verification. This is a host limit for
the standard template, independent of users' VM quotas. Reservations survive
worker crashes and uncertain creation. A confirmed pause releases running
capacity while preserving the user's allocation slot; resume queues a new
reservation. Lowering the host limit holds new requests without evicting VMs.
Queued creations use the image selected when creation starts, including after a
rebuild and relay restart. Existing VMs keep their original image.

Automatic pause, backup, inactivity deletion, and quota replacement remain disabled by default.
Keep `RELAY_THREAD_VM_AUTO_PAUSE_ENABLED`, `RELAY_THREAD_VM_AUTO_BACKUP_ENABLED`,
`RELAY_THREAD_VM_AUTO_DELETE_ENABLED`, and `RELAY_THREAD_VM_REPLACEMENT_ENABLED` unset until their real recovery and
wake tests pass on this deployment. Deletion and replacement additionally require backups to be
enabled; it only reserves a source drain, and a verified final disk save plus
independent conversation recovery must still succeed before compute is removed.
Policy edits recompute idle deadlines; ordinary history reads do not renew them.

Restore, reset and permanent thread deletion have separate opt-ins:
`RELAY_THREAD_VM_RESTORE_ENABLED`, `RELAY_THREAD_VM_RESET_ENABLED` and
`RELAY_THREAD_VM_PERMANENT_DELETE_ENABLED`. Enable them only in the disposable
integration deployment until that deployment has passed cold restore, expired-disk
reset with explicit queue resume, and physical deletion/retention checks. A passing
native portability script alone does not verify these product flows.

VM controls are visible in web, desktop and mobile clients without a build flag.
The Private VM option is disabled with "VM host not configured" until the relay
has a VM host configured.
Complete an authenticated local-to-VM-to-local move through the relay and verify
saved history, attachments, queue order and private previews on all three clients
before enabling these lifecycle switches. Keep existing enrolled threads coordinated during
rollback: disabling new provisioning does not return execution ownership to an old
computer. Reconcile admitted operations and physical-stop receipts before changing
the runtime or its storage.

The Node relay reconciles pending provisioning continuously. The Cloudflare relay
uses its scheduled handler and needs a trusted route to the same compute API.
Both reject a changed template build or an incompatible runtime. With the switch
off, neither schedules provisioning nor requires these settings. Use a disposable
relay database for integration tests; enabling this switch against existing
pending records allows those records to be processed.

## Build the Launchpad runtime

`infra/e2b/build-runtime.py` builds the API, client proxy, database migrator and
orchestrator from the source archive in `runtime.lock.json`. The proxy must use
the same revision: older Embed proxy images read the legacy API routing record,
which expires even while a renewable VM and its host-owned route remain alive. It checks the archive
and Compose checksums, pins Docker base images, and records the resulting image
IDs and binary checksums in `build.json`. With patch `0016`, it also builds the
host-only disk collector. Package-manager repositories used inside
upstream Dockerfiles are still live: this pins the source and base images, not a
byte-for-byte reproducible OS package build.

Copy the builder, lock file, `infra/e2b/verify-runtime.py`, and
`infra/e2b/compose.override.yaml` into the dedicated Linux host. Copy
`infra/e2b/build-collector.Dockerfile` beside the builder for patched builds. Copy
`infra/relay/scripts/e2b-keepalive.ts` beside the builder as
`e2b-keepalive.ts`. The builder copies both host safeguards into its output
directory and records their checksums. Run with Python 3.12+, Docker
and Buildx installed. The current lock covers **Linux ARM64**; another architecture
needs its own verified image and binary pins. Use the complete patched build
command below; the output directory must be new.

An optional `--archive /path/to/runtime-source.tar.gz` reuses a local download;
the checksum is still required. The script builds only: it does not start services
or replace the installed orchestrator. Keep the output directory, since the
host launcher uses its compiled binary directly.

`/var/lib/launchpad-e2b` is the default installation directory for
`vp run start:vm-host`. On macOS, this directory is inside the dedicated Lima VM.
For an existing installation elsewhere, set `E2B_RUNTIME_DIR` in
`infra/relay/.env` to its absolute Linux path; shell environment variables take
precedence. Keep its current directory and storage in place. From the Launchpad
checkout on your Mac or native Linux host, `vp run start:vm-host` verifies and
starts the generated deployment using all three Compose files. It requires the
Linux host to be running already.

Before starting the selected runtime, first stop any other E2B stack on this dedicated host.
E2B uses host ports, network devices and KVM resources, so separate Compose project
names do not make concurrent installations safe. Install the host safeguards
below before starting it. The first startup generates the installation's team
credentials; configure that team's restore, lifetime and capacity settings after
startup and before moving Launchpad threads.

Pass every Compose override to the verifier in its actual launch order. It checks
the Compose project name, merged API/proxy/migrator image pins, and host orchestrator command and
binary checksum. Generated runtime configuration and the Launchpad override also
bound each service’s Docker logs to three 10 MiB files. Recreate existing
containers to apply those limits; restarting them alone keeps their old logging
configuration. A later override can otherwise keep launching an older binary
even when the API image has been updated.

When upgrading an existing deployment, preserve its storage overrides and pass
its existing `--project-name` to both the verifier and Compose. A newly generated
project name starts a separate stack and does not reuse the existing database.

The override assigns a stable `launchpad-e2b-proof-<hash>` Compose project to each
resolved build directory and records it in `build.json`. Each build has its own
database volumes and disk storage, so switching builds keeps their template
records and files together. Keep `SANDBOX_DIR` identical between template
building and serving: Firecracker memory snapshots embed the root disk's absolute
path. A different value can refuse VM creation even when the immutable disk layers
are present. For isolated storage proofs, separate Postgres, template storage and
`ORCHESTRATOR_BASE_PATH`; preserve `SANDBOX_DIR`. Each VM gets its own private mount
namespace at that path. It preserves Embed's host launcher and sandbox shutdown
behavior. Keep the build directory in place and use its generated project name;
do not omit `runtime.override.json`. The API and migrator must use the same source
build; mixing them can fail the API's schema compatibility check. Stop this stack
with the same three `-f` arguments followed by `down`.

Older generated configurations using the fixed `launchpad-e2b-proof` name are not
updated automatically. Stop them using their original configuration and create a
fresh build directory with this script; do not rename a deployment's project while
keeping its existing disk storage.

### Build the supported patched runtime

The runtime patches are applied in order: `0001` adds strict offline filesystem
verification; `0002` adds a durable independent disk, bounded enrollment replacement
and cancellation tombstones; `0003` adds durable operation records, source pins,
authenticated admission and cold-boot activation; `0004` adds operator-admitted
renewable finite leases and ordered route publication/revocation; `0005` requires
the installed firewall check before guest starts on opted-in nodes; `0006` safely
retires restore requests whose lease expired before boot permission was recorded;
`0007` makes restores share normal team capacity without expiring uncertain starts;
`0008` turns memory-mapped snapshot-copy faults into failed snapshot receipts instead
of crashing the host process; `0009` records physical execution identities before boot,
fences later starts during deletion, and verifies host process groups are empty;
`0010` releases failed-activation reservations after confirmed physical shutdown
and prepared-disk cleanup, preserving the permanent execution fence; `0011` uses
filesystem-frozen, filesystem-only checkpoints for managed recovery snapshots,
retains the running source VM, and rejects unquiesced cold-restore sources.
`0012` validates configurable template free disk; `0013` permits authenticated,
non-waking inspection of a running private VM’s ingress token; `0014` reports
renewable lifetime from the authenticated team’s configured policy; `0015`
identifies the disk and memory build layers retained by a snapshot; `0016`
serializes build collection with API admission and provides an idle-host collector
which preserves those layers. It refuses active or uncertain execution. `0017`
adds durable boot roots and permanent write refusal for collected local builds;
`0018` releases superseded snapshot layers while retaining successful resume tips,
saved backups and running disk bases; `0019` preserves zeroed disk regions as
sparse holes during verified cold preparation, with the same full byte checksum.
`0020` preserves those holes when publishing the prepared disk into local storage,
so activation does not allocate the VM's free disk space again. `0021` allows an
operator-set cold-boot budget and gives managed creation time for disk recovery
and authenticated guest initialization. `0022` binds the ARM serial console during
quiet cold boots without enabling verbose guest logging. `0023` flushes local
disk publication before reporting success and rejects cancelled replacements.
`0024` adds a trusted initrd cold probe, bounded host cgroups, recorded process
reconciliation and an immutable proof bound to the prepared disk. `0025` shares
host capacity with ordinary guests. `0026` retains filesystem-only paused disks
without starting the guest, and requires physical stop receipts before doing so.
Existing memory pauses or executions predating its migration have no such receipt;
keep them until an explicit resume followed by a confirmed filesystem-only pause.
`0028` removes historical resume records only after a permanent physical-stop
receipt, including idempotent stop retries after an API restart. This releases
retired pause disks to the collector while independent saved snapshots keep their
own references. Completed restores are stopped and their published snapshots
deleted; cancellation applies only to unfinished preparation.
`0029` collapses overlapping IPv4 deny/allow ranges before installing them.
Host IPs inside the blocked private ranges otherwise cause VM creation to fail
with a netlink "file exists" error. Blocking remains the union of the supplied ranges.
`0030` records each managed creation operation and its sandbox identity before a
host can start it. The relay requires `durableCreationIdentity` before sending
new creation requests. Cancelling a failed start seals the operation against late
requests and confirms physical shutdown before releasing capacity. Existing
ambiguous creations from older runtimes remain reserved until their original VM
is identified and stopped; do not backfill the relay's protocol marker or treat an
empty SDK listing as proof that execution stopped.
`0031` recovers a restored VM that failed before reaching its live registry. It
requires the exact host execution's permanent physical-stop receipt before
releasing that attempt; a timeout or missing routing entry cannot release it.
The saved source and committed thread ownership remain available for retry.
`0032` gives cold restores the same supported huge-page memory backing as ordinary
E2B starts. The configured guest RAM size and stopped-guest boot remain unchanged.
`0033` requires the latest disk and physical-stop receipt before reporting a certified
pause. `0034` rejects a restore larger than the host's entire disk budget without
creating a reservation; temporary occupied capacity remains retryable. `0035` lets
operators limit collection to reviewed build UUIDs inside the collector's lock.
`0036` preserves filesystem-only timeout pauses when restored VMs are registered. `0037` requires a certified pause before a new execution can replace the active identity.
`0038` waits for the Firecracker API socket to accept a connection before configuring it.
`0039` retains a damaged execution's snapshot layers before sealing it for backup recovery.
Deploy its matching API, orchestrator and database migration together; the relay requires
`executionRetention` before admitting recovery. A missing VM or routing entry cannot replace
its positive physical-stop receipt, and retained layers must survive until recovery or explicit
thread deletion resolves.
The ingress token stays on the relay: never include it in client URLs or responses.
These are development builds.
Failed-start reconciliation, busy database recovery, physical shutdown, guest-network
isolation and the full lifetime boundary have passed on the dedicated development
host. Repeat these proofs on the deployment you intend to use. Product provisioning,
artifact retention and lifecycle integration remain separate release requirements.

Copy the runtime patch files from `infra/e2b/patches/` and `runtime-tests.Dockerfile` beside
the build script. For a new Launchpad installation, apply the full patch set to
the default directory:

```sh
sudo python3 build-runtime.py /var/lib/launchpad-e2b \
  --patch 0001-offline-restore-filesystem-check.patch \
  --patch 0002-durable-prepared-disk.patch \
  --patch 0003-restore-operation-state.patch \
  --patch 0004-renewable-lifetime.patch \
  --patch 0005-host-firewall-admission.patch \
  --patch 0006-restore-expiry-recovery.patch \
  --patch 0007-restore-capacity-reservation.patch \
  --patch 0008-snapshot-copy-fault-isolation.patch \
  --patch 0009-physical-execution-fence.patch \
  --patch 0010-stopped-restore-reconciliation.patch \
  --patch 0011-quiesced-recovery-snapshots.patch \
  --patch 0012-configurable-template-free-disk.patch \
  --patch 0013-private-running-vm-ingress.patch \
  --patch 0014-report-renewable-lifetime-policy.patch \
  --patch 0015-retained-build-references.patch \
  --patch 0016-quiescent-build-collection.patch \
  --patch 0017-live-build-roots-and-retirement.patch \
  --patch 0018-ready-snapshot-tips.patch \
  --patch 0019-sparse-prepared-disks.patch \
  --patch 0020-sparse-local-publication.patch \
  --patch 0021-configurable-cold-boot-budget.patch \
  --patch 0022-arm64-quiet-boot-console.patch \
  --patch 0023-durable-local-publication.patch \
  --patch 0024-quarantined-cold-proof.patch \
  --patch 0025-host-recovery-capacity.patch \
  --patch 0026-non-waking-paused-disks.patch \
  --patch 0027-private-preview-header-boundary.patch \
  --patch 0028-stopped-snapshot-retirement.patch \
  --patch 0029-overlapping-egress-ranges.patch \
  --patch 0030-durable-creation-cancellation.patch \
  --patch 0031-failed-restore-boot-recovery.patch \
  --patch 0032-cold-boot-memory-backing.patch \
  --patch 0033-certified-pause-status.patch \
  --patch 0034-restore-disk-budget-rejection.patch \
  --patch 0035-scoped-build-collection.patch \
  --patch 0036-restored-vm-timeout-policy.patch \
  --patch 0037-active-execution-registration.patch \
  --patch 0038-firecracker-api-readiness.patch \
  --patch 0039-execution-recovery-retention.patch \
  --patch 0040-envd-operation-context-timeout.patch \
  --patch 0041-orchestrator-service-shutdown.patch \
  --patch 0042-stopped-restore-template-retirement.patch \
  --patch 0043-preserve-finalized-image-permissions.patch
```

Existing patched installations in other directories keep their current path and
storage; select them with `E2B_RUNTIME_DIR` rather than moving files or rebuilding
just to adopt the default. Use a separate fresh output directory for an isolated
runtime proof, and pass that directory consistently to its verification commands.

After installing the host safeguards below, start the E2B control plane from
the Launchpad checkout on your Mac or native Linux host:

```sh
vp run start:vm-host
```

This verifies the build receipt and starts the required E2B services. Missing
external dependency images are downloaded at their pinned digests; the locally
built API, proxy and migrator retain `pull_policy: never`. On first
startup, retrieve the generated [E2B API key](#retrieve-the-e2b-api-key) and use the
installation's seeded team UUID for the restore/lifetime settings below. Apply
the team and capacity configuration before admitting Launchpad threads, then run
`vp run start:vm-host` again to recreate affected services with those settings.
Normal startup skips the upstream `base-template` job because Launchpad builds its
own runner template. For an optional upstream smoke check against that patched
installation, enter its directory inside Linux and retain the same project
identity and all three files. The smoke service builds the upstream base template
and waits for it to finish successfully:

```sh
cd /var/lib/launchpad-e2b
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml \
  --profile test run --rm smoke
```

Managed VM creation requires `LAUNCHPAD_REQUIRE_EXECUTION_FENCE=true` on every
eligible orchestrator and the matching API migration. Retain the orchestrator's
`executions` directory beneath `ORCHESTRATOR_BASE_PATH`; it contains durable stop
receipts, not disposable build cache. Apply this setting only on a host drained
of older VMs. Unregistered legacy VMs cannot provide a verified stop receipt.
The optional pause-prefetch optimization is disabled on fenced hosts because it
boots a separate, unregistered VM after pausing.

On a slow or nested development host, set `LAUNCHPAD_COLD_BOOT_TIMEOUT=300s`
in the host Compose `.env`. The default is `60s`; values must be between `60s`
and `5m`. Managed creation reserves another minute for offline recovery and
authentication. Caller deadlines still apply, so a synchronous SDK cold-resume
request needs a longer request timeout as well. Durable restore activation is
asynchronous and remains bounded by its recorded lease. This changes startup
waiting time, not the VM's CPU, memory, or execution fence.

Restore RPCs are disabled unless the orchestrator has
`RESTORE_PREPARATION_ENABLED=true`. For isolated API testing, also set
`LAUNCHPAD_RESTORE_TEAMS` to the dedicated E2B team UUID,
`LAUNCHPAD_RESTORE_NODE_ID` to the API's discovered node ID (`local` in the pinned
Embed deployment, not the `orchestrator` container name) and
`LAUNCHPAD_RESTORE_CAPACITY_BYTES` to its reserved temporary disk budget. Preparation
reserves twice the disk's size, rounded up to account for E2B's truncated MiB metadata. Size this from the
selected runner build, including its requested free guest space, rather than an
earlier smaller test image. A 25 GiB disk needs about 50 GiB of temporary budget
for one preparation; the budget must fit available host storage after retained
snapshots and other reservations. HTTP 429 before preparation can mean this disk
budget is too small even when a running VM slot is available. Only the explicit activation operation
can boot a prepared disk; verification-only preparations cannot activate.

For renewable-lifetime testing, set `LAUNCHPAD_RENEWABLE_LIFETIME_TEAMS` on the
API to the dedicated team UUID. This is separate from restore authorization.
Removing a team blocks new grants; explicitly drain existing allocations before
retiring their policy. Keep the host keeper enabled: the exception removes the
absolute age cap, not finite lease expiration. The extension capability remains
disabled until the full real-VM boundary proof is verified.

The versioned API is under `/extensions/launchpad/v1/` and requires the normal
team API key. Removing a team from the allowlist blocks new admissions; keep the
node setting and host extension enabled until existing operations finish or are
cleaned up. An uncertain activation retains capacity and its source pin. Inspect
that operation instead of starting a new one. These settings alone do not satisfy
the product release gates.

`infra/relay/scripts/e2b-prepared-restore-smoke.mjs` exercises the actual
`E2BThreadVmCompute.restore` client with disposable named snapshots. Bundle it for
the pinned SDK container (bundle Effect, leave `e2b` external), mount an empty
host gate directory into the container, and set `E2B_RESTORE_PROOF_GATE_DIR` to
that mount alongside the existing explicit API, sandbox and key-file settings.
Set `E2B_TEMPLATE_RECEIPT` to the verified runner receipt. Preserve the relative
`infra/relay/scripts` and `infra/e2b` layout so the bundled script can load
`busy-disk-proof.py`.
When the script writes `prepared.json`, run `infra/e2b/verify-restore-proof.py`
on the dedicated Linux host with the runtime's `prepared-restores` directory
and the host gate directory as its two arguments. It inspects the test disk in
a read-only jail and only releases activation when the saved startup service is
still enabled but has not executed. A failed check leaves the proof failed.

Managed backups require the runtime’s `quiescedSnapshots` capability. A memory
snapshot can omit file contents still in the guest page cache; filesystem repair
cannot recover those contents. Re-capture a running source with the patched
runtime before relying on cold recovery.

Repeat the proof with `--paused-source` to check non-waking retention, and add
`--final-save` to exercise the final-save operation name. These require patch
`0026` and its `pausedSnapshots` capability. The paused run writes `paused.json`
and waits for an independent host check before preparing the restore. Confirm
that the source's physical guest processes are gone before releasing that gate;
SDK routing absence alone does not prove shutdown. Older memory pauses must be
explicitly resumed and paused without memory before they can use this path.

The workload holds an open SQLite WAL connection and an unfinished transaction,
serves requests during snapshotting, and writes a file without an explicit fsync.
A successful cold recovery must retain the committed row and file bytes, discard
the unfinished transaction, and leave the old server stopped. Run this proof on
the selected deployment before enabling routine deletion.

The pinned Embed snapshot deletion API only soft-deletes its catalog entry.
Patch `0016` adds `artifacts/launchpad-build-collector` to physically reclaim
unreferenced build prefixes. A retained snapshot can depend on layers from a
deleted snapshot, so deleting build directories by age or catalog status can
destroy recoverable work. The collector traces every retained disk and memory
mapping before deleting anything, and keeps the catalog and API admission locked
through physical deletion. It refuses missing headers or unconfirmed execution.

Run the collector on the dedicated compute host, with every API instance upgraded
and older unregistered VMs drained. It requires the authenticated loopback API to
report `buildCollectionAdmission: true`; keep `LAUNCHPAD_RESTORE_NODE_ID` set.
This first version requires an idle, physically fenced host. It is an operator
maintenance tool, not automatic rolling-backup cleanup. Do not enable automatic
backup or deletion on the strength of this command alone.

Create a mode-600, host-only JSON file with `databaseURL` for the compute database,
`storagePath` pointing to this deployment's `state/templates`, `apiURL` set to
`http://127.0.0.1:3000`, and `apiKey` containing the E2B team key. Keep this file
outside source control and guest filesystems. Pass it on stdin so credentials do
not appear in process arguments:

```sh
sudo ./artifacts/launchpad-build-collector < /path/to/collector.json
sudo ./artifacts/launchpad-build-collector --apply < /path/to/collector.json
```

The first command reports candidates without deleting them. Inspect that report
before running `--apply`. On failure, the report lists only confirmed deletions;
retry uses the same locked catalog and is idempotent. It does not modify catalog
ownership or shorten snapshot retention. Keep the collector's checksum in
`build.json` with the runtime receipt.

`build.json` records each patch checksum; patched image tags include the patch-set
hash and are separate from the unmodified baseline. Keep the generated source,
patches and receipt together. The script refuses patches which do not apply to
the pinned source.

Patch `0017` records each VM's disk base before boot and permanently rejects
uploads to collected build IDs. Its optional `--live` collector mode requires
`executionBuildRoots` and `liveBuildCollection` from the running API. The latter
is false unless the API and discovered host report the same patched build.
Unknown older executions and full-memory checkpoints still block live collection;
do not infer their bases from routing records. Keep the default idle-host mode
until the real running/paused-VM collection proof passes. Automatic product
backup, collection and deletion remain disabled until their release gates pass.

For a disposable independent database/storage fixture, run
`infra/relay/scripts/e2b-disk-retention-smoke.mjs` with `--fixture`, `--collector`
and a new `--output` directory. It uses the fixture's private `host.json`, verified
`template.json` and mode-600 `collector.json`, alongside the usual explicit E2B
endpoints and key file. Bundle Effect and leave the pinned `e2b` SDK external.
The fixture ledger must mark it active, identify its separate original/fixture
storage and use a `lp_recovery<attempt>_<id>` database. Run on the dedicated host
with those absolute paths accessible. The proof saves two independent snapshots
and checks that source deletion is refused during preparation and serving. Before
publication, collection may conservatively refuse the catalog and must delete
nothing. After activation it must preserve the serving disk, the other saved disk
and their shared ancestry. After confirmed VM stop and snapshot deletion, it must
reclaim the released disk bytes.
On failure, inspect its exact resource receipt before restoring host services.
This runtime proof does not replace authenticated product deletion tests.

After this proof passes, install `launchpad-thread-vm-collection.service` and its
`.timer` in `/etc/systemd/system/`. Install the receipt-verified collector binary
as `/opt/launchpad-e2b/launchpad-build-collector`, owned by root and mode 0755.
Keep its input in `/etc/launchpad-e2b/build-collector.json`, owned by root and
mode 0600, with the host's `databaseURL`, `storagePath`, loopback `apiURL` and
team `apiKey`. Use the compute database and template storage configured by the
running host, not the relay database or another host's storage.

Start the timer after installing its units:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now launchpad-thread-vm-collection.timer
```

The timer retries every five minutes and
never wakes a VM. Catalog retirement by the relay alone does not reclaim disk
layers; this host job performs that step. A refused collection retains the data
and retries later. Inspect persistent refusals with
`sudo journalctl --all -u launchpad-thread-vm-collection.service`.
Stop the timer and let its service finish
before changing runtime/storage configuration; keep the verified binary and
running API/host on the same patch set.

A filesystem-only pause also needs the environment server's stopped conversation
and attachment recovery receipt. The host's disk receipt cannot replace that
acknowledgement. After explicit resume, the server must persist and acknowledge
its reopened execution fence before another pause may replace the old recovery
operation. Keep the paused recovery point through final-save cancellation; a
cancelled save must be retryable without waking the VM.

Run the focused race tests and export the privileged integration test binary:

```sh
sudo docker build --file runtime-tests.Dockerfile \
  --output type=local,dest=/tmp/launchpad-e2b-rootfs-tests \
  /var/lib/launchpad-e2b/source/e2b-dev-runtime-1599d6e/packages
sudo env E2B_OFFLINE_RESTORE_TEST=1 \
  /tmp/launchpad-e2b-rootfs-tests/rootfs-tests \
  -test.run '^(TestPrepareRestoreFilesystemOffline|TestPreparedDiskOfflineSurvivesSourceDeletion|TestRestoreBootstrapRejectsSymlinkOffline)$' \
  -test.v -test.timeout=5m
sudo env E2B_OFFLINE_RESTORE_TEST=1 \
  /tmp/launchpad-e2b-rootfs-tests/filesystem-tool-tests \
  -test.run '^TestFilesystemToolSurvivesControllerDeath$' -test.v -test.timeout=1m
sudo /tmp/launchpad-e2b-rootfs-tests/network-firewall-tests \
  -test.run '^(TestApplyRules_OverlappingHostAddresses|TestIPv4RangeEndingAtMax|TestSplitEgressCIDRs)$' -test.v
sudo /tmp/launchpad-e2b-rootfs-tests/routing-catalog-tests -test.run '^TestRouteLease' -test.v
sudo /tmp/launchpad-e2b-rootfs-tests/lifetime-api-tests -test.run '^TestRenewableLifetimeAdmission' -test.v
sudo /tmp/launchpad-e2b-rootfs-tests/lifetime-store-tests -test.run '^TestAddPreservesAdmittedRenewableLease' -test.v
sudo /tmp/launchpad-e2b-rootfs-tests/reservation-tests -test.run '^TestRestoreReservation|^TestReservation' -test.v
sudo /tmp/launchpad-e2b-rootfs-tests/restore-db-tests -test.v -test.timeout=5m
sudo /tmp/launchpad-e2b-rootfs-tests/restore-api-tests \
  -test.run '^(TestLaunchpadRestore|TestTemplateDeletion)' \
  -test.v -test.timeout=5m
sudo /tmp/launchpad-e2b-rootfs-tests/restore-api-tests \
  -test.run '^TestExecution|^TestCreation' -test.v -test.timeout=5m
sudo /tmp/launchpad-e2b-rootfs-tests/execution-db-tests \
  -test.run '^TestCreation' -test.v -test.timeout=5m
sudo /tmp/launchpad-e2b-rootfs-tests/build-retention-db-tests \
  -test.run '^TestPinnedCatalogFailedLatestSnapshotKeepsPreviousResumeDisk$' \
  -test.v -test.timeout=5m
```

Run the integration tests only on the dedicated host with other E2B stacks stopped.
The database tests start and remove their own disposable PostgreSQL containers.
The protocol bindings use protoc 33.0, protoc-gen-go 1.36.11 and
protoc-gen-go-grpc 1.6.1; SQL bindings use the pinned upstream sqlc tool.
The rootfs integration test allocates a temporary NBD copy of a generated
filesystem, checks valid and corrupted data and verifies the source checksum.
The filesystem-tool test kills its own controller while a systemd tool remains
alive, verifies cleanup before device reuse, and rejects a delayed old start.
The API/database tests check durable ordering, team isolation and lost replies.
These tests start no VM. A successful filesystem check says nothing about application
consistency or restore ownership; the complete restore gate still applies.

Host filesystem tools reserve their disk device under `/run/e2b-filesystem-tools`
before launch. An uncertain stop leaves the device quarantined until orchestrator
restart reconciliation; do not remove these markers by hand. Startup refuses to
create the device pool if it cannot confirm that old tools have stopped, including
when ordinary startup resource reclamation is disabled. This requires one
orchestrator per compute host, as the underlying NBD and networking setup already do.

### Optional unmodified baseline for maintainers

To compare the patched runtime with unmodified upstream source, build a separate
baseline directory without the patch arguments:

```sh
sudo python3 build-runtime.py /var/lib/launchpad-e2b-baseline
```

This baseline is for development checks only and cannot provide Launchpad's
required lifecycle capabilities. Do not select it for normal VM support. It is
not a prerequisite for the patched build, and building it does not start services
or replace an existing installation.

## Launchpad host safeguards

Install `infra/e2b/host-firewall.nft`, `host-firewall.py` and
`launchpad-thread-vm-firewall.service` on the dedicated host. Use the generated
Compose override and keeper script from the selected runtime build directory.

```sh
sudo install -D -m 0644 host-firewall.nft /etc/launchpad/host-firewall.nft
sudo install -D -m 0755 host-firewall.py /usr/local/libexec/launchpad-host-firewall
sudo install -D -m 0644 launchpad-thread-vm-firewall.service /etc/systemd/system/launchpad-thread-vm-firewall.service
sudo systemctl daemon-reload
sudo systemctl enable --now launchpad-thread-vm-firewall.service
sudo /usr/local/libexec/launchpad-host-firewall check
cd /var/lib/launchpad-e2b
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml \
  up -d --no-deps launchpad-keepalive
```

The service reapplies the policy on host boot. The patched orchestrator's
`LAUNCHPAD_REQUIRE_HOST_FIREWALL=true` setting in the override refuses new guest
starts if rules or the installed policy differ from the service's receipt.
After intentionally updating the policy, reload the service and rerun `check`.
A missing checker also blocks admission. Existing workloads continue when a check
fails; fix the host policy before admitting more work.

The firewall depends on the pinned runtime's `veth-<slot>` interface names and TCP
egress proxy ports. It blocks guest access to host/private networks and forwarded
IPv6, while preserving public IPv4 Internet access. It does not secure the host's
public listeners against outside clients: bind or firewall the control plane
separately. Run the guest-network proof against the actual installation before
admitting product VMs. Copy `verify-network-proof.py`, `network-proof.mjs`, and
`runtime.lock.json` together to that host, then run:

```sh
sudo python3 verify-network-proof.py --seed-volume YOUR_COMPOSE_PROJECT_seed-state --output /var/lib/launchpad-network-proof
```

The output directory must be new. This needs two free VM slots and uses the seeded
base template. It creates disposable guests, temporary host listeners and IPv6
routes, verifies host and peer denial from guest root, and checks private preview
access with and without its token. It removes its tagged guests and temporary
network changes; retain the output directory as evidence. A cleanup error must be
resolved before rerunning.

Firecracker intercepts `169.254.169.254:80` inside each VM for its own metadata
service. This is not the host's cloud metadata endpoint. The proof requires it to
identify only the current VM and expose the pinned bootstrap fields, including an
envd token hash, with no management credentials. Other access to that address
still goes through the host boundary.

Verify the checker against disposable kernel rules without touching the host's
network namespace (copy `test_host_firewall.py` beside the source files):

```sh
python3 -m unittest discover -p test_host_firewall.py
sudo unshare --net env LAUNCHPAD_FIREWALL_NAMESPACE_TEST=1 python3 -m unittest discover -p test_host_firewall.py
```

The keepalive service renews only running allocations marked as Launchpad thread
VMs. It does not resume paused VMs or decide when work is idle. Each renewal reads
back the deadline: E2B can return success while shortening the requested extension
to its maximum VM lifetime. A shortened deadline is reported separately and is not
counted as a successful renewal. Keep this service on the compute host and keep
its management key outside guests.

The unmodified API enforces `StartTime + MaxInstanceLength`. Patch `0004` allows
explicitly admitted Launchpad allocations to renew beyond that age while keeping
finite deadlines and normal pause/delete behavior. This needs both the independent
keeper and the matching client proxy: a live VM is unusable if an older proxy loses
its route at the original deadline. Run the complete lifetime smoke test across the
original age limit, including API/keeper restarts, process continuity, an ordinary
allocation control and explicit pause/delete. A short lease-extension check or a
higher age limit does not establish this behavior. Other restore and isolation
gates still block product VM admission.

## Native conversation portability check

Run this from macOS with the pinned Codex executable and an explicitly authorized
subscription profile. The E2B API and proxy must be reachable from the operator's
machine; the guest still uses the normal host firewall. Keep the existing
`E2B_API_URL`, `E2B_SANDBOX_URL`, and `E2B_API_KEY_FILE` configuration.

From the repository root:

```sh
node infra/relay/scripts/build-codex-portability-proof.mjs /tmp/launchpad-native-proof-tools
node /tmp/launchpad-native-proof-tools/run-codex-portability-proof.mjs \
  --binary /absolute/path/to/pinned/codex \
  --auth-file /absolute/path/to/authorized-profile/auth.json \
  --receipt /absolute/path/to/runner-template-receipt.json \
  --output /tmp/launchpad-native-proof-results
```

Both output directories must be new. The test runs real model turns, transfers
the same native conversation to Linux, compacts it, restarts Codex, and returns it
to a new Mac checkout rebuilt from Git. It checks a conversation-only fact, image
recall, retention and relocation of the image's actual file, tool execution in the
new directory, and rejection of missing/corrupt native artifacts. Referenced files
are retained separately from the rollout, checked by checksum, and imported into
the destination's private native storage. A missing file blocks continuation.
It stops the disposable VM using the physical-stop receipt.

Only the selected profile's access token and account ID enter the fresh Codex
process through stdin; its home and refresh token are not copied. Test artifacts
are private files under the output directory. If cleanup is uncertain, reconcile
its saved allocation identity before rerunning. Native histories with child-session
or inherited-history dependencies currently block transfer rather than dropping
those dependencies. Their complete transfer and Launchpad attachment transfer
require separate checks; this harness does not claim to verify them.

## Restore release gate

Upstream independent-snapshot creation resumes saved processes. Building a new
template from that snapshot also starts enabled guest services during construction.
Neither path is suitable for transferring execution ownership. The negative
`e2b-restore-smoke.ts` test demonstrates this early-start behavior; it is not the
Launchpad restore path.

Use the patched prepared-restore protocol and `e2b-prepared-restore-smoke.mjs` above.
It verifies the disk offline, rotates enrollment before boot, and requires an
explicit activation. Its busy workload checks committed SQLite WAL recovery,
rejection of an unfinished transaction, preservation of unsynced file contents,
and source process continuity during capture. The positive test must pass on the
actual operator deployment.

### Quarantined disk verification

Copy `build-quarantine-probe.py`, `quarantine-probe.py`, `runtime.lock.json`, and
`quarantine/` together to the dedicated Linux host. Build the trusted init with the
cached pinned toolchain:

```sh
sudo python3 build-quarantine-probe.py /var/lib/launchpad-probe-build
sudo python3 quarantine-probe.py configure-capacity --max-running-vms 1
sudo python3 quarantine-probe.py --direct \
  --disk /absolute/path/to/prepared-build/rootfs.ext4 \
  --disk-sha256 VERIFIED_PUBLISHED_DISK_CHECKSUM \
  --required-files /absolute/path/to/required-files.json \
  --probe-build /var/lib/launchpad-probe-build \
  --output /var/lib/launchpad-disk-verification
```

Both output directories must be new. The required-file manifest is a JSON array
of absolute guest paths with `path`, `size`, and `sha256` from the verified recovery
catalog. Use the checksum recorded when the whole prepared disk was published.
The caller must retain its disk pin and reserve two CPUs and 5 GiB of temporary
host capacity until the operation record confirms physical shutdown.

The verifier boots a host-owned initrd with no network interface and mounts the
saved disk read-only without running any of its executables. It accepts only the
trusted PID 1, checks the required files, and writes a durable success receipt
after the probe VM has stopped. It verifies the pinned kernel, Firecracker,
probe build, and published disk before boot. It does not delete the saved disk
or authorize ordinary runner startup.

With patch `0024`, set `RESTORE_COLD_PROBE_ENABLED=true` on the orchestrator to
run the packaged verifier before a preparation becomes ready. It runs directly
in a private network namespace and a bounded cgroup, without a Docker socket.
The host needs `python3`, `cpio`, `unshare`, delegated CPU/memory controllers
and `cgroup.kill`. The runtime builder exports the packaged probe beside the host
launcher binary and supplies its absolute paths. Runtime verification checks the
probe artifacts against the build receipt and rejects replacement launch paths.
Before enabling the probe, stop ordinary VMs and configure its host budget using
`sudo python3 <build>/artifacts/launchpad-probe/quarantine-probe.py configure-capacity --max-running-vms 1`.
Use the same ordinary-VM limit for the relay's `E2B_MAX_RUNNING_VMS`. Each ordinary
VM is budgeted at 2 CPUs and 5 GiB, including host overhead. The verifier reserves
another 2 CPUs and 5 GiB; the defaults leave 1 CPU and 3 GiB for host services.
The command refuses a profile larger than the host and refuses changes while
any ordinary or verification VM is running or has an unreconciled cgroup.
Patch `0025` serializes ordinary VM cgroup admission under that same host lock;
empty reservations still count until their execution cleanup removes them. It applies CPU/memory limits to the
ordinary E2B cgroup and stores a private host budget. This dedicated host must not
run other unbudgeted VM workloads.

Kernel cgroup limits disappear when the host reboots. After configuring capacity,
install the receipt-verified `quarantine-probe.py` as
`/usr/local/libexec/launchpad-quarantine-probe` and
`infra/e2b/launchpad-thread-vm-capacity.service` under `/etc/systemd/system/`.
Enable it with `sudo systemctl daemon-reload` and
`sudo systemctl enable --now launchpad-thread-vm-capacity.service`.
It restores the retained private budget before Docker starts and refuses occupied
or unreconciled groups. Check its status after reboot, then run `check-capacity`
with the verified helper before admitting work. Admission still refuses missing
or changed limits when the service fails.

Before each probe, the helper checks that those limits still match the protected
budget and that current physical memory has sufficient headroom, including the
remaining memory allowance of existing ordinary VMs. If either check
fails, verification waits and the previous save remains intact. `check-capacity`
checks this prerequisite without starting a VM. A memory limit alone does not
prove recoverability; the cold verification must still complete.
One host lock serializes probes across backup builds; an uncertain process keeps
that capacity occupied until its recorded cgroup is reconciled.
The relay retains the proof before cancelling the temporary preparation; a host
without this proof leaves the candidate unverified and preserves the previous save.

This automatic probe certifies cold filesystem availability. Separately retained
native conversation state remains a prerequisite for routine VM deletion and
reset. A passing probe also does not establish successful runner activation:
that cold-start check must pass, and placement must be committed before saved
startup services may execute.

Do not enable automatic deletion based solely on a successful snapshot API response.
A saved disk must pass the separate recovery verification and retention checks first.
The resume API's `memory: false` option alone does not establish recoverability of
an independent saved image.

## Stop and restart

Stop the generated E2B stack from its existing deployment directory inside Linux,
using the same project identity and Compose files as startup:

```sh
sudo docker compose -f compose.yaml -f runtime.override.json -f compose.override.yaml down
```

`runtime.override.json` supplies the generated project name. If startup used an
explicit `--project-name` or additional overrides, include those same arguments
when stopping it. Do not add `--volumes` (`-v`): its volumes contain installation
state.

Stopping the host services ends all running thread VMs on that host; save or pause
their work first. After restarting the Linux host, run `vp run start:vm-host` from
the Launchpad checkout on your Mac or native Linux host. It reuses the selected
installation and storage. For destructive cleanup or failed startup, use the
upstream guide for the installed revision.

## Private application previews

Previews require a separate, cookie-free application domain with wildcard DNS and
TLS routed to the relay, for example `*.vm-preview.example.net`. Use a different
registrable domain from Launchpad and Clerk so application JavaScript cannot
access or overwrite their parent-domain cookies. Do not put previews on the relay
or Launchpad origin. Set `RELAY_THREAD_VM_PREVIEW_BASE_URL` to
`https://vm-preview.example.net`; leave it unset to disable previews. When enabling
it, set `RELAY_THREAD_VM_APP_ORIGINS` to all Launchpad browser origins and
`RELAY_THREAD_VM_AUTH_ORIGINS` to all Clerk origins, as comma-separated HTTP(S)
origins without paths. Include custom Clerk domains and authentication proxies.
The relay checks these lists and its public URL against the public suffix list,
including private hosting domains, and refuses missing or unknown boundaries or
shared registrable domains. Stripping HTTP cookie domain attributes cannot prevent
application JavaScript from setting parent-domain cookies.

For an isolated local relay, `http://preview.localhost:8610` uses the same listener
with a different host. Open the authenticated Launchpad app on `127.0.0.1`, declare
that origin in `RELAY_THREAD_VM_APP_ORIGINS`, and supply its Clerk origins too.
An authenticated app on `localhost` or a `.localhost` subdomain shares that preview
namespace and is refused. Each preview opens on its own subdomain. Provisioning still
requires the HTTPS public relay URL documented above.

For a real guest ingress check, run the proof on the compute host with its E2B API
key file and a verified template receipt. Use a new output directory so uncertain
creation or cleanup retains its exact operation identity:

```sh
E2B_API_URL=http://127.0.0.1:3000 E2B_SANDBOX_URL=http://127.0.0.1:3002 \
E2B_API_KEY_FILE=/run/e2b/team-api-key \
node infra/relay/scripts/e2b-private-ingress-proof.mjs \
  --receipt /absolute/template-receipt.json --output /absolute/new-ingress-proof
```

On the development checkout, the headless Worker check uses the installed
Cloudflare runtime and isolated loopback fixtures. It verifies HMR forwarding,
authorization after 30 seconds and revocation cleanup without a browser or login:

```sh
node infra/relay/scripts/preview-cloudflare-smoke.mjs /absolute/new-worker-proof
```

Apply and verify patch `0027` before enabling previews. It removes the E2B traffic
credential and routing headers at the final guest boundary, after authentication;
an application which echoes request headers must not receive them. Check both
ordinary HTTP and WebSocket requests on the installed Linux runtime. The relay
keeps compute credentials and denies its runner and envd ports as app previews.

Open an explicitly selected application port from the thread's VM controls.
Preview links are single-use and expire after one minute; authenticated sessions
expire after an hour. Opening a preview does not resume paused compute. Moves,
reset, deletion and access revocation invalidate the recorded VM generation;
active streams and sockets recheck access at five-second intervals.
