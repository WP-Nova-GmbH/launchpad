# Release Checklist

> For maintainers. Using Launchpad? See [docs/user](../user/).

This document covers how Launchpad desktop releases are built, published, and picked up by
installed apps.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push a tag matching `v*.*.*`
  - manual `workflow_dispatch` with a version, optionally as a dry run
- Reads the production relay URL and Clerk client configuration from the `production` GitHub
  environment, so a release can never fall back to the development values in the repository `.env`.
- Runs lint, typecheck, and tests alongside the builds; publishing waits for every check.
- Builds the platform-independent JS (server bundle, web client, Electron main) once in the
  `build_bundle` job and hands it to every platform job as the `js-bundle` artifact.
- Builds six desktop artifacts in parallel on GitHub-hosted runners, each as its own job
  (`desktop_<platform>_<arch>`, one call of `release-desktop.yml`) on hardware of its own
  architecture:
  - macOS `arm64` and `x64` DMG
  - Linux `x64` and `arm64` AppImage and `.deb`, from one electron-builder run
  - Windows `x64` and `arm64` NSIS installer
- The Linux jobs also build the self-contained Linux CLI archive, which the same-arch Windows job
  embeds as its WSL runtime (see [Windows payload topology](#windows-payload-topology-and-update-validation)).
  The archive is not attached to the release; nothing is published to npm, AUR, Vercel, or Discord,
  and there is no nightly channel.
- Publishes one GitHub Release with all produced files.
  - Plain `X.Y.Z` tags are marked as the repository's latest release.
  - Tags with a suffix after `X.Y.Z` (for example `0.2.0-beta.1`) are published as GitHub
    prereleases and are ignored by installed apps on the stable track.
  - Release notes are generated automatically against the previous stable tag.
- Includes the Electron auto-update metadata (`latest*.yml` and `*.blockmap`) in the release
  assets. The release job merges the per-arch macOS and Windows manifests into one per platform.
  Installed apps poll this repository's releases; see [Desktop auto-update](#desktop-auto-update).
- Signing is optional and auto-detected per platform from secrets.

A **dry run** (`workflow_dispatch` with `dry_run` ticked) runs the gates and every platform build and
attaches the artifacts to the workflow run without creating a tag or a release. Use it to validate
the pipeline after changing the build script or the workflow.

## Cutting a release

1. Make sure `main` is green in CI and your checkout is on `main`, up to date with `origin/main`.
2. Run the release script with a bump keyword or an explicit version:

   ```sh
   vp run release patch          # 0.1.8 -> 0.1.9
   vp run release minor          # 0.1.8 -> 0.2.0
   vp run release 0.2.0-beta.1   # a prerelease installed apps ignore
   vp run release patch --dry-run
   ```

   It bumps the version in `apps/server`, `apps/desktop`, `apps/web`, and `packages/contracts`,
   refreshes the lockfile, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, and pushes the commit
   and tag together. It refuses to run off `main`, behind `origin/main`, with staged changes, or
   for a tag that already exists.

3. Watch the workflow: preflight and the quality checks pass, `build_bundle` and all six platform
   builds pass, the release job uploads the expected files.
4. Smoke test a downloaded artifact.

Installed apps on the previous version see the new release on their next update check. Pushing a
`vX.Y.Z` tag by hand also works; the script only adds the version commit and the safety checks.

## Pull request macOS previews

Labeling a PR `preview:mac` publishes a signed, notarized Apple Silicon DMG with Launchpad Connect
enabled to the rolling `desktop-preview` prerelease, and works for fork PRs. The label is a one-shot
request for the commit it is applied to: the trusted workflow removes it once the build is in hand,
and later pushes do not build until a maintainer applies it again. Every signed preview is therefore
a per-commit maintainer decision, which matters because the result carries the Developer ID
signature. Vouching a contributor lets their labeled commits be signed; it is not a standing grant.
The build is split so the Developer ID certificate never shares a job with PR code:

- `.github/workflows/desktop-macos-preview.yml` runs on `pull_request` with no secrets and builds
  only the JS bundle from the PR (the `js-bundle` artifact).
- `.github/workflows/desktop-macos-preview-publish.yml` runs on `workflow_run` from `main`. It
  refuses unless the PR is open, still labeled, its head is the built commit, and the author is a
  bot, a collaborator, or listed in `.github/VOUCHED.td` (read from the default branch, so a PR
  cannot vouch for itself). It then packages and signs the bundle through `release-desktop.yml`
  checked out at `main`, so packaging, native helpers, and the Electron/desktop dependencies come
  from `main`, not the PR. Only the version and the public Connect identifiers in `.env.example`
  are read from the PR commit, as data, so the signed app's passkey entitlement matches the bundle.
  A PR that changes packaging needs a dry run of the release workflow instead.

Before handing the bundle to the signing runner, the trusted workflow validates its ZIP entries and
accepts only regular files under `server/dist` and `desktop/dist-electron`, plus the directory
entries that lead to those roots. The artifact cannot overwrite packaging code or installed
dependencies. The bundle is copied into the app, never executed, on the signing runner. The
`pull_request_target` cleanup job in the publish workflow removes the download when the PR closes,
or when the label is removed by hand before a build consumed it, and never checks out PR code.

## Client configuration (`production` environment)

Required variables. These are public identifiers that ship inside the app, not secrets:

- `RELAY_URL`: the relay origin, `https://launchpad.wp-nova.ai`.
- `CLERK_PUBLISHABLE_KEY`: the relay's Clerk publishable key (`pk_live_…`).
- `CLERK_JWT_TEMPLATE`: the Clerk JWT template the relay verifies.

The same environment holds the relay deployment settings used by
`.github/workflows/deploy-relay.yml`. The relay is versioned and deployed separately from client
releases (see [infra/relay](../../infra/relay/README.md)); every client release must point at the
same relay so users see the same linked environments.

The relay reads `RELAY_TUNNEL_CLEANUP_MODE` (`off`, `dry-run`, or `enabled`; blank means `off`) at
deploy time, so changing it means a relay deploy, not a variable flip. Keep it `off` for the first
deploy of a relay that carries the tunnel reaper, release a server build that registers recovery,
watch `dry-run` sweep counters (`scanned`, `wouldDelete`, `skippedLegacy`, `skippedOrphan`,
`failed`, `truncated` on the `relay.managed_endpoint_reaper.sweep` span) across several sweeps, and
only then set `enabled`. To roll back, set it to `off` and redeploy before downgrading any host.
See [idle tunnel reclamation](../internals/t3-connect.md#idle-tunnels-are-reclaimed-and-recovered).

## Desktop auto-update

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- Update UX:
  - Background checks run on a startup delay and then on an interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to
    download, click again after download to restart and install.
- Provider: GitHub Releases of this repository (`provider: github`), resolved at build time from
  `GITHUB_REPOSITORY` in Actions or from `T3CODE_DESKTOP_UPDATE_REPOSITORY` (`owner/repo`). Local
  builds without either have no update feed and show updates as unavailable.
- Required release assets for the updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`) plus the macOS `.zip` update payloads
  - `latest.yml` (Windows, both architectures merged by the release job), `latest-mac.yml`
    (macOS, both architectures merged), `latest-linux.yml` (one per Linux architecture)
  - `*.blockmap` files for differential downloads
- **macOS requires signed and notarized builds for updates.** Squirrel.Mac refuses to install an
  update over an unsigned or ad-hoc-signed app, so an unsigned release still installs by hand but
  never auto-updates. The workflow prints a warning when it builds macOS unsigned.

## Server self-update invariant

Connected servers update to the client's exact version, not to a dist-tag. The **Update server**
action a client offers therefore targets the release matching the client's version. For a release
smoke test, connect the new client to a server on the previous version and verify that the update
action reconnects to the matching server. When the release adds database migrations, verify that
the remote update applies them and reconnects; a failed trial must restore the database snapshot
and restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and shows the exact command to run once on the server
machine.

## Signing credentials

### macOS (Developer ID + notarization)

Required secrets:

- `CSC_LINK`: base64 of the `Developer ID Application` certificate exported as `.p12`
- `CSC_KEY_PASSWORD`: the `.p12` export password
- `APPLE_API_KEY`: contents of an App Store Connect API key `.p8` (Team key)
- `APPLE_API_KEY_ID`: its Key ID
- `APPLE_API_ISSUER`: its Issuer ID

Checklist:

1. In the Apple Developer account, create a `Developer ID Application` certificate (App Store
   distribution certificates do not work for direct downloads or notarization).
2. Export the certificate with its private key as `.p12` from Keychain Access, base64-encode it,
   and store it as `CSC_LINK` with the password as `CSC_KEY_PASSWORD`.
3. In App Store Connect, create a Team API key and store its `.p8` contents, Key ID, and Issuer
   ID as the three `APPLE_API_*` secrets.
4. Run a dry run and confirm the log says `macOS signing enabled` and `notarization successful`.

Optional, only for passkey sign-in on macOS (Associated Domains entitlement):

- variable `APPLE_TEAM_ID`: the 10-character Team ID
- secret `MACOS_PROVISIONING_PROFILE`: base64 of a Developer ID provisioning profile for
  `com.t3tools.t3code` with Associated Domains enabled
- variable `CLERK_PASSKEY_RP_DOMAINS`: comma-separated override for the RP domains; by default
  the build derives the domain from the Clerk publishable key

### Windows (Azure Trusted Signing)

Required secrets:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Unsigned Windows installers still run and auto-update; they only trigger SmartScreen warnings.

### Linux

AppImages are not signed.

## Local builds

`pnpm run dist:desktop:dmg:arm64` (and the other `dist:desktop:*` scripts) produce the same
artifact locally. Export the production client configuration first, otherwise the build bakes in
the development relay from `.env`:

```sh
T3CODE_RELAY_URL=https://launchpad.wp-nova.ai \
T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_… \
T3CODE_DESKTOP_VERSION=0.2.0 \
T3CODE_DESKTOP_UPDATE_REPOSITORY=WP-Nova-GmbH/launchpad \
pnpm run dist:desktop:dmg:arm64
```

Output lands in `release/`. `T3CODE_DESKTOP_UPDATE_REPOSITORY` gives the local build the same update
feed as CI builds; leave it out for a build that must never offer updates.

## Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`t3-<version>-linux-<arch>.tar.gz`, the same arch as the Windows host) built by
the Linux desktop job (`cli_archive: true` in `release.yml`) and handed to the
Windows desktop build as `--wsl-runtime`, copied in verbatim. WSL verifies and
extracts that archive into `~/.t3/wsl-runtime/sha256-<archive-digest>` inside the
selected distro, then reuses it for later launches of the same update. The CLI
archive exists only for this hand-off: it is built for Linux, smoke-tested on its
build runner, and never attached to the GitHub Release.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `t3-<version>-linux-<arch>` directory holding `t3`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## Troubleshooting

- macOS build unsigned when expected signed:
  - Check all five Apple secrets are populated and non-empty.
  - Confirm the certificate is `Developer ID Application`, not `Apple Distribution`.
- Windows build unsigned when expected signed:
  - Check all Azure Trusted Signing secrets are populated and non-empty.
- Build fails with a signing error:
  - Run a dry run with the secrets removed to confirm the unsigned path still works.
  - Re-check certificate and profile names and tenant/client credentials.
- Installed app reports "no update feed is configured":
  - The build ran without `GITHUB_REPOSITORY` or `T3CODE_DESKTOP_UPDATE_REPOSITORY`. Install a CI
    build.
- Installed macOS app finds the update but fails to install it:
  - The running app or the release is unsigned. Sign the release and install it by hand once;
    later releases then update automatically.
