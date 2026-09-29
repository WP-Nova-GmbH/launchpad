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

## Managed compute

**Managed compute entitlement**:
A relay-owned organization flag that permits the organization to use managed compute. It is
disabled by default and may be changed directly in the relay database during the pilot.
_Avoid_: Enabled organization, machine flag
