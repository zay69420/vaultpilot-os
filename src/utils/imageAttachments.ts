import type { ChatImageAttachment, SupportedImageMimeType } from "../types";

const MEBIBYTE = 1024 * 1024;

export const SUPPORTED_IMAGE_MIME_TYPES: readonly SupportedImageMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif"
];

export const IMAGE_FILE_ACCEPT = SUPPORTED_IMAGE_MIME_TYPES.join(",");

export interface ImageAttachmentLimits {
  maxCount: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface ImageFileCandidate {
  name: string;
  type: string;
  size: number;
}

export function imageLimits(maxCount: number, maxFileMb: number, maxTotalMb: number): ImageAttachmentLimits {
  return {
    maxCount: Math.max(1, Math.floor(maxCount)),
    maxFileBytes: Math.max(1, maxFileMb) * MEBIBYTE,
    maxTotalBytes: Math.max(1, maxTotalMb) * MEBIBYTE
  };
}

export function validateImageCandidate(
  candidate: ImageFileCandidate,
  currentCount: number,
  currentBytes: number,
  limits: ImageAttachmentLimits
): SupportedImageMimeType {
  const mimeType = normalizeImageMimeType(candidate.type, candidate.name);
  if (!mimeType) {
    throw new Error(`${displayImageName(candidate.name)} is not a supported image. Use PNG, JPEG, WebP, HEIC, or HEIF.`);
  }
  if (!Number.isFinite(candidate.size) || candidate.size <= 0) {
    throw new Error(`${displayImageName(candidate.name)} is empty or unreadable.`);
  }
  if (currentCount >= limits.maxCount) {
    throw new Error(`Attach no more than ${limits.maxCount} image${limits.maxCount === 1 ? "" : "s"} per message.`);
  }
  if (candidate.size > limits.maxFileBytes) {
    throw new Error(`${displayImageName(candidate.name)} exceeds the ${formatBytes(limits.maxFileBytes)} per-image limit.`);
  }
  if (currentBytes + candidate.size > limits.maxTotalBytes) {
    throw new Error(`The selected images exceed the ${formatBytes(limits.maxTotalBytes)} total attachment limit.`);
  }
  return mimeType;
}

export function normalizeImageMimeType(type: string, name: string): SupportedImageMimeType | null {
  const normalized = type.trim().toLocaleLowerCase();
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg";
  if (SUPPORTED_IMAGE_MIME_TYPES.includes(normalized as SupportedImageMimeType)) {
    return normalized as SupportedImageMimeType;
  }
  if (normalized && normalized !== "application/octet-stream") return null;
  const extension = name.split(".").at(-1)?.toLocaleLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  return null;
}

export function displayImageName(value: string): string {
  const cleaned = value
    .replace(/[\\/\u0000-\u001f<>:"|?*\[\]#^]+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 120);
  return cleaned || "image";
}

export function extensionForImageMimeType(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
  }
}

export function totalAttachmentBytes(attachments: readonly ChatImageAttachment[]): number {
  return attachments.reduce((sum, attachment) => sum + Math.max(0, attachment.size), 0);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < MEBIBYTE) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / MEBIBYTE).toFixed(value < 10 * MEBIBYTE ? 1 : 0)} MB`;
}
