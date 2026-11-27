import { RelayOrganizationId, RelayRepositoryId } from "@t3tools/contracts/relay";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import { AlertDialog } from "../ui/alert-dialog";
import { RemoveRepositoryButton } from "./RemoveRepositoryButton";

vi.mock("../ui/alert-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/alert-dialog")>()),
  // Exercise the real dialog root and close control without a browser portal.
  AlertDialogPopup: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

it("requires a separate confirmation for the selected repository, even when two names match", async () => {
  const onRemove = vi.fn(async () => true);
  const repositories = ["first", "second"].map((owner) => ({
    name: "launchpad",
    repositoryId: RelayRepositoryId.make(owner),
    organizationId: RelayOrganizationId.make("org"),
    canonicalKeys: [`github.com/${owner}/launchpad`],
    createdAt: "2026-11-27",
  }));
  let renderer!: ReactTestRenderer;
  try {
    await act(() => {
      renderer = create(
        <>
          {repositories.map((repository) => (
            <RemoveRepositoryButton
              key={repository.repositoryId}
              repository={repository}
              disabled={false}
              onRemove={onRemove}
            />
          ))}
        </>,
      );
    });
    const row = renderer.root.findAllByType(RemoveRepositoryButton)[1]!;
    const remove = () =>
      row.findByProps({ "aria-label": "Remove repository github.com/second/launchpad" });
    const dialog = () => row.findByType(AlertDialog);
    await act(() => remove().props.onClick({ currentTarget: null }));
    expect(dialog().props.open).toBe(true);
    expect(onRemove).not.toHaveBeenCalled();
    expect(dialog().findByType("strong").children).toEqual(["github.com/second/launchpad"]);
    await act(() => dialog().props.onOpenChange(false));
    expect(dialog().props.open).toBe(false);
    expect(onRemove).not.toHaveBeenCalled();
    await act(() => remove().props.onClick({ currentTarget: null }));
    const confirm = dialog()
      .findAllByType("button")
      .find((button) => button.children.includes("Remove repository"))!;
    await act(() => confirm.props.onClick());
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(repositories[1]!.repositoryId);
  } finally {
    await act(() => renderer?.unmount());
  }
});
