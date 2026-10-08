import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  threadPresenceInitials,
  threadPresenceLabel,
  threadPresenceName,
  type ThreadPresencePerson,
} from "@t3tools/client-runtime/state/threadPresence";
import { useState } from "react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadPresencePeople, useThreadPresenceParticipants } from "../../state/threadPresence";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

function details(person: ThreadPresencePerson) {
  return [threadPresenceName(person), person.email, person.isSelf ? "You" : null]
    .filter(Boolean)
    .join(" · ");
}
function PresenceAvatar({ person }: { person: ThreadPresencePerson }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium ring-2 ring-card">
      {person.imageUrl && person.imageUrl !== failedImage ? (
        <img
          src={person.imageUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedImage(person.imageUrl)}
        />
      ) : (
        threadPresenceInitials(person)
      )}
    </span>
  );
}
type ThreadPresencePillProps = { readonly threadRef: ScopedThreadRef | null };

/** An open participant list belongs to one chat, even when its other viewers leave. */
export function ThreadPresencePill({ threadRef }: ThreadPresencePillProps) {
  return (
    <ThreadPresencePillContent
      key={threadRef ? threadKey(threadRef) : "none"}
      threadRef={threadRef}
    />
  );
}

function ThreadPresencePillContent({ threadRef }: ThreadPresencePillProps) {
  const people = useThreadPresencePeople(threadRef);
  const participants = useThreadPresenceParticipants(threadRef);
  const [open, setOpen] = useState(false);
  const label = threadPresenceLabel(people);
  if (!label && !open) return null;
  const typingLabel = people.some((person) => person.typing) ? label : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {label ? (
        <div className="mx-auto mb-2 w-fit max-w-full">
          <Tooltip>
            <TooltipTrigger
              render={
                <DialogTrigger
                  render={
                    <button
                      type="button"
                      className="flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-card px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                    />
                  }
                  aria-label={`View thread participants. ${label}`}
                />
              }
            >
              <span className="flex -space-x-1.5">
                {people.slice(0, 3).map((person) => (
                  <PresenceAvatar key={person.key} person={person} />
                ))}
              </span>
              {people.length > 3 ? <span>+{people.length - 3}</span> : null}
              {typingLabel ? (
                <span className="truncate" role="status">
                  {typingLabel}
                </span>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {people.map((person) => (
                <div key={person.key}>{details(person)}</div>
              ))}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Thread participants</DialogTitle>
          <DialogDescription>People and paired clients viewing this thread.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="space-y-4">
            {participants.map((person) => (
              <li key={person.key} className="flex items-start gap-3">
                <PresenceAvatar person={person} />
                <div className="min-w-0 flex-1 break-words">
                  <p className="text-sm font-medium">
                    {threadPresenceName(person)}
                    {person.isSelf ? (
                      <span className="ms-2 text-xs text-muted-foreground">You</span>
                    ) : null}
                  </p>
                  {person.email ? (
                    <p className="text-xs text-muted-foreground">{person.email}</p>
                  ) : null}
                  {person.userId && !person.displayName && !person.email ? (
                    <p className="text-xs text-muted-foreground">Account: {person.userId}</p>
                  ) : null}
                  {!person.userId ? (
                    <p className="text-xs text-muted-foreground">{person.clientDetails}</p>
                  ) : null}
                  {person.typing ? <p className="text-xs text-muted-foreground">Typing…</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
