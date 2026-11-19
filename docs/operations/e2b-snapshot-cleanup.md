# Snapshot storage cleanup

Launchpad decides when a backup expires and retires its E2B catalogue entry. The
standalone host collector reclaims physical layers only after checking all retained
disk and memory mappings, assigned template versions, paused snapshots and native
build-cache references. It does not shorten retention or replace a recovery backup.

The first version supports a dedicated Linux host running one stock E2B Compose
deployment. On macOS, run it inside the Lima host. Physical collection is restricted
to the verified stock source revision `518278060a154124a80d98f37253f8af77baf478`;
unknown runtime versions, patched launch commands and incomplete inventories are
refused. A successful snapshot persistence test alone does not establish compatibility
with the collector's work accounting and shutdown requirements.

## Prepare the supported runtime

Follow [E2B host setup](e2b-host-setup.md#build-the-launchpad-runtime) on a fresh,
dedicated Linux host. The stock builder pins the API, orchestrator, SDK helper and
native launch scripts to the collector's supported revision and emits the matching
`collector.example.json`. `vp run start:vm-host` verifies that deployment before
starting it. Keep all generated Compose files and receipts together.

An old patched deployment needs separate preservation and migration; selecting a
new output directory alone does not migrate its host-global storage. The stock
installer refuses to adopt that storage. Generic host teardown remains disabled.

## Build and configure the collector

From the Launchpad checkout, build a new Linux executable using the pinned Go
toolchain and dependencies:

```sh
python3 infra/e2b/build-snapshot-collector.py --arch arm64 --output /tmp/launchpad-snapshot-collector
```

Use `amd64` for an x86 Linux host. The builder creates a checksum receipt beside
the binary, starts no services and refuses to overwrite an existing artifact.
Install the binary and the generated runtime's matching configuration:

```sh
sudo install -d -m 0755 /opt/launchpad-e2b /etc/launchpad-e2b
sudo install -o root -g root -m 0755 /tmp/launchpad-snapshot-collector /opt/launchpad-e2b/launchpad-snapshot-collector
sudo install -o root -g root -m 0600 /var/lib/launchpad-e2b/collector.example.json /etc/launchpad-e2b/snapshot-collector.json
```

Set `project` to the exact E2B Compose project. Set `storagePath` and
`buildCachePath` to that deployment's configured host directories; both are checked
against the owning orchestrator. Keep `journalPath` at
`/var/lib/e2b/snapshot-collection.jsonl`; the supported dedicated-host deployment
uses that fixed location so setup, startup and collection share crash recovery.
`minimumAgeSeconds` is an additional collection margin, not the backup retention
period. It does not by itself make concurrent deletion safe.
For a separately prepared compatible deployment,
`infra/e2b/snapshot-collector.example.json` is a starting point; update its project
and paths to match that deployment.

## Preview and collect

Run the default report first:

```sh
sudo /opt/launchpad-e2b/launchpad-snapshot-collector < /etc/launchpad-e2b/snapshot-collector.json
```

The shipped `launchpad-thread-vm-collection.service` and `.timer` run reports only.
Install and enable those units after the report succeeds:

```sh
sudo install -o root -g root -m 0644 infra/e2b/launchpad-thread-vm-collection.service infra/e2b/launchpad-thread-vm-collection.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now launchpad-thread-vm-collection.timer
```

After the deployment has passed collection followed by restoration of retained
snapshots, use `sudo systemctl edit launchpad-thread-vm-collection.service` to
enable physical collection:

```ini
[Service]
ExecStart=
ExecStart=/opt/launchpad-e2b/launchpad-snapshot-collector --apply
```

Then run `sudo systemctl daemon-reload`. The same `--apply` flag runs a one-off
physical collection. Removing this override returns the timer to reports only.

Apply skips busy hosts. If old unused layers exist, it drains the selected API
writers, checks that no VM or other work appeared, stops the stock orchestrator,
and holds the native catalogue static during deletion. Active VMs are never paused
to create a cleanup window. Only captured service IDs are restarted afterward.
Unknown files, symlinks, unresolved cache references and missing retained headers
are preserved or cause refusal. Confirmed deletions are recorded in the journal;
an error must not be interpreted as a successful collection or service recovery.

Before stopping services, apply writes a durable maintenance receipt beside the
journal. After an interruption, the next apply invocation recovers those exact
service IDs before considering another collection. Once restoration has begun,
recovery only restarts services; it never stops them again. Keep the journal and
its `.maintenance.json` sibling together. Setup and startup refuse an unfinished
maintenance receipt; run the collector with `--apply` and the original configuration
to recover those exact services before retrying them. A replaced container or changed
storage configuration requires operator review rather than automatic recovery.
All apply invocations share one host-wide lock, including invocations using a
different configuration file.

The host must be exclusively operated through this deployment. Additional E2B
writers, external controllers and direct orchestrator clients require a separate
coordination design. Stop the timer before changing the deployment or storage
configuration. Inspect refusals with:

```sh
sudo journalctl --all -u launchpad-thread-vm-collection.service
```
