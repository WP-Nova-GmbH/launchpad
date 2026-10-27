# Launchpad Control Plane

Language for organization-governed work and managed compute in Launchpad.

## Client access

**Pairing code**:
A one-time invitation shared to authorize a client to access an environment. It grants client
access, not a verified person's identity.
_Avoid_: User login

**Client label**:
A human-readable, environment-specific name for a paired client, such as "Bob's iPad".
It distinguishes clients but does not verify the person using one.
_Avoid_: User name, verified identity

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

## Workflows

**Workflow**:
A repository-owned, named, ordered set of steps describing how work is carried out and
reviewed.

**Workflow copy**:
An independent workflow created from another workflow. Later edits to the source workflow
do not change its copies.

**Job**:
A single execution of a repository workflow under the definition used at its start.

**Job handoff**:
An offer of a job to its selected execution environment, awaiting confirmation of acceptance.
An uncertain handoff may still have started work.

**Job completion**:
A job's successful end, after its configured steps have finished and its setup work has stopped.

**Setup work**:
A workspace preparation's programs and background previews, retained as part of that preparation
after the initial setup command finishes. Docker-managed containers and system services have
a separate lifecycle.

**Event trigger**:
A repository workflow's rule selecting external events using issue details at the time of the
event. Later issue changes do not change which occurrences created existing jobs.

**Trigger occurrence**:
A distinct external event that matches a workflow's event trigger. Several occurrences may
refer to the same issue.

**Workflow execution environment**:
The environment selected to run a repository workflow's jobs.

**Workflow zone**:
A visual grouping derived from a workflow's steps that distinguishes automatic work from
each checkpoint requiring human intervention. Steps determine what happens; zones show it.

**Human checkpoint**:
A workflow step that pauses the work until a person responds, either by reviewing a result
or supplying required input.

**Checkpoint responder**:
A person eligible to answer a human checkpoint under that checkpoint's repository role
requirement.

**Review checkpoint**:
A human checkpoint for approving prepared work or requesting changes to it.

**Input checkpoint**:
A human checkpoint for supplying information required by later steps.

**Rework**:
A revision of prepared work in response to review feedback, carried out by its designated
earlier agent step. The revised work requires a fresh review.

## Issue trackers

**Integration application**:
Launchpad's registered identity with an external service, through which individual users can
independently authorize their own connections.
_Avoid_: Organization connection

**Issue-tracker connection**:
One Launchpad user's authorization to access a workspace or site in an external issue tracker.
Several users may connect to the same workspace or site without sharing their authorization.
_Avoid_: Organization connection, shared company account

**Automation connection**:
An authorization to use an external workspace or site as an event source for repository workflows.
It can be reused by repositories explicitly allowed by the connection's owner.

**Write approver**:
The owner of the personal issue-tracker connection used for a proposed change.
In a shared thread, another participant cannot approve a change through that connection.

**Linear workspace**:
The space in Linear that contains a company's teams and issues. It is distinct from a Launchpad
organization and from a project's filesystem workspace.
_Avoid_: Workspace when referring to Linear without qualification

**Linear team**:
A group within a Linear workspace that owns issues and their workflow. It is distinct from a
Launchpad organization or repository.
_Avoid_: Team when referring to Linear without qualification

**Issue context**:
The details, comment discussion, and embedded images from an external issue used to inform work
in a Launchpad thread. It is distinct from a Launchpad work item.
_Avoid_: Imported work item, synced issue

**Issue snapshot**:
The issue details preserved for a particular job at handoff. Later changes to the external
issue do not change that job’s instructions.

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
