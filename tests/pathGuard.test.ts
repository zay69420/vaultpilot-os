import { describe, expect, it } from "vitest";
import { assertSafeFolder, assertSafeVaultPath, joinSafeVaultAssetPath, joinSafeVaultPath } from "../src/security/pathGuard";

describe("vault path guard", () => {
  it("normalizes safe vault-relative Markdown paths", () => {
    expect(assertSafeVaultPath("Projects\\Alpha.md", { markdownOnly: true })).toBe("Projects/Alpha.md");
    expect(assertSafeFolder("memory/people")).toBe("memory/people");
    expect(joinSafeVaultPath("conversations", "Topic@2026-07-18_15-30.md")).toBe("conversations/Topic@2026-07-18_15-30.md");
  });

  it.each([
    ".obsidian/plugins/evil/main.js",
    ".ObSiDiAn/config",
    ".obsidian\\plugins\\vaultpilot-os\\data.json",
    "notes/../../.obsidian/plugins/evil.md",
    "../outside.md",
    "notes/bad\0name.md",
    "/absolute/note.md",
    "C:\\vault\\note.md",
    "https://example.com/note.md"
  ])("rejects forbidden or non-vault path %s", (path) => {
    expect(() => assertSafeVaultPath(path)).toThrow();
  });

  it("requires Markdown when a tool requests Markdown-only access", () => {
    expect(() => assertSafeVaultPath("notes/private.json", { markdownOnly: true })).toThrow(/Markdown/);
  });

  it("allows safe archived image assets without weakening the forbidden zone", () => {
    expect(joinSafeVaultAssetPath("conversations", "_attachments", "session-1", "image.png"))
      .toBe("conversations/_attachments/session-1/image.png");
    expect(() => joinSafeVaultAssetPath(".obsidian", "plugins", "image.png")).toThrow(/forbidden/i);
    expect(() => joinSafeVaultAssetPath("conversations", "..", ".obsidian", "image.png")).toThrow(/traversal/i);
  });
});
