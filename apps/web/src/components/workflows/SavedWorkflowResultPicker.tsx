import type { WorkflowSavedResult } from "@t3tools/contracts/workflows";
import { CheckIcon, ChevronDownIcon, HistoryIcon } from "lucide-react";
import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";

const savedTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const outcomes = { completed: "Completed", failed: "Failed", cancelled: "Canceled" };
const pageStatus = {
  loading: "Loading older results…",
  failed: "Couldn’t load older results",
  retrying: "Retrying…",
};

const formatSavedTime = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Save time unavailable" : savedTime.format(date);
};

function pickerOwnsFocus(trigger: HTMLButtonElement | null, popup: HTMLDivElement | null) {
  const active = (popup ?? trigger)?.ownerDocument?.activeElement;
  return !!active && (active === trigger || popup?.contains(active) === true);
}

export function SavedWorkflowResultPicker({
  results,
  selected,
  currentReview,
  stepTitle,
  onSelect,
  canLoadOlder,
  paging,
  onLoadOlder,
  onFocusBeforeRemoval,
}: {
  results: ReadonlyArray<WorkflowSavedResult>;
  selected: WorkflowSavedResult | null;
  currentReview: WorkflowSavedResult | null;
  stepTitle: (stepId: string) => string;
  onSelect: (id: string) => void;
  canLoadOlder: boolean;
  paging: keyof typeof pageStatus | null;
  onLoadOlder: () => void;
  onFocusBeforeRemoval: () => void;
}) {
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const removing = useRef(false);
  const reportFocusBeforeRemoval = useEffectEvent(onFocusBeforeRemoval);
  useLayoutEffect(() => {
    removing.current = false;
    return () => {
      removing.current = true;
      if (pickerOwnsFocus(trigger.current, popup.current)) reportFocusBeforeRemoval();
    };
  }, []);

  const search = query.trim().toLocaleLowerCase();
  const history = currentReview
    ? results.filter((result) => result.resultId !== currentReview.resultId)
    : results;
  const matches = search
    ? history.filter((result) => stepTitle(result.stepId).toLocaleLowerCase().includes(search))
    : history;
  const visibleResults = currentReview ? [currentReview, ...matches] : matches;
  const selectedTitle = selected ? stepTitle(selected.stepId) : "Choose a saved result";
  const failed = paging === "failed";
  const canPage = canLoadOlder && (!paging || failed);
  const earlier = currentReview ? "earlier " : "";
  const noMatches = canLoadOlder
    ? `No ${earlier}matches in loaded results`
    : `No matching ${earlier}results`;

  const renderResult = (result: WorkflowSavedResult) => (
    <ComboboxItem key={result.resultId} value={result}>
      <span className="grid min-w-0 flex-1 gap-0.5 py-0.5">
        <span className="wrap-anywhere font-medium">{stepTitle(result.stepId)}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <time dateTime={result.createdAt}>{formatSavedTime(result.createdAt)}</time>
          {result.resultId !== currentReview?.resultId ? (
            <span>{outcomes[result.outcome]}</span>
          ) : null}
        </span>
      </span>
      {selected?.resultId === result.resultId ? <CheckIcon aria-hidden /> : null}
    </ComboboxItem>
  );

  return (
    <div className="w-full min-w-0 sm:w-auto sm:max-w-96">
      <Combobox
        items={visibleResults}
        filter={null}
        value={selected}
        inputValue={query}
        onInputValueChange={(value, details) => {
          if (details.reason === "input-change") setQuery(value);
        }}
        itemToStringLabel={(result) => stepTitle(result.stepId)}
        isItemEqualToValue={(left, right) => left.resultId === right.resultId}
        onValueChange={(result) => {
          if (result) onSelect(result.resultId);
        }}
      >
        <ComboboxTrigger
          ref={trigger}
          render={<Button type="button" size="sm" variant="outline" />}
          aria-label={
            selected
              ? `Saved result: ${selectedTitle}, saved ${formatSavedTime(selected.createdAt)}`
              : "Saved result"
          }
          className="max-w-full"
        >
          <HistoryIcon aria-hidden />
          <span className="min-w-0 truncate">{selectedTitle}</span>
          <ChevronDownIcon aria-hidden />
        </ComboboxTrigger>
        <ComboboxPopup
          ref={popup}
          align="end"
          className="w-80"
          finalFocus={() => {
            // When the whole picker goes away, its parent owns focus recovery.
            if (removing.current) return false;
            const doc = trigger.current?.ownerDocument;
            return (
              !!doc &&
              (doc.activeElement === doc.body || pickerOwnsFocus(trigger.current, popup.current))
            );
          }}
        >
          <ComboboxSearchInput
            ref={searchInput}
            aria-label="Search loaded results"
            placeholder="Search loaded results…"
            autoComplete="off"
            spellCheck={false}
          />
          <ComboboxList>
            {currentReview ? (
              <div role="group" aria-label="Current review">
                <p aria-hidden className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  Current review
                </p>
                {renderResult(currentReview)}
              </div>
            ) : null}
            {matches.length > 0 ? (
              <div role="group" aria-label={currentReview ? "Earlier results" : "Saved results"}>
                {currentReview ? (
                  <p
                    aria-hidden
                    className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                  >
                    Earlier results
                  </p>
                ) : null}
                {matches.map(renderResult)}
              </div>
            ) : null}
          </ComboboxList>
          <ComboboxEmpty>{!currentReview && search ? noMatches : null}</ComboboxEmpty>
          <ComboboxStatus>
            {currentReview && search && matches.length === 0 ? noMatches : null}
          </ComboboxStatus>
          <div
            className={cn(
              "flex shrink-0 flex-wrap items-center justify-between",
              (canLoadOlder || paging) && "border-t border-border/70",
            )}
          >
            <ComboboxStatus>
              {paging ? (
                <span className={failed ? "text-warning-foreground" : undefined}>
                  {pageStatus[paging]}
                </span>
              ) : null}
            </ComboboxStatus>
            {canPage ? (
              <div className="ml-auto px-3 py-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label={failed ? "Retry loading older results" : undefined}
                  onClick={() => {
                    searchInput.current?.focus({ preventScroll: true });
                    onLoadOlder();
                  }}
                >
                  {failed ? "Retry" : "Load older results"}
                </Button>
              </div>
            ) : null}
          </div>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
