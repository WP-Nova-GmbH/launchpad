---
status: accepted
---

# Organization machines share provider accounts; VM Codex sessions renew centrally

Organization machines and private thread VMs have different credential lifetimes. A long-lived
machine can keep a provider CLI's login store. Several disposable VMs cannot safely own copies
of one renewable session: concurrent refreshes can invalidate each other, and restoring a snapshot
can revive an older refresh token. The two paths therefore share sealed relay storage, but not
session ownership or credential delivery.

## Organization machines

The existing provider-account sharing model remains in place for enrolled agent executors.
An administrator shares a device's provider auth store or supplies an environment-variable
credential. The relay seals that payload with [RelaySecretBox](../../infra/relay/src/auth/SecretBox.ts).
Executors pull it and place it before building the provider instance; a version marker preserves
any local refresh until the administrator shares a replacement.

Provider CLIs own renewal on these machines. Copies can drift out of sign-in if a provider rotates
refresh tokens across consumers; sharing again remains the recovery path. That limitation is
accepted for this legacy delivery model. Personal environments do not receive these accounts.

Infisical was considered for executor-direct credential fetching, but was never introduced.
It would add a second secret system without solving ownership of a copied subscription session.
The relay stores sealed payloads rather than plaintext credentials; the encryption key must remain
separate from its database and must be retained or deliberately migrated during key rotation.

## Managed Codex for VMs

An administrator creates a dedicated organization ChatGPT session through Sign in with ChatGPT.
It is a new authorization grant, separate from a laptop's Codex cache and the machine-account
sharing above. One relay-owned connection serves multiple VMs; the relay alone serializes renewal
and persists replacement credentials. An uncertain renewal requires central reconnection rather
than another attempt with a potentially rotated refresh token.

VM preparation explicitly selects personal sign-in or that organization connection. Managed
Codex uses a native command-backed provider: its helper obtains only an access token after the
relay checks the current VM binding and permissions. The renewable session never enters the
bulk provider-account endpoint or a guest auth store. See the boundaries in
[the connection actions](../../infra/relay/src/http/CodexVmConnectionsApi.ts) and
[VM authorization](../../infra/relay/src/http/ThreadVmCodexAuthApi.ts).

Move, reset and restore carry the selected connection identity into the new authorized VM binding.
They obtain fresh authorization from that binding rather than trusting a saved guest's account
state. A missing or invalid managed selection blocks work; it cannot silently become personal
sign-in. Older guests must acknowledge support before a managed VM can finish preparation.
Reading a paused VM's account source uses relay metadata and does not wake it.

Disconnect invalidates new token delivery and attempts bounded upstream revocation. It does not
cancel running turns or erase access tokens already in process memory, including memory retained
in a snapshot. Unconfirmed revocation remains visible. Reconnecting the same account preserves
its connection identity; replacing it requires an explicit new VM selection and never silently
switches an active provider to another account.

The sign-in callback is supported only when the browser and Launchpad server share a computer.
The relay owns the exchange and renewable session; a temporary local bridge forwards the callback.
Remote authorization handoff is a separate capability, not a reason to open a callback on a VM or
copy a local Codex login into the relay.
