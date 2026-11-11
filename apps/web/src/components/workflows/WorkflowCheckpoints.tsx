import {
  WORKFLOW_RESPONSE_SUMMARY_COUNT_LIMIT,
  WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT,
  type WorkflowResponseSummary,
  type WorkflowStep,
} from "@t3tools/contracts/workflows";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  MessageSquareIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { parseTimestampDate } from "../../timestampFormat";
import { Button } from "../ui/button";

type Response = typeof WorkflowResponseSummary.Type;

const responseOutcomes = {
  input: { label: "Answered", Icon: MessageSquareIcon, tone: "" },
  request_changes: {
    label: "Changes requested",
    Icon: RotateCcwIcon,
    tone: "text-warning-foreground",
  },
  approve: { label: "Approved", Icon: CheckIcon, tone: "text-success-foreground" },
} satisfies Record<Response["operation"], { label: string; Icon: typeof CheckIcon; tone: string }>;

const responseTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function WorkflowCheckpointHistory({
  responses,
  steps,
  accountId,
}: {
  responses: readonly Response[] | undefined;
  steps: readonly WorkflowStep[] | undefined;
  accountId: string;
}) {
  if (!responses?.length) return null;

  // Group adjacent responses without moving a later decision ahead of intervening checkpoints.
  const groups: Response[][] = [];
  for (const response of responses) {
    const previous = groups.at(-1);
    if (previous?.[0]?.stepId === response.stepId) previous.push(response);
    else groups.push([response]);
  }

  return (
    <details className="group rounded-lg border bg-muted/20 text-sm wrap-anywhere">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-4 py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground group-open:rotate-90"
        />
        Checkpoint history
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {responses.length >= WORKFLOW_RESPONSE_SUMMARY_COUNT_LIMIT
            ? `${responses.length} recent responses`
            : `${responses.length} ${responses.length === 1 ? "response" : "responses"} in history`}
        </span>
      </summary>
      <ol className="divide-y border-t">
        {groups.map((group) => {
          const first = group[0]!;
          const title = steps?.find((step) => step.id === first.stepId)?.title ?? "Checkpoint";
          return (
            <li key={`${first.checkpointId}:${first.operation}`} className="space-y-2 px-4 py-3">
              <h2 className="font-semibold">{title}</h2>
              <ol className="space-y-3">
                {group.map((response) => {
                  const { label, Icon, tone } = responseOutcomes[response.operation];
                  const date = parseTimestampDate(response.createdAt);
                  return (
                    <li
                      key={`${response.checkpointId}:${response.operation}`}
                      className={cn("space-y-1", group.length > 1 && "border-l pl-3")}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className={cn("inline-flex items-center gap-1.5 font-medium", tone)}>
                          <Icon aria-hidden className="size-3.5 shrink-0" />
                          {label}
                        </span>
                        {response.operation !== "input" || response.generation > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            Attempt {response.generation + 1}
                          </span>
                        ) : null}
                      </div>
                      {response.text ? (
                        <div>
                          {response.text.length >= WORKFLOW_RESPONSE_SUMMARY_TEXT_LIMIT ? (
                            <p className="text-xs text-muted-foreground">Response preview</p>
                          ) : null}
                          <p className="whitespace-pre-wrap">{response.text}</p>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{response.userId === accountId ? "You" : response.userId}</span>
                        {date ? (
                          <time dateTime={response.createdAt}>{responseTime.format(date)}</time>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export interface RetainedCheckpointDraft {
  readonly id: string;
  readonly text: string;
  readonly deliveryUnconfirmed: boolean;
}

function DraftRow({
  draft,
  label,
  onDiscard,
  onFocusedRemoval,
}: {
  draft: RetainedCheckpointDraft;
  label: string;
  onDiscard: (draft: RetainedCheckpointDraft) => void;
  onFocusedRemoval: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<RetainedCheckpointDraft | null>(null);
  const labelId = useId();
  const promptId = `${labelId}-discard`;
  const draftTextId = `${labelId}-text`;
  const [expanded, setExpanded] = useState(false);
  const previewText = draft.text.replaceAll(/\r\n?/g, "\n");
  const preview = Array.from(previewText.split("\n", 3).join("\n")).slice(0, 240).join("");
  const hasMore = preview !== previewText;
  const rowRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      return () => {
        if (node.contains(node.ownerDocument.activeElement)) onFocusedRemoval(draft.id);
      };
    },
    [draft.id, onFocusedRemoval],
  );
  const [copyFailed, setCopyFailed] = useState(false);
  const focusAction = useRef(false);
  const discardButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "checkpoint draft",
    onCopy: () => setCopyFailed(false),
    onError: () => setCopyFailed(true),
  });

  useLayoutEffect(() => {
    if (!focusAction.current) return;
    focusAction.current = false;
    (confirming ? keepButton : discardButton).current?.focus();
  }, [confirming]);

  const confirmDiscard = (entry: RetainedCheckpointDraft | null) => {
    focusAction.current = true;
    setConfirming(entry);
  };

  return (
    <div
      ref={rowRef}
      role="group"
      aria-labelledby={labelId}
      className="space-y-2 border-t px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={labelId} className="font-semibold">
          {label}
        </h3>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {draft.deliveryUnconfirmed ? "Delivery unconfirmed" : "Unsent"}
        </span>
      </div>
      <p id={draftTextId} className="rounded-md bg-muted/40 px-3 py-2 whitespace-pre-wrap">
        {hasMore && !expanded ? `${preview.trimEnd()}…` : draft.text}
      </p>
      {hasMore ? (
        <Button
          size="compact"
          variant="ghost-muted"
          aria-controls={draftTextId}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show preview" : "Show full draft"}
        </Button>
      ) : null}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p id={promptId}>Discard this draft?</p>
          <Button
            ref={keepButton}
            aria-describedby={promptId}
            size="compact"
            variant="outline"
            onClick={() => confirmDiscard(null)}
          >
            Keep draft
          </Button>
          <Button
            size="compact"
            variant="destructive-outline"
            aria-describedby={promptId}
            onClick={() => {
              confirmDiscard(null);
              onDiscard(confirming);
            }}
          >
            Discard draft
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="compact"
            variant="outline"
            onClick={() => {
              setCopyFailed(false);
              copyToClipboard(draft.text);
            }}
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {isCopied ? "Copied" : "Copy draft"}
          </Button>
          <Button
            ref={discardButton}
            size="compact"
            variant="ghost-muted"
            onClick={() => confirmDiscard(draft)}
          >
            Discard draft
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {copyFailed
              ? hasMore && !expanded
                ? "Could not copy. Show the full draft to select and copy it."
                : "Could not copy. Select the draft text to copy it."
              : null}
          </span>
        </div>
      )}
    </div>
  );
}

export function WorkflowUnsentDrafts({
  drafts,
  onDiscard,
  onRestore,
  fallbackFocus,
}: {
  drafts: readonly RetainedCheckpointDraft[];
  onDiscard: (draft: RetainedCheckpointDraft) => boolean;
  onRestore: (draft: RetainedCheckpointDraft) => boolean;
  fallbackFocus?: RefObject<HTMLElement | null>;
}) {
  const [discarded, setDiscarded] = useState<{
    draft: RetainedCheckpointDraft;
    canUndo: boolean;
  } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const focusAfterRemoval = useRef<{ draftId: string | null } | null>(null);
  const discardForUndo = useRef<string | null>(null);
  const markFocusedRemoval = useCallback((draftId: string | null) => {
    focusAfterRemoval.current = { draftId };
  }, []);

  useLayoutEffect(() => {
    const removal = focusAfterRemoval.current;
    const discardedId = discardForUndo.current;
    focusAfterRemoval.current = null;
    discardForUndo.current = null;
    if (!removal) return;

    const undoTarget =
      discardedId !== null && removal.draftId === discardedId ? undoButton.current : null;
    const target = undoTarget ?? heading.current ?? fallbackFocus?.current;
    if (target && target.ownerDocument.activeElement === target.ownerDocument.body) target.focus();
  });

  if (!drafts.length && !discarded) return null;

  return (
    <section
      className="rounded-lg border bg-muted/20 text-sm wrap-anywhere"
      aria-label="Earlier checkpoint drafts"
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 ref={heading} tabIndex={-1} className="font-medium">
          {drafts.some((draft) => draft.deliveryUnconfirmed)
            ? "Checkpoint drafts"
            : "Unsent drafts"}
        </h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
        </span>
      </div>
      {drafts.map((draft, index) => (
        <DraftRow
          key={draft.id}
          draft={draft}
          label={drafts.length > 1 ? `Earlier response ${index + 1}` : "Earlier response"}
          onFocusedRemoval={markFocusedRemoval}
          onDiscard={(entry) => {
            if (onDiscard(entry)) {
              discardForUndo.current = entry.id;
              setDiscarded({ draft: entry, canUndo: true });
            }
          }}
        />
      ))}
      {discarded ? (
        <div className="flex flex-wrap items-center gap-3 border-t px-4 py-3">
          <p role="status">
            {discarded.canUndo ? "Draft discarded" : "This draft can no longer be restored."}
          </p>
          {discarded.canUndo ? (
            <Button
              ref={undoButton}
              size="compact"
              variant="outline"
              onClick={() => {
                markFocusedRemoval(null);
                if (onRestore(discarded.draft)) setDiscarded(null);
                else setDiscarded({ ...discarded, canUndo: false });
              }}
            >
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
