---
status: accepted
---

# Workflow automation connections are organization-managed

For VM-backed repository workflows, organization admins manage automation connection,
reconnection, disconnection and explicit repository access. Repository maintainers configure
triggers using the connections their repository is allowed to use. This replaces the existing
person-owned management of native workflow sources; personal issue-tracker connections remain
separate. Connection administration follows the organization while workflow definitions remain
owned by repositories.

Linear automation uses a [workspace app installation](https://linear.app/developers/oauth-actor-authorization)
with its own identity. Jira Cloud initially uses
[user-authorized OAuth](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/),
accepting dependence on the authorizing Jira account's permissions to avoid a separate
site-installed app deployment. Organization management does not turn that Jira grant into an app
identity; another administrator reconnects by authorizing access again. Personal prompt
connections are not automatically shared with workflows.

The first version receives issue events and reads issue details only. Run progress is shown in
Launchpad, and GitHub publishing uses explicit workflow actions. Posting comments and changing
issue statuses are outside this version, keeping issue-tracker authorization and remote side
effects limited to what starting a workflow requires.
