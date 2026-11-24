import { ApprovalRequestId } from "@t3tools/contracts";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

function renderPanel(pendingUserInput: PendingUserInput = prompt) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("leaves number keys alone until the foreground window confirmation closes", async () => {
    vi.useFakeTimers();
    const querySelector = vi.fn().mockReturnValue({});
    const browserDocument = Object.assign(new EventTarget(), { querySelector });
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", browserDocument);
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("HTMLElement", class extends EventTarget {});
    vi.stubGlobal("HTMLInputElement", class extends HTMLElement {});
    vi.stubGlobal("HTMLTextAreaElement", class extends HTMLElement {});

    const pressFirstOption = async () => {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "1" });
      await act(() => browserDocument.dispatchEvent(event));
      await act(() => vi.advanceTimersByTime(200));
      return event.defaultPrevented;
    };

    try {
      await act(() => {
        renderer = create(
          <ComposerPendingUserInputPanel
            pendingUserInputs={[prompt]}
            respondingRequestIds={[]}
            answers={{}}
            questionIndex={0}
            onToggleOption={onToggleOption}
            onAdvance={onAdvance}
            onDismiss={() => {}}
          />,
        );
      });

      expect(await pressFirstOption()).toBe(false);
      expect(onToggleOption).not.toHaveBeenCalled();
      expect(onAdvance).not.toHaveBeenCalled();

      querySelector.mockReturnValue(null);
      expect(await pressFirstOption()).toBe(true);
      expect(onToggleOption).toHaveBeenCalledWith("question-1", "Incremental");
      expect(onAdvance).toHaveBeenCalledOnce();
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanel();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("offers dismiss only for async questions", () => {
    expect(renderPanel()).toContain("data-pending-user-input-dismiss");
    expect(renderPanel({ ...prompt, dismissible: false })).not.toContain(
      "data-pending-user-input-dismiss",
    );
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });
});
