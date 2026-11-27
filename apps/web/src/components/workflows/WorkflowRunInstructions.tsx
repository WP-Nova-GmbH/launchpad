import { ChevronDownIcon } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const previewCharacterLimit = 240;
const instructionTextClass = "text-sm wrap-anywhere whitespace-pre-wrap text-muted-foreground";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function preparePreview(instruction: string) {
  const normalized = instruction.replace(/\r\n?|[\u0085\u2028\u2029]/gu, (breakText) =>
    breakText === "\u2029" ? "\n\n" : "\n",
  );
  const lines = normalized.split("\n", 4);
  const firstLines = lines.slice(0, 3).join("\n");
  const exceedsTextLimit =
    lines.length > 3 || Array.from(firstLines).length > previewCharacterLimit;
  const firstParagraph = (firstLines.split(/\n[^\S\n]*\n/u, 1)[0] ?? firstLines).trimEnd();
  const maximumOffset = Array.from(firstParagraph).slice(0, previewCharacterLimit).join("").length;
  const boundary =
    graphemes.segment(firstParagraph).containing(maximumOffset)?.index ?? maximumOffset;
  const excerpt = firstParagraph.slice(0, boundary).trimEnd();
  const preview = boundary < firstParagraph.length ? `${excerpt}…` : excerpt;
  return {
    exceedsTextLimit,
    excerpt,
    preview,
    probeText: exceedsTextLimit ? preview : instruction,
  };
}

function fitPreview(excerpt: string, fits: (text: string) => boolean) {
  const boundaries = Array.from(graphemes.segment(excerpt), ({ index }) => index);
  let lower = 0;
  let upper = boundaries.length - 1;
  let fitted = "…";
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = `${excerpt.slice(0, boundaries[middle]).trimEnd()}…`;
    if (fits(candidate)) {
      fitted = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return fitted;
}

export function WorkflowRunInstructions({ instruction }: { instruction: string }) {
  const headingId = useId();
  const instructionId = useId();
  const [expanded, setExpanded] = useState(false);
  const [fittedPreview, setFittedPreview] = useState<string | null>(null);
  const probe = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreDisclosureFocus = useRef(false);
  const registerDisclosure = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      restoreDisclosureFocus.current = button.ownerDocument?.activeElement === button;
    };
  }, []);
  const prepared = useMemo(() => preparePreview(instruction), [instruction]);
  const { exceedsTextLimit, preview } = prepared;
  const canExpand = exceedsTextLimit || fittedPreview !== null;
  const showDisclosure = canExpand || expanded;

  useLayoutEffect(() => {
    const { excerpt, preview, probeText } = prepared;
    const element = probe.current;
    const browser = element?.ownerDocument?.defaultView;
    if (!element || !browser) return;

    let active = true;
    // The hidden probe's settled content stays independent of the visible disclosure.
    element.textContent = probeText;
    const measure = () => {
      if (!active) return;
      const { width, height } = element.getBoundingClientRect();
      const lineHeight = Number.parseFloat(browser.getComputedStyle(element).lineHeight);
      if (width <= 0 || !(lineHeight > 0)) return;
      const maximumHeight = 3 * lineHeight + 0.5;
      if (height <= maximumHeight) {
        setFittedPreview(null);
        return;
      }
      const fits = (candidate: string) => {
        element.textContent = candidate;
        return element.getBoundingClientRect().height <= maximumHeight;
      };
      try {
        setFittedPreview(
          probeText !== preview && fits(preview) ? preview : fitPreview(excerpt, fits),
        );
      } finally {
        element.textContent = probeText;
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [prepared]);

  useLayoutEffect(() => {
    const title = heading.current;
    const document = title?.ownerDocument;
    if (
      !showDisclosure &&
      restoreDisclosureFocus.current &&
      title &&
      document &&
      document.activeElement === document.body
    ) {
      title.focus({ preventScroll: true });
    }
    restoreDisclosureFocus.current = false;
  }, [showDisclosure]);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 ref={heading} id={headingId} tabIndex={-1} className="text-sm font-medium">
          Run instructions
        </h2>
        {showDisclosure ? (
          <Button
            ref={registerDisclosure}
            type="button"
            size="compact"
            variant="outline"
            aria-controls={instructionId}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDownIcon aria-hidden className={expanded ? "rotate-180" : undefined} />
            {expanded ? "Hide full instructions" : "Show full instructions"}
          </Button>
        ) : null}
      </div>
      <div className="relative">
        <p id={instructionId} className={cn(instructionTextClass, !expanded && "line-clamp-3")}>
          {canExpand && !expanded ? (fittedPreview ?? preview) : instruction}
        </p>
        <div className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
          <p ref={probe} aria-hidden="true" className={instructionTextClass} />
        </div>
      </div>
    </section>
  );
}
