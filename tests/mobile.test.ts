import { describe, expect, it } from "vitest";
import { composerEnterKeyHint, shouldSubmitComposerKey } from "../src/utils/mobile";

const key = (overrides: Partial<Parameters<typeof shouldSubmitComposerKey>[0]> = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...overrides
});

describe("mobile composer behavior", () => {
  it("keeps plain Enter available for multiline text on mobile", () => {
    expect(shouldSubmitComposerKey(key(), true)).toBe(false);
    expect(composerEnterKeyHint(true)).toBe("enter");
  });

  it("submits from a mobile hardware keyboard with Mod+Enter", () => {
    expect(shouldSubmitComposerKey(key({ ctrlKey: true }), true)).toBe(true);
    expect(shouldSubmitComposerKey(key({ metaKey: true }), true)).toBe(true);
  });

  it("preserves desktop Enter and Shift+Enter conventions", () => {
    expect(shouldSubmitComposerKey(key(), false)).toBe(true);
    expect(shouldSubmitComposerKey(key({ shiftKey: true }), false)).toBe(false);
    expect(composerEnterKeyHint(false)).toBe("send");
  });

  it("never submits during IME composition", () => {
    expect(shouldSubmitComposerKey(key({ isComposing: true, ctrlKey: true }), true)).toBe(false);
  });
});
