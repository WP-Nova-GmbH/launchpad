import type { KeybindingCommand } from "@t3tools/contracts";

export type TerminalFocusOwner = "drawer" | "right-panel";

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (owner === "drawer" || owner === "right-panel") return owner;
  return null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}

export function isDrawerTerminalShortcut(
  command: KeybindingCommand,
  focusOwner: TerminalFocusOwner | null,
): boolean {
  return (
    command === "terminal.toggle" ||
    (focusOwner === "drawer" &&
      (command === "terminal.split" ||
        command === "terminal.splitVertical" ||
        command === "terminal.new" ||
        command === "terminal.close"))
  );
}
