import { cn } from "~/lib/utils";

function initialOf(displayName: string | null): string {
  const trimmed = displayName?.trim() ?? "";
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : "?";
}

/** A teammate's picture, falling back to their initial. */
export function UserAvatar({
  displayName,
  imageUrl,
  className,
}: {
  readonly displayName: string | null;
  readonly imageUrl: string | null;
  readonly className?: string;
}) {
  const label = displayName ?? "Someone";
  if (imageUrl !== null) {
    return (
      <img
        src={imageUrl}
        alt={label}
        referrerPolicy="no-referrer"
        className={cn("inline-block shrink-0 rounded-full bg-muted object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[0.6em] font-semibold leading-none text-muted-foreground",
        className,
      )}
    >
      {initialOf(displayName)}
    </span>
  );
}
