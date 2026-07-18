const FORBIDDEN_ROOT = ".obsidian";

export class UnsafeVaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeVaultPathError";
  }
}

/**
 * Normalizes a user/model supplied vault-relative path and enforces the hard
 * forbidden zone. This function must guard every AI-accessible file operation.
 */
export function assertSafeVaultPath(input: string, options: { markdownOnly?: boolean; allowRoot?: boolean } = {}): string {
  if (typeof input !== "string" || input.includes("\0")) {
    throw new UnsafeVaultPathError("The vault path is invalid.");
  }

  const uncollapsed = input.trim().replace(/\\/g, "/");
  if (uncollapsed.startsWith("/") || /^[a-zA-Z]:\//.test(uncollapsed) || /^[a-zA-Z][a-zA-Z\d+.-]*:\//.test(uncollapsed)) {
    throw new UnsafeVaultPathError("Absolute paths and URLs are not allowed.");
  }
  const raw = uncollapsed.replace(/\/{2,}/g, "/");
  if (!raw && options.allowRoot) return "";
  if (!raw) throw new UnsafeVaultPathError("A vault-relative path is required.");
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new UnsafeVaultPathError("Path traversal is not allowed.");
  }
  if (segments[0]?.toLocaleLowerCase() === FORBIDDEN_ROOT) {
    throw new UnsafeVaultPathError("Access to .obsidian and all descendants is permanently forbidden.");
  }

  const normalized = segments.join("/");
  if (!normalized && !options.allowRoot) throw new UnsafeVaultPathError("A vault-relative path is required.");
  if (options.markdownOnly && !normalized.toLocaleLowerCase().endsWith(".md")) {
    throw new UnsafeVaultPathError("Only Markdown (.md) files are allowed.");
  }
  return normalized;
}

export function assertSafeFolder(input: string): string {
  const normalized = assertSafeVaultPath(input);
  if (normalized.toLocaleLowerCase().endsWith(".md")) {
    throw new UnsafeVaultPathError("A folder path was expected, not a Markdown file.");
  }
  return normalized.replace(/\/$/, "");
}

export function joinSafeVaultPath(folder: string, filename: string): string {
  return assertSafeVaultPath(`${assertSafeFolder(folder)}/${filename}`, { markdownOnly: true });
}

export function isForbiddenVaultPath(input: string): boolean {
  try {
    assertSafeVaultPath(input, { allowRoot: true });
    return false;
  } catch {
    return true;
  }
}
