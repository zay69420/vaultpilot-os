import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../src/storage/attachmentStore";
import type { ImageAttachmentInput } from "../src/types";

describe("AttachmentStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists image bytes locally and prunes orphaned records", async () => {
    vi.stubGlobal("indexedDB", indexedDB);
    const store = new AttachmentStore(`test-vault-${Date.now()}-${Math.random()}`);
    await store.open();
    const inputs: ImageAttachmentInput[] = [
      { id: "keep", name: "keep.png", mimeType: "image/png", size: 3, data: new Uint8Array([1, 2, 3]).buffer },
      { id: "remove", name: "remove.webp", mimeType: "image/webp", size: 2, data: new Uint8Array([4, 5]).buffer }
    ];

    const metadata = await store.saveMany(inputs);
    expect(metadata).toEqual(inputs.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })));
    expect(Array.from(new Uint8Array((await store.get("keep"))?.data ?? new ArrayBuffer(0)))).toEqual([1, 2, 3]);

    await store.prune(new Set(["keep"]));
    expect(await store.get("keep")).toBeDefined();
    expect(await store.get("remove")).toBeUndefined();
    store.close();
  });
});
