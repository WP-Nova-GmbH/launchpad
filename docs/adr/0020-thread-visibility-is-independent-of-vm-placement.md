---
status: accepted
---

# Thread visibility is independent of VM placement

The planned per-thread VM mode supports both private and shared threads, preserving their
visibility when execution moves into a VM because moving work must not implicitly publish a
personal conversation to repository members. Private and shared VMs use the same allocation
limits and lifecycle rules; VM allocation ownership and infrastructure policy administration
do not themselves grant access to private thread content. Changing a thread's sharing is a
separate explicit action, and its visibility must also govern saved conversation state and
disk backups rather than inheriting the legacy organization-machine access policy.
