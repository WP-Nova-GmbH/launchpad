# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud
identity and relay credentials belong to a separate trust boundary, described in
[Launchpad Connect](./t3-connect.md). A relay token is never an environment login.

## Authority survives transport changes

Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow
that grant but cannot widen it. Ordinary pairing does not grant access-management
or relay-management authority. Creating another pairing link requires both
`access:write` and every scope being delegated. The
[auth handlers](../../apps/server/src/auth/http.ts) enforce this at issuance;
client labels and device metadata have no authorization role. Redeeming a one-time
code is the authorization step; the receiving client confirms its own name before
redemption. That editable label never supplies a verified account identity.
Verified email is transient session/presence presentation and is omitted from
durable command authors.

The access read model contains pairing metadata, never recoverable pairing
secrets. Only the creation response returns the raw credential. Otherwise read
access to the connections list would become a way to acquire another client's
authority.

Browser cookies, bearer tokens, and DPoP tokens adapt the same scoped session
model. DPoP binds a token to a client's proof key; an invalid proof must fail
rather than fall back to bearer authentication. The OAuth token-exchange
vocabulary gives these grants a familiar meaning, but the environment does not
implement a general-purpose OAuth authorization server.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. Browser sessions can
authenticate the upgrade with their cookie. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts).

Desktop restarts forget the previous local bearer token, so its reusable
bootstrap grant replaces earlier sessions for the same subject and method.
Revocation and insertion share a [database
transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed
replacement must leave the old credential usable. Pairing and browser sessions
do not follow this replacement rule.

### Reusable dev credential

Web development environments can accept one `T3CODE_DEV_AUTH_TOKEN` across
worktrees and ports on one hostname. The token and startup URLs that contain it
grant administrative access. Desktop and non-development servers ignore it. See
the [development runbook](../operations/development.md#reusable-dev-credential)
for setup.

Each environment hashes the value and seeds its own database record at startup.
Environments do not share SQLite data, signing keys, environment IDs, session
records, pairing grants, or revocation state. Local revocation persists after
restart and does not affect another worktree. Removing or rotating the value
and restarting invalidates the old credential and its WebSocket tickets.

Normal credentials keep precedence. A rejected normal credential never falls
back to the reusable credential. OAuth exchanges create ordinary local bearer
or DPoP children with normal expiry and revocation. The reusable cookie expires
after 30 days.

## The environment is the filesystem boundary

Organization machines retain this shared filesystem boundary under
[ADR-0017](../adr/0017-shared-machines-remain-trusted-environments.md). Repository-scoped thread
permissions do not introduce per-repository agent sandboxes.

Projects are organizational boundaries, not filesystem sandboxes.
`orchestration:read` permits reading files the server account can read, including
absolute paths outside a project. This lets clients display artifacts that an
agent writes in a temporary directory. Relative paths and writes still follow
the [workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

On personal environments, signed asset URLs are bearer credentials. Organization environments
also bind them to the issuing session and recheck current repository access; removing a grant or
revoking that session invalidates subsequent access through the URL. A URL for media on the host
grants access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.

## Session user

A session can carry a relay-verified `AuthSessionUser`. Remote connections receive
it through the signed mint proof. Personal desktop environments can also attach
it to a desktop-bootstrap session by verifying the current account with the
server-configured relay. This does not require publishing or linking the environment.
Ordinary paired and CLI-issued sessions remain anonymous.

Identity attachment preserves the local session's permissions. It is unavailable
on organization environments, where identity participates in repository access.
Replacement revokes exactly the previous session and drains its open sockets;
a socket captures its actor at upgrade, so changing stored credentials alone
would leave it submitting as the previous person. A failed database replacement
keeps the previous session valid.

Signing out detaches identity locally without contacting the relay. A temporary
relay outage leaves an already verified local session unchanged; new or renewed
sessions remain anonymous until verification succeeds. Historical messages and
accepted queued prompts retain their original author.

Two things read it: the WebSocket dispatch handler stamps it as the `author` of a
`thread.turn.start` command, which the decider copies onto `thread.message-sent`
and the projector onto `OrchestrationMessage.author`; and thread presence
(`orchestration/ThreadPresence.ts`) attaches it to whichever thread the
connection reports being on. The identity is authenticated data — clients cannot
supply an author over the wire.
