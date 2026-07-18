import { describe, expect, it } from "vitest";
import { mergeSettings } from "../src/settings/defaults";
import {
  arrayBufferToBase64,
  displayImageName,
  imageLimits,
  normalizeImageMimeType,
  validateImageCandidate
} from "../src/utils/imageAttachments";

describe("image attachments", () => {
  it("accepts only Gemini-supported image MIME types and safe extension fallbacks", () => {
    expect(normalizeImageMimeType("image/jpg", "photo.jpg")).toBe("image/jpeg");
    expect(normalizeImageMimeType("", "phone.HEIC")).toBe("image/heic");
    expect(normalizeImageMimeType("application/octet-stream", "scan.webp")).toBe("image/webp");
    expect(normalizeImageMimeType("text/plain", "spoofed.png")).toBeNull();
    expect(normalizeImageMimeType("image/gif", "animation.gif")).toBeNull();
  });

  it("enforces count, per-file, and total byte limits before reading files", () => {
    const limits = imageLimits(2, 2, 3);
    expect(validateImageCandidate({ name: "one.png", type: "image/png", size: 1024 }, 0, 0, limits)).toBe("image/png");
    expect(() => validateImageCandidate({ name: "three.png", type: "image/png", size: 1 }, 2, 0, limits)).toThrow("no more than 2");
    expect(() => validateImageCandidate({ name: "large.jpg", type: "image/jpeg", size: 2 * 1024 * 1024 + 1 }, 0, 0, limits)).toThrow("per-image limit");
    expect(() => validateImageCandidate({ name: "total.jpg", type: "image/jpeg", size: 2 * 1024 * 1024 }, 1, 2 * 1024 * 1024, limits)).toThrow("total attachment limit");
  });

  it("sanitizes display names and converts bytes to Gemini base64", () => {
    expect(displayImageName("../bad\\name?[[embed]].png")).toBe("_bad_name_embed_.png");
    expect(arrayBufferToBase64(new Uint8Array([0, 1, 2, 253, 254, 255]).buffer)).toBe("AAEC/f7/");
  });

  it("clamps configurable image limits to the safe inline request budget", () => {
    const settings = mergeSettings({ maxImagesPerMessage: 99, maxImageSizeMb: 99, maxImageRequestMb: 99 });
    expect(settings.maxImagesPerMessage).toBe(8);
    expect(settings.maxImageRequestMb).toBe(12);
    expect(settings.maxImageSizeMb).toBe(12);
  });
});
