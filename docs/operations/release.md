# Release Checklist

> For maintainers. Using Launchpad? See [docs/user](../user/).

This document covers how Launchpad desktop releases are built, published, and picked up by
installed apps.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push a tag matching `v*.*.*`
  - manual `workflow_dispatch` with a version, optionally as a dry run
- Runs quality gates first: lint, typecheck, test.
- Reads the production relay URL and Clerk client configuration from the `production` GitHub
  environment, so a release can never fall back to the development values in the repository `.env`.
- Builds four artifacts in parallel on GitHub-hosted runners:
  - macOS `arm64` DMG (`macos-15`)
  - macOS `x64` DMG (`macos-15-intel`)
  - Linux `x64` AppImage (`ubuntu-24.04`)
  - Windows `x64` NSIS installer (`windows-2025`)
- Publishes one GitHub Release with all produced files.
  - Plain `X.Y.Z` tags are marked as the repository's latest release.
  - Tags with a suffix after `X.Y.Z` (for example `0.2.0-beta.1`) are published as GitHub
    prereleases and are ignored by installed apps on the stable track.
  - Release notes are generated automatically against the previous stable tag.
- Includes the Electron auto-update metadata (`latest*.yml` and `*.blockmap`) in the release
  assets. Installed apps poll this repository's releases; see [Desktop auto-update](#desktop-auto-update).
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

3. Watch the workflow: preflight passes, all four builds pass, the release job uploads the
   expected files.
4. Smoke test a downloaded artifact.

Installed apps on the previous version see the new release on their next update check. Pushing a
`vX.Y.Z` tag by hand also works; the script only adds the version commit and the safety checks.

## Client configuration (`production` environment)

Required variables. These are public identifiers that ship inside the app, not secrets:

- `RELAY_URL`: the relay origin, `https://launchpad.wp-nova.ai`.
- `CLERK_PUBLISHABLE_KEY`: the relay's Clerk publishable key (`pk_live_…`).
- `CLERK_JWT_TEMPLATE`: the Clerk JWT template the relay verifies.

The same environment holds the relay deployment settings used by
`.github/workflows/deploy-relay.yml`.

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
  - platform installers (`.exe`, `.dmg`, `.AppImage`) plus the macOS `.zip` update payloads
  - `latest.yml` (Windows), `latest-mac.yml` (macOS, both architectures merged by the release
    job), `latest-linux.yml`
  - `*.blockmap` files for differential downloads
- **macOS requires signed and notarized builds for updates.** Squirrel.Mac refuses to install an
  update over an unsigned or ad-hoc-signed app, so an unsigned release still installs by hand but
  never auto-updates. The workflow prints a warning when it builds macOS unsigned.

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
the archive in place through Electron. WSL cannot read ASAR files, so enabling
the WSL backend extracts the server tree once into the desktop state directory
under `wsl-server-tree/<version>` and reuses the completed version until the app
is updated.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
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
