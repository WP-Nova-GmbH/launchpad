import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerStashMenu } from "./ComposerStashMenu";

describe("ComposerStashMenu", () => {
  it("leaves keys and pointer presses to the foreground window confirmation", async () => {
    const browserWindow = new EventTarget();
    const querySelector = vi.fn().mockReturnValue({});
    const browserDocument = Object.assign(new EventTarget(), { querySelector });
    const onClose = vi.fn();
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const entry = {
      id: "draft",
      createdAt: new Date(0).toISOString(),
      prompt: "Continue the review",
      attachments: [],
      droppedImageNames: [],
    };
    let renderer: ReactTestRenderer | undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("document", browserDocument);

    function pressKey(key: string, metaKey = false) {
      const event = Object.assign(new Event("keydown", { cancelable: true }), { key, metaKey });
      browserWindow.dispatchEvent(event);
      return event;
    }

    try {
      await act(() => {
        renderer = create(
          <ComposerStashMenu
            entries={[entry]}
            stashShortcutLabel={null}
            onClose={onClose}
            onRestore={onRestore}
            onDelete={onDelete}
          />,
        );
      });

      browserDocument.dispatchEvent(new Event("pointerdown"));
      expect(pressKey("Enter").defaultPrevented).toBe(false);
      expect(pressKey("Escape").defaultPrevented).toBe(false);
      expect(pressKey("Backspace", true).defaultPrevented).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      expect(onRestore).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();

      querySelector.mockReturnValue(null);
      vi.stubGlobal("HTMLElement", class extends EventTarget {});
      expect(pressKey("Enter").defaultPrevented).toBe(true);
      expect(onRestore).toHaveBeenCalledWith(entry);
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("shows saved image thumbnails and incomplete image states", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "with-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Compare these screenshots",
            attachments: [
              {
                id: "image-one",
                name: "before.png",
                mimeType: "image/png",
                sizeBytes: 128,
                dataUrl: "data:image/png;base64,AA==",
              },
            ],
            droppedImageNames: ["after.png"],
            unreadableImageNames: [],
            pendingImageCount: 0,
          },
          {
            id: "saving-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Save this image",
            attachments: [],
            droppedImageNames: [],
            unreadableImageNames: [],
            pendingImageCount: 1,
          },
        ]}
        stashShortcutLabel="Ctrl+S"
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('src="data:image/png;base64,AA=="');
    expect(markup).toContain("1 image dropped");
    expect(markup).toContain("saving 1 image");
  });

  it("labels mixed file and image stashes without treating images as files", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "mixed-attachments",
            createdAt: new Date(0).toISOString(),
            prompt: "",
            attachments: [
              {
                id: "image-one",
                name: "before.png",
                mimeType: "image/png",
                sizeBytes: 128,
                dataUrl: "data:image/png;base64,AA==",
              },
            ],
            files: [
              {
                id: "file-one",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 42,
                attachmentId: "pending-report-pdf",
                environmentId: EnvironmentId.make("environment-1"),
              },
            ],
            droppedImageNames: [],
          },
        ]}
        stashShortcutLabel={null}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("(2 attachments)");
    expect(markup).not.toContain("(2 files)");
  });
});
