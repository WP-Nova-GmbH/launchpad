# Organizations

An organization is the unit T3 Connect governs: who your teammates are, which repositories the
organization owns, and who may work in each one. You can find it under **Settings → Organization**
once you are signed in to T3 Connect.

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

T3 Code does not send the email yet. When you create an invitation you get a **token** back — copy
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

So a newly registered repository appears under Settings → Organization and nowhere else. It will
not show up in Connections, which lists machines you can reach, or in Source Control, which is
about the tools installed on this machine, or in your project sidebar, which lists checkouts that
actually exist.

What registering buys you: any checkout of that repository, on any machine, is recognised as the
same repository; you decide who may work in it; and work the organization runs on your behalf is
allowed only for people with a role on it.

### Checkouts that are not registered

If you have a project open whose repository nobody has registered, admins see it listed with a
**Register** button and the key already filled in. Nothing stops you working in an unregistered
checkout — a repository the organization has not registered is simply not governed by it.

What the organization does govern is work it runs for you: starting a job against a repository that
_is_ registered requires a role on that repository.
