---
status: accepted
---

# Thread VM restoration preserves the disk

For the planned per-thread VM mode, restoring a deleted VM within its saved-disk retention
period preserves its whole saved disk, including installed tools, dependencies, and local
database files, because rebuilding only the repository would discard work users expect to
keep. Routine VM deletion while retaining the thread requires a verified,
recoverable final save; running processes and memory are not restored, and unexpected disk loss
can only recover the latest successful backup. An environment move transfers the
thread's work into a different environment rather than restoring the guest operating system
there, so restoration and moves need not share one persistence format.

Cold boot alone is not an execution fence: systemd services and other saved startup
hooks can run even when RAM is discarded. Recovery must prevent those workloads
from executing until placement ownership is committed. Unmodified E2B snapshot
recovery fails this constraint. Offline preparation prevents startup while a disk
is being inspected, but ordinary systemd activation can still run saved services.
A recoverability probe must use a trusted boot path that does not execute those
services. Only committed placement may authorize an ordinary workload boot.
The pinned prepared-restore protocol and its runtime proofs do not replace
the [product restore release gate](../operations/e2b-host-setup.md#restore-release-gate).

The first version keeps saved disks outside individual VM allocations but may store them
on the same E2B host. Off-host backups and whole-host disaster recovery are deferred to
keep the initial deployment simple. Restoration requires the saved storage to survive;
losing that host's disk can lose both running VM data and saved copies.

## Consequences

Saved disks have a configurable expiry after routine VM deletion, without advance expiry warnings.
Explicitly deleting the thread instead stops its work and removes its dedicated VM and saved
disks without that retention period or a final recovery save. Its confirmation must explain
that VM-only work is lost; retaining a recoverable conversation is the purpose of archive.
Conversation history and the provider state required to resume it must be preserved separately
from the expiring disk, so **Reset VM** can recreate the workspace while retaining the agent
conversation. Uploaded screenshots and file attachments follow the thread's lifetime and remain
readable under its access rules after disk expiry; keeping only message text would leave the
conversation incomplete. This requires independent attachment storage as well as verified
provider-specific transfer support; existing resume
cursors alone do not establish portability. Workspace data stored only on the saved disk is
no longer recoverable after expiry. The original uploaded Git bundle has independent thread-lifetime
retention, so Reset VM can use that commit without fetching the repository or reaching the local machine.
Changes made in the VM are not added to this reset baseline. A subsequent successful local-to-VM move
replaces the baseline only after its ownership cutover completes.
Reading the conversation does not renew retention; restoring its VM
cancels the expiry, and a fresh retention period begins when that VM is subsequently deleted.
A restoration already underway must retain access to its saved disk until the operation resolves.

Resetting the workspace retains queued entries but leaves their processing paused until a
thread participant explicitly resumes it, because those instructions may depend on files or
database state that the reset removed.
