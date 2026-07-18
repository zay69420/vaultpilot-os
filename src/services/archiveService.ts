import { App } from "obsidian";
import { assertSafeFolder, joinSafeVaultPath } from "../security/pathGuard";
import type { ChatMessage, ChatSession, VaultPilotSettings } from "../types";
import { formatArchiveTimestamp, sanitizeTopic } from "../utils/text";
import { ensureFolder } from "../utils/vault";

export interface ArchiveResult {
  sessionIds: Set<string>;
  paths: string[];
}

export class ArchiveService {
  constructor(private readonly app: App, private readonly getSettings: () => VaultPilotSettings) {}

  async archiveAll(sessions: ChatSession[]): Promise<ArchiveResult> {
    const candidates = sessions.filter((session) => session.messages.some((message) => message.content.trim()));
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
      await this.app.vault.create(path, renderArchive(session));
      paths.push(path);
      sessionIds.add(session.id);
    }
    return { sessionIds, paths };
  }
}

function renderArchive(session: ChatSession): string {
  const created = new Date(session.createdAt).toISOString();
  const updated = new Date(session.updatedAt).toISOString();
  const transcript = session.messages.map(renderMessage).join("\n\n");
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

function renderMessage(message: ChatMessage): string {
  const role = message.role === "user" ? "User" : "Assistant";
  return `## ${role}\n\n${message.content}`;
}
