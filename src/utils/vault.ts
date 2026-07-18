import { App, TFolder } from "obsidian";
import { assertSafeFolder } from "../security/pathGuard";

export async function ensureFolder(app: App, requestedPath: string): Promise<string> {
  const path = assertSafeFolder(requestedPath);
  const segments = path.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing && !(existing instanceof TFolder)) throw new Error(`Cannot create folder: ${current} is a file.`);
    if (!existing) await app.vault.createFolder(current);
  }
  return path;
}
