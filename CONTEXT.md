# Launchpad Control Plane

Language for organization-governed work and managed compute in Launchpad.

## Collaboration

**Repository access**:
A person's current permission to use a repository's projects and shared threads in Launchpad.
It is separate from access to the machine that hosts them.

**Shared thread**:
A project's conversation and work history on an organization machine, shared by people with
repository access. Its work belongs to the organization, regardless of who started it.

**Shared prompt queue**:
A shared thread's ordered collection of accepted prompts waiting to reach its agent, visible to
everyone with access to the thread.
_Avoid_: Shared draft

**Accepted prompt**:
A prompt the environment has durably taken responsibility for as shared work, whether or not
workspace preparation or delivery to the agent has begun.

**Paused prompt queue**:
A shared prompt queue whose entries are retained but whose automatic delivery is suspended until
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

**Setup work**:
A workspace preparation's programs and background previews, retained as part of that preparation
after the initial setup command finishes. Docker-managed containers and system services have
a separate lifecycle.

**Event trigger**:
A repository workflow's rule selecting external events and filtering their issue context to
determine which occurrences start jobs.

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

## Managed compute

**Managed compute entitlement**:
A relay-owned organization flag that permits the organization to use managed compute. It is
disabled by default and may be changed directly in the relay database during the pilot.
_Avoid_: Enabled organization, machine flag
