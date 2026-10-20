# Launchpad Control Plane

Language for organization-governed work and managed compute in Launchpad.

## Collaboration

**Repository access**:
A person's current permission to use a repository's projects and shared threads in Launchpad.
It is separate from access to the machine that hosts them.

**Environment access**:
A person's authorization to use an environment and the capabilities it permits. Repository
access and moving a thread into that environment do not grant this authorization.

**Shared thread**:
A repository's organization-owned conversation and work history, regardless of who started it
or where it runs. Reading and operating it require repository access and the corresponding
permissions in its current environment.

**Private thread**:
A person's conversation and work history that only that person can access through Launchpad.
Its private status is independent of whether it runs locally or in a thread VM.

**Thread visibility**:
Whether a thread is private or shared. Changing its execution environment does not itself
change this classification.

**Shared thread queue**:
A shared thread's ordered collection of accepted work, including prompts and environment moves,
visible to everyone with access to the thread.
_Avoid_: Shared draft; shared prompt queue when the collection also contains environment moves

**Accepted prompt**:
A prompt the environment has durably taken responsibility for as shared work, whether or not
workspace preparation or delivery to the agent has begun.

**Paused thread queue**:
A shared thread queue whose entries are retained but whose automatic processing is suspended until
someone explicitly resumes it.

**Steering**:
An explicit request to deliver a queued prompt to the agent during its current turn, so it can
influence work already underway.

**Prompt author**:
The person who originally submitted a prompt, shown as "Submitted by". Editing or steering that
prompt does not change its original author.

**Prompt editor**:
The person who most recently changed a queued prompt's content, shown as "Edited by" alongside
its original submitter. Both remain attributed after the prompt reaches the agent.

## Managed compute

**Managed compute entitlement**:
A relay-owned organization flag that permits the organization to use managed compute. It is
disabled by default and may be changed directly in the relay database during the pilot.
_Avoid_: Enabled organization, machine flag

**Thread VM**:
A managed virtual machine dedicated to one private or shared thread, accessible according to
that thread's visibility and environment permissions.
_Avoid_: Project VM

**VM mode**:
The execution choice in which a thread uses its own thread VM. It is separate from the thread's
provider permission mode and does not by itself mean the thread is shared.
The first version enters VM mode by moving a local thread and uploading its checkout; the VM
does not obtain the repository from its remote.
_Avoid_: Remote mode, sandbox permission mode

**VM allocation owner**:
The person whose VM allowance includes a particular thread VM. Allocation ownership is separate
from ownership or visibility of the thread and from the agent account used for that work.
_Avoid_: Thread owner, billing account

**Environment move**:
A transfer of a thread's active execution location and working state from one environment to
another, preserving the identity of the conversation.
_Avoid_: Copy thread, switch account

**Thread VM restore**:
Recreation of a deleted thread VM from its saved disk state, including installed tools and local
data. It is distinct from moving the thread's work into another existing environment.

**VM reset**:
Recreation of a thread's VM and workspace from the Git commit uploaded during its local move while preserving its
conversation, including the agent's resumable conversation state. The user-facing action is "Reset VM".
_Avoid_: Restart VM, restore VM, start fresh
