import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/storage/sessionStore";
import type { ChatImageAttachment, StoredImageAttachment } from "../src/types";

describe("SessionStore multimodal context", () => {
  it("loads recent image bytes into Gemini inlineData parts", async () => {
    const store = new SessionStore(undefined, undefined, vi.fn());
    const attachment: ChatImageAttachment = { id: "image-1", name: "diagram.png", mimeType: "image/png", size: 3 };
    store.addMessage("user", "Explain this diagram", [attachment]);
    const stored: StoredImageAttachment = {
      ...attachment,
      data: new Uint8Array([1, 2, 3]).buffer,
      createdAt: Date.now()
    };

    const context = await store.context(0, async (id) => id === attachment.id ? stored : undefined, 1024);
    expect(context.at(-1)).toEqual({
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: "AQID" } },
        { text: "Explain this diagram" }
      ]
    });
  });

  it("prioritizes the newest image when the context image budget is full", async () => {
    const store = new SessionStore(undefined, undefined, vi.fn());
    const older: ChatImageAttachment = { id: "older", name: "older.png", mimeType: "image/png", size: 4 };
    const newer: ChatImageAttachment = { id: "newer", name: "newer.png", mimeType: "image/png", size: 4 };
    store.addMessage("user", "Older", [older]);
    store.addMessage("assistant", "Noted");
    store.addMessage("user", "Newer", [newer]);
    const loaded: string[] = [];

    const context = await store.context(0, async (id) => {
      loaded.push(id);
      return { ...(id === "newer" ? newer : older), data: new Uint8Array([1, 2, 3, 4]).buffer, createdAt: Date.now() };
    }, 4, 8);

    expect(loaded).toEqual(["newer"]);
    expect(context.at(-1)?.parts.some((part) => part.inlineData?.data === "AQIDBA==")).toBe(true);
  });
});
