/** Let application input handlers yield to a foreground window confirmation. */
export function isWindowAlertDialogOpen(): boolean {
  return Boolean(
    globalThis.document?.querySelector?.(
      '[data-alert-dialog-layer="window"][data-open]:not([hidden])',
    ),
  );
}
