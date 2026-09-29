# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires
Node 24 (`^24.13.1`); `vp` selects the Node.js and pnpm versions configured by the project.
Bun is optional. Run commands from the repository root unless noted otherwise:

```sh
vp env exec node --version
vp i
```

The version check should report Node 24 even if your system's `node` uses another version.
Run `vp i` again after pulling dependency changes.

Local desktop and browser development work without an `.env` file. The `T3CODE_*`
settings retain names inherited from T3 Code; they configure Launchpad and require no
separate T3 Code installation or environment.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Choose the command for the surface you are working on:

| Command                | What it starts                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `vp run dev:desktop`   | Electron, the web development server, and a desktop-managed backend.                            |
| `vp run dev`           | The browser app and backend.                                                                    |
| `vp run dev:share`     | The browser app and backend shared over Tailscale; see sharing below.                           |
| `vp run dev:mobile`    | Metro for an installed Expo development client; requires a separate reachable backend.          |
| `vp run dev:full`      | The browser app, backend, and local Connect relay; requires relay configuration and PostgreSQL. |
| `vp run dev:marketing` | The marketing website.                                                                          |

Desktop development builds the backend before opening Electron; allow the initial build to
finish. The desktop app starts its own backend, so `dev:desktop` is sufficient for that surface.
Linux also needs the [native desktop prerequisites](#linux-appimage-prerequisites).

For browser development, open the complete pairing URL printed by the dev runner, including
its token. The bare origin does not authenticate a new browser. Keep the terminal running
while you work; `Ctrl+C` stops the processes it started.

`dev:server` and `dev:web` start individual processes for specialized workflows. Use `dev`
for a complete browser environment.

Dev-runner flags go directly after the task name, for example
`vp run dev --home-dir /tmp/launchpad-dev`. Use `vp run dev --browser` to open a browser automatically.

Before running an agent, configure and authenticate a provider in **Settings → Providers**,
then add a project and start a thread. See [provider setup](../user/install.md#providers).

### Mobile development

Follow the [mobile setup guide](../../apps/mobile/README.md#development) to build and install
a native client matching this checkout. Expo Go is unsupported. Keep a Launchpad backend
running, then start `vp run dev:mobile` in a second terminal from the repository root.
This starts Metro for the development client; native builds and device selection follow the
mobile guide. Connect the client using the [remote access guide](../user/remote-access.md).

### Launchpad Connect

Connect is optional and disabled in a fresh clone. To use the hosted deployment configured
by this repository, copy `.env.example` to `.env` before starting or building. If `.env`
already exists, merge the required public settings instead. Restart development after changing
the configuration. Hosted Connect uses the existing relay service.

To develop the relay itself, configure `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in
`infra/relay/.env`. Start PostgreSQL with Docker Compose, apply the relay migrations from
the host, then start the apps:

```sh
docker compose up -d --wait
vp run --filter launchpad-relay db:migrate
vp run dev:full
```

Compose starts only PostgreSQL, binds it to loopback, and keeps its data in a named volume.
The development credentials above match the relay's defaults. Run migrations again after
pulling schema changes; Compose does not apply them. `db:migrate` loads `infra/relay/.env`
and uses `DEV_RELAY_DATABASE_URL`, falling back to the Compose database above.
Set `RELAY_DATABASE_URL` to explicitly override the migration target. Existing process
environment values take precedence over the `.env` file.

`vp run dev:full` runs the browser app, backend, and local relay on the host. To run only
the relay, use `vp run --filter launchpad-relay dev` from the repository root. The relay
defaults to HTTP port 8610 and a database on port 5433; use `DEV_RELAY_PORT` and
`DEV_RELAY_DATABASE_URL` to override those defaults.
For clients running on the same computer, set `T3CODE_RELAY_URL=http://127.0.0.1:8610` in the
root `.env` and use matching Clerk configuration. Restart the client dev process after changing
these values. HTTP is accepted only for loopback relay addresses; clients on other devices need
a reachable HTTPS relay URL. When exposing the relay through a tunnel, set `DEV_RELAY_ISSUER`
in `infra/relay/.env` to the same public origin. Desktop and mobile are separate processes.
See [Connect setup](./connect-setup.md) and the [relay documentation](../../infra/relay/README.md).

Stop PostgreSQL with `docker compose down`; its data survives the next startup.
To explicitly reset the development database, use `docker compose down -v`, then start it
and apply the migrations again. This deletes the Compose project's database volume.

For concurrent worktrees, choose a separate Compose project name and host port:

```sh
DEV_POSTGRES_PORT=5434 docker compose -p launchpad-feature up -d --wait
```

Set `DEV_RELAY_DATABASE_URL` in `infra/relay/.env` to use that port; update any explicit
`RELAY_DATABASE_URL` override too. Use the same `-p launchpad-feature` on later Compose
commands, including shutdown and reset. The project name isolates containers and
volumes; the port must also be free. Each running relay needs its own `DEV_RELAY_PORT`, with
the corresponding `T3CODE_RELAY_URL` in that worktree's root `.env`.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
Without a home override, the main checkout defaults to `~/.t3/dev`.
In the main checkout, `T3CODE_HOME` selects a different home; an explicit `--home-dir` wins
in both cases. An explicitly selected home's runtime state lives under `<home>/userdata`.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Sharing and remote debugging

`vp run dev:share` (equivalent to `vp run dev --share`) publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts) and
[Tailwind plugin](../../apps/web/vite/tailwind.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to Launchpad. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev:share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Build and run compiled apps

The `start` commands require existing build output and use normal application data defaults
rather than the dev runner's isolated setup. Use the `dev` commands for everyday development.

| App                         | Build first              | Run the build            |
| --------------------------- | ------------------------ | ------------------------ |
| Server with bundled web app | `vp run build:server`    | `vp run start`           |
| Desktop                     | `vp run build:desktop`   | `vp run start:desktop`   |
| Marketing website           | `vp run build:marketing` | `vp run start:marketing` |

`vp run build:web` compiles only the frontend assets. `vp run build` builds the server/web app,
desktop app, and marketing website. Native mobile builds follow the mobile guide; desktop
installers and their platform prerequisites are covered under [Desktop artifacts](#desktop-artifacts).

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
