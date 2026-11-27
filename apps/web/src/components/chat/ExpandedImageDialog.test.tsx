import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ExpandedImageDialog } from "./ExpandedImageDialog";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("leaves Escape to the window confirmation and resumes handling it when the confirmation closes", async () => {
  const browserWindow = new EventTarget();
  const querySelector = vi.fn().mockReturnValue({});
  const onClose = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", { activeElement: null, querySelector });
  vi.stubGlobal("HTMLElement", EventTarget);

  await act(() => {
    renderer = create(<ExpandedImageDialog preview={{ images: [], index: 0 }} onClose={onClose} />);
  });

  const pressEscape = () => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    browserWindow.dispatchEvent(event);
    return event;
  };

  expect(pressEscape().defaultPrevented).toBe(false);
  expect(onClose).not.toHaveBeenCalled();

  querySelector.mockReturnValue(null);
  expect(pressEscape().defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
});
