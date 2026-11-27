import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { WorkflowRunInstructions } from "./WorkflowRunInstructions";

vi.mock("../ui/button", () => ({ Button: "button" }));

let renderer: ReactTestRenderer | undefined;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const toggle = () => renderer!.root.findAllByType("button")[0];
const toggleLabel = () =>
  toggle()
    ?.children.filter((child) => typeof child === "string")
    .join("");
const visibleInstructions = () =>
  renderer!.root
    .findAllByType("p")
    .filter((node) => node.props["aria-hidden"] !== "true")
    .map((node) => node.children.join(""));

it("reveals a disclosure when rendered lines no longer fit and keeps an open disclosure on resize", async () => {
  const firstParagraph = "Prepare the release notes.";
  const instruction = `${firstParagraph}\n\nReview the desktop changes and flag any breaking changes in the draft.`;
  const view = () => (
    <StrictMode>
      <WorkflowRunInstructions instruction={instruction} />
    </StrictMode>
  );
  const observers: { resize: () => void; observe: () => void; disconnect: () => void }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(resize: () => void) {
        observers.push({ resize, observe: this.observe, disconnect: this.disconnect });
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  let bounds = { width: 700, height: 60 };
  const body = {};
  let activeElement = body;
  const document = { body };
  const title = { ownerDocument: document, focus: vi.fn(() => (activeElement = title)) };
  const disclosure = { ownerDocument: document };
  Object.defineProperty(document, "activeElement", {
    get: () =>
      activeElement === disclosure &&
      !JSON.stringify(renderer?.toJSON()).includes('"type":"button"')
        ? body
        : activeElement,
  });
  const probe = {
    textContent: "",
    getBoundingClientRect() {
      return this.textContent === instruction ? bounds : { ...bounds, height: 20 };
    },
    ownerDocument: { defaultView: { getComputedStyle: () => ({ lineHeight: "20px" }) } },
  };
  await act(async () => {
    renderer = create(view(), {
      createNodeMock: ({ type, props }) => {
        if (type === "h2") return title;
        if (type === "button") return disclosure;
        return type === "p" && (props as { "aria-hidden"?: string })["aria-hidden"] === "true"
          ? probe
          : null;
      },
    });
  });
  const observer = observers.at(-1)!;
  expect(observer.observe).toHaveBeenCalledExactlyOnceWith(probe);
  expect(visibleInstructions()).toEqual([instruction]);
  expect(toggle()).toBeUndefined();

  bounds = { width: 330, height: 100 };
  await act(() => observer.resize());
  expect(visibleInstructions()).toEqual([firstParagraph]);
  expect(toggleLabel()).toBe("Show full instructions");
  await act(() => observer.resize());
  expect(toggleLabel()).toBe("Show full instructions");
  activeElement = disclosure;
  bounds = { width: 700, height: 60 };
  await act(() => observer.resize());
  expect(toggle()).toBeUndefined();
  expect(title.focus).toHaveBeenCalledOnce();

  bounds = { width: 330, height: 100 };
  await act(() => observer.resize());
  activeElement = disclosure;
  await act(() => toggle()!.props.onClick());
  expect(visibleInstructions()).toEqual([instruction]);
  expect(toggleLabel()).toBe("Hide full instructions");

  bounds = { width: 700, height: 60 };
  await act(() => observer.resize());
  expect(toggleLabel()).toBe("Hide full instructions");
  expect(title.focus).toHaveBeenCalledOnce();
  await act(() => toggle()!.props.onClick());
  expect(toggle()).toBeUndefined();
  expect(visibleInstructions()).toEqual([instruction]);
  expect(title.focus).toHaveBeenCalledTimes(2);

  await act(() => renderer!.unmount());
  renderer = undefined;
  for (const observed of observers) expect(observed.disconnect).toHaveBeenCalledOnce();
});

it.each([
  { name: "wrapping only", count: 60 },
  { name: "past the source cap", count: 100 },
])("puts only the grapheme-safe fitted preview in the DOM for $name", async ({ count }) => {
  const emoji = "👩‍💻";
  const instruction = `A${emoji.repeat(count)}`;
  const preview = `A${emoji.repeat(22)}…`;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const probe = {
    textContent: "",
    getBoundingClientRect() {
      const lines = Math.ceil(Array.from(segmenter.segment(this.textContent)).length / 8);
      return { width: 240, height: lines * 20 };
    },
    ownerDocument: { defaultView: { getComputedStyle: () => ({ lineHeight: "20px" }) } },
  };
  await act(async () => {
    renderer = create(<WorkflowRunInstructions instruction={instruction} />, {
      createNodeMock: ({ type, props }) =>
        type === "p" && (props as { "aria-hidden"?: string })["aria-hidden"] === "true"
          ? probe
          : null,
    });
  });
  expect(visibleInstructions()).toEqual([preview]);
  expect(toggleLabel()).toBe("Show full instructions");
  await act(() => toggle()!.props.onClick());
  expect(visibleInstructions()).toEqual([instruction]);
  await act(() => toggle()!.props.onClick());
  expect(visibleInstructions()).toEqual([preview]);
});

it.each([
  { name: "nonbreaking space on an empty line", separator: "\n\u00a0\n" },
  { name: "Unicode paragraph separator", separator: "\u2029" },
])("ends the preview at a $name and preserves the expanded text", async ({ separator }) => {
  const firstParagraph = "Release checklist.";
  const instruction = `${firstParagraph}${separator}1. Check the install.\r\n2. Verify the notes.`;
  await act(async () => {
    renderer = create(<WorkflowRunInstructions instruction={instruction} />);
  });

  expect(visibleInstructions()).toEqual([firstParagraph]);
  expect(toggleLabel()).toBe("Show full instructions");
  await act(() => toggle()!.props.onClick());
  expect(visibleInstructions()).toEqual([instruction]);
});
