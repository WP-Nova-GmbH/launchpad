# Launchpad

Launchpad runs coding agents on your machine and lets you control them from a desktop,
web, or mobile app. It works with Claude Code, Codex, Cursor, Grok Build, OpenCode, and
Google Antigravity using your existing provider accounts.

To install a released app, follow the [installation guide](./docs/user/install.md).
To work on this repository, start below.

## Run from source

Run the following commands from the repository root. The checkout requires Node.js
24 (`^24.13.1`) and uses Vite+ (`vp`) with pnpm. `vp` manages the Node.js and package
manager versions configured in [package.json](./package.json).

### Install `vp`

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

Reopen your terminal, return to the repository root, and check the installation:

```bash
vp --version
vp env exec node --version
```

The second command should report Node 24, even if your system's `node` command uses
another version.

### Install dependencies

```bash
vp i
```

Run this on the first checkout and after pulling dependency changes.

### Start the desktop app

```bash
vp run dev:desktop
```

This builds the backend, starts the web development server, and opens Electron.
Allow the initial build to finish before expecting a window. The desktop app starts
its own backend, so this command is sufficient for local desktop development.

Keep the terminal running while you work. Stop it with `Ctrl+C`.

On Linux, desktop development also needs a C/C++ toolchain, `pkg-config`, and libsecret
headers. See the [platform prerequisites](./docs/operations/development.md#linux-appimage-prerequisites)
for installation commands.

### Start the browser app

For browser development, use:

```bash
vp run dev
```

This starts the backend and web development server. Open the complete **pairing URL**
printed in the terminal, including its token, to authenticate a new browser.
Use the printed URL and ports; occupied ports can change the selected values.
Add `--browser` to open the browser automatically: `vp run dev --browser`.

### Run your first agent

Open **Settings → Providers** to configure and authenticate a provider, then add a
project directory and start a thread. Launchpad can open before a provider is ready;
running an agent requires an installed, authenticated provider in that environment.
See [provider setup](./docs/user/install.md#providers) for installation and login details.

## Development commands

These commands run from the repository root:

| Command                | What it starts                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `vp run dev:desktop`   | Electron, the web development server, and a desktop-managed backend.                                                              |
| `vp run dev`           | The browser app and backend.                                                                                                      |
| `vp run dev:share`     | The browser app and backend, shared over Tailscale. Requires Tailscale setup; give the printed pairing URL to the remote browser. |
| `vp run dev:full`      | The browser app, backend, and a local Connect relay. Requires the relay configuration and database described below.               |
| `vp run dev:marketing` | The marketing website.                                                                                                            |
| `vp run dev:mobile`    | Metro for an installed Expo development client. Requires a separately running Launchpad backend; see mobile setup below.          |

`dev:server` and `dev:web` start individual processes for specialized workflows.
Use `dev` for a complete browser environment. Flags go directly after the task name,
for example `vp run dev --home-dir /tmp/launchpad-dev`.

The dev runner selects development state and ports. Leave `VITE_HTTP_URL` and
`VITE_WS_URL` unset, and never point a dev server at the live `~/.t3/userdata` directory.
See the [development runbook](./docs/operations/development.md) for state locations,
remote sharing, reusable browser authentication, and focused checks.

## Optional services and clients

### Launchpad Connect

Local desktop and browser development work without an `.env` file. Connect is
disabled in a fresh clone.

The `T3CODE_*` variables are Launchpad settings with names inherited from T3 Code.
They do not require a separate T3 Code installation or environment.

To use the hosted deployment configured by this repository, copy the public example
to `.env` in a fresh checkout, before starting or building:

```bash
cp .env.example .env
```

If you already have an `.env`, merge the required settings from
[.env.example](./.env.example). Restart development after changing the configuration.
Hosted Connect uses the existing relay service.

To develop the relay itself, `vp run dev:full` starts it alongside the browser app
and backend. It requires Clerk credentials in `infra/relay/.env` and the development
PostgreSQL database running on port 5433. Desktop and mobile are separate processes.
Set `T3CODE_RELAY_URL` in the root `.env` to that relay's reachable URL and use
matching Clerk configuration for the clients.
See [Connect setup](./docs/operations/connect-setup.md) and the
[relay documentation](./infra/relay/README.md) for configuration.

### Mobile

Mobile uses an Expo development client with native modules. Follow the
[mobile setup guide](./apps/mobile/README.md#development) to build and install a
matching client on an iOS simulator or Android emulator; Expo Go is unsupported.

Keep a Launchpad backend running, then start Metro in a second terminal from the
repository root:

```bash
vp run dev:mobile
```

Connect the mobile client to your environment using the
[remote access guide](./docs/user/remote-access.md).

## Build and run compiled apps

The `start` commands require existing build output. They use normal application
data defaults rather than the dev runner's isolated setup; use the `dev` commands
above for everyday development.

| App                         | Build first              | Run the build            |
| --------------------------- | ------------------------ | ------------------------ |
| Server with bundled web app | `vp run build:server`    | `vp run start`           |
| Desktop                     | `vp run build:desktop`   | `vp run start:desktop`   |
| Marketing website           | `vp run build:marketing` | `vp run start:marketing` |

Use `vp run build:web` to compile only the frontend assets.

`vp run build` builds the server/web app, desktop app, and marketing website. Mobile
native builds follow the mobile guide. For desktop installers such as a macOS DMG,
see [desktop artifacts and platform prerequisites](./docs/operations/development.md#desktop-artifacts).

## Documentation and contributing

- [Development runbook](./docs/operations/development.md): local setup, state, sharing, checks, and packaging.
- [Dev container](./docs/internals/devcontainer.md): VS Code and Codespaces setup.
- [User guides](./docs/README.md#using-launchpad): providers, projects, permissions, remote access, and updates.
- [Architecture overview](./docs/internals/overview.md): how the clients and server fit together.
- [Contribution policy](./CONTRIBUTING.md): read before reporting a bug or opening a pull request.

Launchpad is early software. Expect bugs; small fixes may be considered, while large
contributions are generally not being accepted. See the contribution policy for details.
