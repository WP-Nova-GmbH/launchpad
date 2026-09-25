# Install Launchpad

Launchpad runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Launchpad and configure providers afterwards.

## Command line

The command line server needs Node.js `^22.16 || ^23.11 || >=24.10` on the machine
that runs it.

```bash
npx t3@latest
```

This starts the Launchpad server on your machine and opens the local web app.
Install it once with `npm install -g t3@latest` to get a `t3` command on your
`PATH`; the commands below assume that. With `npx`, prefix each of them with
`npx t3@latest` instead.

| Task                                             | Command                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                      |
| Start the server without a browser               | `t3 serve`                                                |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md)) |
| Move to the newest release                       | `t3 update`                                               |
| Remove it again                                  | `t3 uninstall`                                            |

Run `t3 --help` for the full reference.

## Desktop app

Download the installer for your platform from the latest
[GitHub Release](https://github.com/WP-Nova-GmbH/launchpad/releases/latest):

- macOS: the `.dmg` for Apple Silicon (`arm64`) or Intel (`x64`)
- Windows: the `.exe` installer
- Linux: the `.AppImage`

The desktop app checks for new releases on its own and shows an update button when one is
available. See [Updating Launchpad](./updating.md).

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. Launchpad installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

The Launchpad mobile app connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through Launchpad Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from Launchpad's provider settings.                          |

You can also choose **Sign in** on a provider's card. Launchpad runs that provider's own
account-login command on the selected environment and shows the browser link or device code it
returns. Account sessions stay on the environment where you created them: signing in to one
remote machine does not copy the session to another, and **Sign out** removes only that
environment's provider session. API keys and external provider credentials remain separate from
this account-login flow.

Provider CLIs must be on the server's `PATH`. If Launchpad cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

Launchpad warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Launchpad can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Launchpad does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

Members of an organization can skip provider sign-in on its managed executors: an admin signs in
once under **Settings → Organization**, and executors use that account. See
[Organizations](./organizations.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Organizations](./organizations.md): work with your team on shared repositories and executors.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Launchpad](./updating.md): update the app and connected servers.
