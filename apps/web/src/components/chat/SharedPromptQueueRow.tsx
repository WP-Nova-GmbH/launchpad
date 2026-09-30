import type { ThreadPromptQueueEntry } from "@t3tools/contracts";
import { promptAttributionLabel } from "@t3tools/client-runtime/state/threads";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  EllipsisIcon,
  PaperclipIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, type RefObject } from "react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UserAvatar } from "./UserAvatar";

export function SharedPromptQueueRow({
  entry,
  index,
  isNext,
  disabled,
  canSteer,
  viewerId,
  editorRef,
  onEdit,
  onSteer,
  onRemove,
}: {
  entry: ThreadPromptQueueEntry;
  index: number;
  isNext: boolean;
  disabled: boolean;
  canSteer: boolean;
  viewerId: string | undefined;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  onEdit: () => void;
  onSteer: () => void;
  onRemove: () => void;
}) {
  const focusEditor = useRef(false);
  const attribution = promptAttributionLabel(entry);
  const authorName = entry.author?.displayName ?? "Teammate";
  const isOwn = entry.author !== undefined && entry.author.userId === viewerId;
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 border-t border-border/60 py-2 text-xs @min-[40rem]/shared-queue:grid-cols-[1rem_minmax(0,1fr)_auto]">
      <span className="flex justify-center pt-1 text-muted-foreground">
        {isNext ? (
          <>
            <ArrowRightIcon aria-hidden="true" className="size-3" />
            <span className="sr-only">Up next</span>
          </>
        ) : (
          index + 1
        )}
      </span>
      <div className="min-w-0 space-y-1.5 pt-1">
        <p className="whitespace-pre-wrap wrap-anywhere text-foreground/80">
          {entry.text || "Attachments"}
        </p>
        {entry.attachments.length > 0 ? (
          <ul aria-label="Attachments" className="space-y-1 text-muted-foreground">
            {entry.attachments.map((attachment) => (
              <li key={attachment.id} className="flex items-start gap-1">
                <PaperclipIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 wrap-anywhere">{attachment.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!entry.author && attribution ? (
          <p className="wrap-anywhere text-muted-foreground">{attribution}</p>
        ) : null}
        {entry.state !== "pending" ? (
          <p role="status" className="text-muted-foreground">
            {entry.state === "unknown" ? "Delivery outcome unknown" : "Sending to agent…"}
          </p>
        ) : null}
      </div>
      {entry.author || entry.state === "pending" ? (
        <div className="col-start-2 flex min-w-0 items-start justify-between gap-2 @min-[40rem]/shared-queue:col-start-3 @min-[40rem]/shared-queue:row-start-1 @min-[40rem]/shared-queue:justify-end">
          {entry.author ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    className="flex min-w-0 max-w-28 items-center gap-1.5 pt-1 text-muted-foreground outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={attribution ?? authorName}
                  />
                }
              >
                <UserAvatar
                  displayName={entry.author.displayName}
                  imageUrl={entry.author.imageUrl}
                  className="size-4"
                />
                <span className="flex min-w-0 items-baseline">
                  <span className="truncate">{isOwn ? "You" : authorName}</span>
                  {entry.editedBy ? (
                    <span aria-hidden="true" className="shrink-0">
                      *
                    </span>
                  ) : null}
                </span>
              </TooltipTrigger>
              <TooltipPopup>{attribution}</TooltipPopup>
            </Tooltip>
          ) : null}
          {entry.state === "pending" ? (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={disabled || !canSteer}
                onClick={onSteer}
              >
                <ArrowUpIcon />
                Steer
              </Button>
              <Menu
                onOpenChange={(open) => {
                  if (open) focusEditor.current = false;
                }}
                onOpenChangeComplete={(open) => {
                  if (!open && focusEditor.current) editorRef.current?.focus();
                }}
              >
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Actions for queued message ${index + 1}`}
                      disabled={disabled}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end" finalFocus={() => !focusEditor.current}>
                  <MenuItem
                    disabled={disabled}
                    onClick={() => {
                      focusEditor.current = true;
                      onEdit();
                    }}
                  >
                    <PencilIcon />
                    Edit
                  </MenuItem>
                  <MenuItem disabled={disabled} onClick={onRemove} variant="destructive">
                    <Trash2Icon />
                    Remove
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
