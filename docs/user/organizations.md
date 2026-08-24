# Organizations

An organization is the unit Launchpad Connect governs: who your teammates are, which repositories the
organization owns, and who may work in each one. You can find it under **Settings → Organization**
once you are signed in to Launchpad Connect.

You always belong to exactly one organization. If nobody has invited you into theirs, one is created
for you the first time you open the page, with you as its admin.

## Roles

Your standing in the organization is either **member** or **admin**. Admins manage people,
invitations, and the repository list. Members can see who else is in the organization.

Repositories carry a second, narrower role. A **maintainer** configures a repository — its keys and
who can reach it. A **developer** works in it. Having no role on a repository means having no access
to it, and it will not appear in your list at all.

Two rules exist so an organization cannot lock itself out: you cannot change your own role, and the
last admin cannot be removed.

## Inviting people

Admins can invite someone by email address and choose the role they will join with.

Launchpad does not send the email yet. When you create an invitation you get a **token** back — copy
it and send it to the person yourself, however you normally would. They paste it into
**Settings → Organization → Join another organization**.

The token works once, expires after a week, and can only be redeemed by someone signed in with the
email address you invited. Inviting the same address again replaces the earlier invitation, and you
can revoke a pending one at any time.

Joining an organization means leaving the one you are in. That only works while the organization you
are leaving is empty — no other members, no repositories — so accepting an invitation can never
abandon other people's work.

## Repositories

A repository is recognised by the git remote of a checkout, reduced to `host/owner/repo`. Every
checkout of the same repository, on any machine, resolves to the same entry.

One repository can answer to several of these keys, which is how mirrors and forks stay a single
repository instead of turning into three. Add the extra key to the repository and any checkout using
that remote is recognised. A repository always keeps at least one key.

Admins see every repository in the organization. Everyone else sees the ones they have a role on.

### What registering does, and what it does not

Registering a repository records it. It does not put code anywhere.

A **repository** is the organization's record of a codebase — its addresses, and who may work in
it. A **project** is one checkout of that repository on one machine, with files on a disk. They are
different things, and registering the first does not create the second.

So a newly registered repository appears under Settings → Organization, on Start, and in Add
Project's **Organization repositories** list. It will not show up in Connections, which lists
machines you can reach, or turn into a project by itself. Choosing it in Add Project still needs a
connected target machine on which to create the checkout.

What registering buys you: any checkout of that repository, on any machine, is recognised as the
same repository; you decide who may work in it; and work the organization runs on your behalf is
allowed only for people with a role on it.

### Checkouts that are not registered

If you have a project open whose repository nobody has registered, admins see it listed with a
**Register** button and the key already filled in. Nothing stops you working in an unregistered
checkout — a repository the organization has not registered is simply not governed by it.

What the organization does govern is work it runs for you: starting a job against a repository that
_is_ registered requires a role on that repository.

## Machines

Machines are computers the organization buys through Launchpad Connect. An **agent executor** runs work
for the organization; a **review host** is reserved for running review builds of your application
in a later release. Only admins provision and remove them; every member can see the list.

Provisioning takes a name and a role. The machine sets itself up and reports in on its own —
nobody signs in on it, and it can never be linked as somebody's personal environment. Until it
does, it shows as **Setting up** and the list refreshes itself; if it never manages to report in
within a day, it shows as **Enrollment expired** and the only fix is to destroy it and provision a
fresh one.

Once a machine is **Ready**, it appears to every member of the organization alongside their own
environments, so you can open projects and threads on it from any client, exactly as you would on
a machine of your own.

Its projects remain listed on Start when the machine is offline. They are labelled **Offline** and
cannot be opened until that machine reconnects. This retained catalog contains only project and
repository names plus the machine association; it does not sync files or chat history. Admins see
every cataloged project without a separate repository grant. Members see projects for repositories
on which they hold a role.

Provider account sessions belong to the machine, not to the member who opened the sign-in page.
From **Settings → Providers**, select the organization machine and sign in to Codex, Claude, or
Cursor there. Teammates who can operate that environment then use the same machine-local provider
session; the credentials themselves are never copied to their clients or to another machine. Use an
organization-owned provider account when access and billing should be shared, and provision a
separate environment when they should not be.

Destroying a machine destroys everything on it, including any projects and thread history it
holds — which is why the trash can asks for a second, labelled click. The organization has a limit
on how many machines it can hold at once; ask us to raise it when you hit it.
