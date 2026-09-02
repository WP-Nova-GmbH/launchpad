import { threadPresenceLabel } from "@t3tools/client-runtime/state/threadPresence";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadPresencePeople } from "../../state/threadPresence";
import { UserAvatar } from "./UserAvatar";

/** Who else is on this thread. Renders nothing when the viewer is alone. */
export function ThreadPresencePill({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const people = useThreadPresencePeople(threadRef);
  const label = threadPresenceLabel(people);
  if (label === null) return null;

  return (
    <div
      aria-label={label}
      className="pointer-events-none mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-foreground text-xs font-medium shadow-sm"
      role="status"
    >
      <div className="flex shrink-0 -space-x-1.5">
        {people.slice(0, 3).map((person) => (
          <UserAvatar
            key={person.key}
            displayName={person.displayName}
            imageUrl={person.imageUrl}
            className="size-4 ring-1 ring-card"
          />
        ))}
      </div>
      <span className="truncate">{label}</span>
    </div>
  );
}
