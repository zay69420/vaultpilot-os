import { App } from "obsidian";
import { assertSafeFolder, joinSafeVaultAssetPath, joinSafeVaultPath } from "../security/pathGuard";
import type { ChatMessage, ChatSession, StoredImageAttachment, VaultPilotSettings } from "../types";
import { displayImageName, extensionForImageMimeType } from "../utils/imageAttachments";
import { formatArchiveTimestamp, sanitizeTopic } from "../utils/text";
import { ensureFolder } from "../utils/vault";

export interface ArchiveResult {
  sessionIds: Set<string>;
  paths: string[];
}

export class ArchiveService {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => VaultPilotSettings,
    private readonly loadAttachment: (id: string) => Promise<StoredImageAttachment | undefined>
  ) {}

  async archiveAll(sessions: ChatSession[]): Promise<ArchiveResult> {
    const candidates = sessions.filter((session) => session.messages.some((message) => message.content.trim() || message.attachments?.length));
    const sessionIds = new Set<string>();
    const paths: string[] = [];
    if (candidates.length === 0) return { sessionIds, paths };

    const folder = assertSafeFolder(this.getSettings().conversationsFolder);
    await ensureFolder(this.app, folder);
    for (const session of candidates) {
      const timestamp = formatArchiveTimestamp(new Date(session.createdAt));
      const baseTopic = sanitizeTopic(session.title || session.messages.find((message) => message.role === "user")?.content || "Conversation");
      let topic = baseTopic;
      let path = joinSafeVaultPath(folder, `${topic}@${timestamp}.md`);
      let suffix = 2;
      while (this.app.vault.getAbstractFileByPath(path)) {
        topic = `${baseTopic}${suffix}`;
        path = joinSafeVaultPath(folder, `${topic}@${timestamp}.md`);
        suffix += 1;
      }
      const attachmentPaths = await this.archiveAttachments(folder, session);
      await this.app.vault.create(path, renderArchive(session, attachmentPaths));
      paths.push(path);
      sessionIds.add(session.id);
    }
    return { sessionIds, paths };
  }

  private async archiveAttachments(folder: string, session: ChatSession): Promise<Map<string, string>> {
    const output = new Map<string, string>();
    const attachments = session.messages.flatMap((message) => message.attachments ?? []);
    if (attachments.length === 0) return output;
    const assetsFolder = joinSafeVaultAssetPath(folder, "_attachments", session.id);
    await ensureFolder(this.app, assetsFolder);
    for (const attachment of attachments) {
      const stored = await this.loadAttachment(attachment.id);
      if (!stored || stored.data.byteLength !== stored.size) continue;
      const fallbackExtension = extensionForImageMimeType(stored.mimeType);
      const cleanName = displayImageName(stored.name);
      const dot = cleanName.lastIndexOf(".");
      const stem = dot > 0 ? cleanName.slice(0, dot) : cleanName;
      const filename = `${stem}.${fallbackExtension}`;
      const prefix = stored.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-12) || "image";
      let path = joinSafeVaultAssetPath(assetsFolder, `${prefix}-${filename}`);
      let suffix = 2;
      while (this.app.vault.getAbstractFileByPath(path)) {
        path = joinSafeVaultAssetPath(assetsFolder, `${prefix}-${stem}-${suffix}.${fallbackExtension}`);
        suffix += 1;
      }
      await this.app.vault.createBinary(path, stored.data);
      output.set(stored.id, path);
    }
    return output;
  }
}

function renderArchive(session: ChatSession, attachmentPaths: Map<string, string>): string {
  const created = new Date(session.createdAt).toISOString();
  const updated = new Date(session.updatedAt).toISOString();
  const transcript = session.messages.map((message) => renderMessage(message, attachmentPaths)).join("\n\n");
  return `---
type: vaultpilot-conversation
title: ${JSON.stringify(session.title)}
created: ${created}
updated: ${updated}
input_tokens: ${session.usage.inputTokens}
output_tokens: ${session.usage.outputTokens}
approximate_cost_usd: ${session.usage.costUsd.toFixed(6)}
---

# ${session.title}

${transcript}
`;
}

function renderMessage(message: ChatMessage, attachmentPaths: Map<string, string>): string {
  const role = message.role === "user" ? "User" : "Assistant";
  const images = (message.attachments ?? [])
    .map((attachment) => attachmentPaths.get(attachment.id))
    .filter((path): path is string => Boolean(path))
    .map((path) => `![[${path}]]`)
    .join("\n\n");
  return `## ${role}\n\n${[message.content, images].filter(Boolean).join("\n\n")}`;
}
