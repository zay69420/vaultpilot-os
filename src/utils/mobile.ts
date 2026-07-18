export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/**
 * Desktop submits with Enter and inserts a newline with Shift+Enter. On a
 * phone, Enter remains available for multiline text; the visible Send button
 * or a hardware-keyboard Mod+Enter submits instead.
 */
export function shouldSubmitComposerKey(event: ComposerKeyInput, isMobile: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (isMobile) return !event.shiftKey && (event.ctrlKey || event.metaKey);
  return !event.shiftKey;
}

export function composerEnterKeyHint(isMobile: boolean): "enter" | "send" {
  return isMobile ? "enter" : "send";
}
