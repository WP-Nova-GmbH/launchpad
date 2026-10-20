---
status: accepted
---

# Thread moves preserve destination access boundaries

For planned managed-thread moves, a person authorized to move the thread and use the destination
may move it there even when other participants lack destination access. The move grants no
environment permissions, so those participants cannot operate the thread on the destination
unless separately authorized. Requiring every participant to have destination access would let
the collaboration membership prevent someone from bringing their work onto their own machine.

## Reading and operating

Moves preserve the destination's separate read and operate permissions. Read-only access permits
conversation reads without authorizing commands; absence of read access blocks history loads and
live updates. A relay history copy must enforce the same access boundary rather than bypass the
destination, while still allowing authorized history reads when compute is offline or absent.

## Accepted work

The move carries already-accepted queue entries as shared work, preserving order and attribution
even when their authors lack destination access, consistent with
[ADR-0005](./0005-relay-owns-jobs-environments-own-threads.md). Destination permissions govern new
submissions, edits and steering; they do not retroactively discard accepted prompts or grant
their authors new access. Existing queue pauses remain in effect.
