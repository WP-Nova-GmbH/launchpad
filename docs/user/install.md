# Install Launchpad

Launchpad is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the Launchpad server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the Launchpad server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

Download the installer for your platform from the latest
[GitHub Release](https://github.com/WP-Nova-GmbH/launchpad/releases/latest):

- macOS: the `.dmg` for Apple Silicon (`arm64`) or Intel (`x64`)
- Windows: the `.exe` installer
- Linux: the `.AppImage`

The desktop app checks for new releases on its own and shows an update button when one is
available. See [Keeping Launchpad in Sync](./updating.md).

## Providers

Launchpad drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
Launchpad looks for, but authenticate with `agent login`, not `cursor-agent login`.

After the CLI is installed, open **Settings** → **Providers** and choose **Sign in** on its card.
Launchpad runs that provider's own account-login command on the selected environment and shows the
browser link or device code it returns. You can still run the command from the table yourself; run
it on the machine hosting that environment, not on the phone or laptop you happen to browse from.

Account sessions stay on the environment where you created them. Signing in to one remote machine
does not copy the session to another machine, and **Sign out** removes only that environment's
provider session. API keys and external provider credentials remain separate from this account-login
flow.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started Launchpad.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
Launchpad. You can install Launchpad, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much Launchpad asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping Launchpad in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
