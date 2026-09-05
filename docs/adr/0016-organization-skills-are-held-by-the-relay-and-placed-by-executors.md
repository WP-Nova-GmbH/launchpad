---
status: accepted
---

# Organization skills are held by the relay and placed by executors

An organization's **skills** — directories with a `SKILL.md` at the root, the shape Claude Code,
Codex, Cursor, and OpenCode all load — are uploaded once by an admin, held by the
[relay](../internals/glossary.md#relay) as plain files, and pulled by every enrolled agent
[executor](../internals/glossary.md#executor), which places a copy where each provider CLI reads
user-level skills. Nobody copies a skill onto a machine, and a machine that joins later needs
nothing done to it.

## Why

The know-how an organization wants its agents to share — how a review is done here, what a
release looks like, which checks run before a pull request — is exactly what skills carry. An
executor had only whatever happened to be on its disk, and on a provisioned machine that is
nothing. Every executor started ignorant, and keeping one current was the same by-hand chore that
the organization provider accounts amendment on
[ADR-0003](./0003-provider-credentials-are-fetched-by-executors-not-pushed.md) removed for sign-ins.

## Considered options

- **Skills in each repository** (`.claude/skills`, `.agents/skills` in the checkout). Already
  works and stays the right home for repository-specific skills. It cannot carry what applies
  organization-wide without committing the same files to every repository and keeping them in
  step.
- **Skills baked into the executor image.** Every change is an image build and a redeploy; a
  self-hosted machine has no image at all.
- **Skills held by the relay and pulled by executors** (chosen). The path already exists for
  provider accounts: the relay holds, executors fetch over their environment credential on a
  timer, drivers place at instance build, and a changed version rebuilds the instance. One upload
  reaches every executor, including ones that do not exist yet.

## How it works

- The relay keeps one row per skill name per organization in `relay_organization_skills`: the
  manifest's description, the files as JSON, and a `version` that changes on every save. Skills
  hold no secret, so nothing is sealed. Admins save and delete; any member may list. The payload
  schema requires a `SKILL.md`; the relay reads its frontmatter with the parser the server's own
  skill discovery uses and refuses, as invalid rather than as a conflict, a manifest that names a
  different skill or that the CLIs would not load.
- Enrolled agent executors fetch the set over their environment credential every five minutes and
  keep it in memory. Each driver places the set while building an instance, in the directory its
  CLI reads user-level skills from: Claude's config dir, Codex's shared home, OpenCode's config
  dir, and `~/.cursor`. A marker inside each placed directory records the version, so an
  unchanged skill is left alone, a changed one is replaced wholesale, and a removed one is
  deleted. A directory of the same name without the marker was installed by hand and is never
  touched.
- Personal machines receive nothing: the executor service is provided only to enrolled agent
  executors and everywhere else reads as "no skills"
  ([ADR-0007](./0007-the-org-layer-is-defaults-not-enforcement.md): on a person's own machine the
  person's skills win, and any opt-in follow-along is future work). Grok has no skills.

## Consequences

- Skills are text only and bounded — at most 64 files, 256 KiB each, 1 MiB together. Binary
  assets stay out; a skill that needs one fetches it from a repository instead.
- A skill is organization-wide. What belongs to one repository belongs in that repository, and the
  project scope keeps winning over the user scope on a name collision, as the CLIs already
  resolve it.
- Where each CLI reads user-level skills is taken from that CLI's documentation. Codex and Claude
  are exercised daily; OpenCode's and Cursor's directories have not been verified against a
  running agent on an executor and are the first thing to check if a skill does not appear there.
- A skill installed by hand on an executor under an organization skill's name shadows it on that
  machine, with a warning in the executor's log. The fix is to remove the hand-installed copy.
