---
status: accepted
---

# Thread VM restoration preserves the disk

For the planned per-thread VM mode, restoring a deleted VM within its saved-disk retention
period preserves its whole saved disk, including installed tools, dependencies, and local
database files, because rebuilding only the repository would discard work users expect to
keep. Routine VM deletion while retaining the thread requires a completed native
full snapshot and an independently retained conversation checkpoint. Native E2B saves
the disk and RAM; Launchpad stops managed work and seals its execution gate before taking
that snapshot. Unexpected disk loss can only recover the latest completed backup.
An environment move transfers the
thread's work into a different environment rather than restoring the guest operating system
there, so restoration and moves need not share one persistence format.

Automatic VM backups wait for a safe idle point instead of interrupting active work. The
configured interval determines when a backup becomes due, not the maximum age of the latest
recovery point.

Physical snapshot cleanup is separate from backup retention and uses an external host
collector rather than E2B patches. The first version waits for the host to become idle,
then briefly stops its E2B writers; it never pauses active work to create a collection
window. Snapshot and template ancestry must remain protected throughout deletion.

Native E2B restoration boots immediately, so the relay commits the new placement
generation before requesting the restored VM. There is no inactive prepared VM or
offline recoverability probe. A completed backup records the immutable snapshot build
and the exact stopped source checkpoint; it does not claim a cold-boot or filesystem
repair certificate.

RAM restoration also resumes the old Launchpad coordinator and its old runtime identity.
A trusted guest bootstrap stops that exact coordinator, verifies and rebinds the closed
workload seal, and replaces the serving identity before enrollment and import. Only relay
activation opens the new execution gate. An uncertain create, pause or resume retains
capacity until its outcome is reconciled; an expired worker claim does not authorize
another dispatch or permission to resume through an unsettled pause.
These boundaries and the native runtime proofs do not replace the
[product restore release gate](../operations/e2b-host-setup.md#restore-release-gate).

The first version keeps saved disks outside individual VM allocations but may store them
on the same E2B host. Off-host backups and whole-host disaster recovery are deferred to
keep the initial deployment simple. Restoration requires the saved storage to survive;
losing that host's disk can lose both running VM data and saved copies.

## Consequences

Saved disks have a configurable expiry after routine VM deletion, without advance expiry warnings.

VM-backed workflow jobs retain a recoverable workspace while workflow ownership remains,
including long Review and Input waits or a failure with unresolved cleanup. Automatic pause and
saving may reclaim compute, but saved-disk expiry must neither remove that workspace nor prevent
its restoration until completion, cancellation or failure has safely released ownership.

After a workflow releases ownership and confirms cleanup, an already-running VM stays warm for
follow-up work; a paused or saved VM is not woken solely to provide that window.
Allow at least ten idle minutes from that release before reclaiming it for queued demand; new
work resets idleness and active or uncertain work remains protected. Otherwise the normal idle
timeout applies, with the follow-up window as a minimum. An old Review wait cannot make a newly
finished VM immediately eligible for pausing.

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
no longer recoverable after expiry. The initial Git baseline has independent thread-lifetime
retention: an uploaded bundle for a local move, or the pinned starting commit retained for a fresh
workflow VM. Reset VM can use that baseline without fetching the repository or reaching a local machine.
Changes made in the VM are not added to this reset baseline. A subsequent successful local-to-VM move
replaces the baseline only after its ownership cutover completes.
Reading the conversation does not renew retention; restoring its VM
cancels the expiry, and a fresh retention period begins when that VM is subsequently deleted.
A restoration already underway must retain access to its saved disk until the operation resolves.

Resetting the workspace retains queued entries but leaves their processing paused until a
thread participant explicitly resumes it, because those instructions may depend on files or
database state that the reset removed.
