# Launchpad Connect setup

Deployment and client configuration for Launchpad Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

Launchpad Connect is disabled in a fresh clone. To build against the production deployment, copy the
repository-root example:

```sh
cp .env.example .env
```

For another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, JWT template name, and relay URL.
Bundled servers also accept runtime overrides for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The stack's `PublishClientConfig` action writes the resulting relay URL back to the root `.env`.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the Launchpad CLI, using authorization-code exchange with PKCE.
2. Allow the redirect URI `http://127.0.0.1:34338/callback`.
3. Enable the `openid`, `profile`, `email`, and `offline_access` scopes.
4. Enable **Device authorization grant** on the application. Headless and SSH authorization use
   it, and Clerk only advertises the device endpoint once it is on. The feature is in beta and
   Clerk enables it per account on request.
5. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## JWT template

Create a Clerk JWT template named `t3-relay` with claims:

```json
{ "aud": "t3-code-relay" }
```

Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` for clients and
`CLERK_JWT_AUDIENCE=t3-code-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
t3code-dev://app/
t3code://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `t3code-dev://app`; production uses `t3code://app`. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries.
The Clerk Electron integration handles token
persistence and system-browser callback delivery.

## Android native sign-in redirects

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the app's publishable key, add each supported package to **Native applications > Allowlist for mobile SSO redirect**:

| Variant     | Callback                                      |
| ----------- | --------------------------------------------- |
| Development | `clerk://com.t3tools.t3code.dev.callback`     |
| Preview     | `clerk://com.t3tools.t3code.preview.callback` |
| Production  | `clerk://com.t3tools.t3code.callback`         |

Preserve existing entries. These callbacks are separate from the `t3code-dev` / `t3code-preview` / `t3code` navigation schemes. A private development build using the production Clerk key still needs its development callback allowed by that instance's administrator; rebuilding the same package does not change the allowlist.

## Desktop passkeys

For a production macOS app with bundle ID `com.t3tools.t3code`:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.com.t3tools.t3code`.
5. Configure signing as described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).

Local signed builds additionally use:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3CODE_PORT=13773 \
  "/Applications/Launchpad (Alpha).app/Contents/MacOS/Launchpad (Alpha)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/Launchpad (Alpha).app"
codesign -d --entitlements :- "/Applications/Launchpad (Alpha).app"
```

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.

## Personal issue trackers

Linear uses its official read-only MCP endpoint with OAuth dynamic client registration. No
`LINEAR_CLIENT_ID` or `LINEAR_CLIENT_SECRET` is needed. Each user connects Linear in Account → Connections; reads use that user’s Linear permissions.

The callback belongs to the relay, including when setup starts from a desktop or remote client:
`<relay issuer>/v1/user/issue-trackers/linear/callback`. For a local pilot, set
`DEV_RELAY_ISSUER` to the reachable relay origin and use an isolated `DEV_RELAY_DATABASE_URL`.
The relay registers its callback dynamically and requests only `read` access.

Existing connections from the previous static OAuth application must reconnect after upgrading.
Changing workspace requires explicit confirmation in Launchpad; the current connection stays
available during authorization. See [Linear's MCP documentation](https://linear.app/docs/mcp).

Jira also uses dynamic OAuth registration. Each user authorizes Atlassian
in Account → Connections and chooses a site when their account has access to several sites.
Reads use the permissions granted by that user’s account.

Both connections keep provider credentials on the relay. The initiating user authorizes each prompt for its environment and thread, so both local and managed environments can request reads. Former organization connections are retained but not used or reassigned; users must connect personally. Setup is available in web and desktop settings; chats can use the same personal connections from mobile. Issue writes, search, webhook-triggered jobs, and external OpenCode servers are not supported.

## Native Linear workflow connections

Native workflow authorization is independent of personal MCP issue-tracker connections. Configure
`LINEAR_WORKFLOW_CLIENT_ID` and, if the application uses one, `LINEAR_WORKFLOW_CLIENT_SECRET` on
the relay only. Both the Worker and Node development relay use these names. Register the exact
callback `<relay issuer>/oauth/workflow-sources/linear/callback`; the client never chooses its
origin. The flow requests only `read`, with a user actor and PKCE S256. A missing client ID leaves
source connection setup unavailable without preventing relay startup. No application secret belongs
in public client configuration.

Keep production native OAuth configuration absent until an authorized development application has
proven workspace identity, repeated consent, rotating refresh recovery, and independent authorization
for multiple owners, including two Launchpad accounts using the same Linear identity. Fixture tests
prove implementation behavior, not provider credential independence. If that evidence is unavailable
or fails, native connection release remains blocked; do not silently share provider credentials.

Event delivery has a separate release gate. The receiver is `POST
/webhooks/workflow-sources/linear` on the relay origin. In addition to the native client ID,
configure `LINEAR_WORKFLOW_WEBHOOK_SECRET` and `LINEAR_WORKFLOW_WEBHOOK_GENERATION` on the
relay only. Missing or partial configuration returns 503; native source management still works.
Rotate the generation whenever the signing secret or app subscription coverage changes. Both
relay entry points use these settings; keep the secret out of client bundles and diagnostics.

Keep `LINEAR_WORKFLOW_ADMISSION_ENABLED` absent or `false` in production. Before activation,
prove native authorization independence as above, then verify signed Issue create and status-entry
coverage for selected teams, including private teams and pre-existing authorizations, duplicate
subscriptions, actual retry timestamp behavior, and the exact app/workspace scope and timestamp
ordering of OAuth revocation. Do not activate production subscriptions to discover these facts.
Use an explicitly authorized development application. Fixture success cannot replace this evidence.

The receiver tracks observed create AND true status-entry delivery per team, current authorization
epoch and webhook generation. An existing connection can gain this evidence from new verified
post-activation deliveries; an API read or token exchange alone cannot establish it. Unsupported
teams remain blocked. Reauthorization clears old evidence while preserving source and grant identity;
repair must not revoke an installation used by other owners. The existing source label describes
observed teams and does not assert complete workspace coverage or enabled automatic execution.

Unknown occurrences require a signed body `webhookTimestamp` within 60 seconds. Authenticated
retries of a committed occurrence acknowledge without additional jobs even when stale. Linear
retry intervals exceed that window: verify that actual retries refresh their signed timestamp before
activation; otherwise revisit this policy before release. A 400 indicates invalid routing facts,
401 invalid signature/freshness, 413 a body over 1 MiB, and 500 an uncommitted admission failure.
Diagnostics must retain only the bounded failure code, never the body or signing/OAuth material.

Events commit all matching queued jobs or none. Successful and unmatched occurrences retain a
duplicate fence; reconfiguration never rematches them. Trigger authoring and automatic-start context
are subsequent slices: admitted jobs remain unoffered until that start path ships. Do not present
this receiver as production automatic execution or enable the admission flag before those slices
and the provider proof are complete.

An `invalid_client` or `unauthorized_client` error during token exchange/refresh is a service
configuration fault. Repair the application's configured credentials and retry the failed operation;
existing credentials and repository consent are retained. A confirmed invalid refresh grant instead
requires the connection owner to reconnect. Rotating application credentials does not require removing
repository grants. Keep callback query strings and token payloads out of diagnostics.
