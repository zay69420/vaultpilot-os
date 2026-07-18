import type { ChatImageAttachment, ChatMessage, ChatSession, GeminiContent, StoredImageAttachment, TokenUsage } from "../types";
import { createId } from "../utils/id";
import { arrayBufferToBase64, SUPPORTED_IMAGE_MIME_TYPES } from "../utils/imageAttachments";
import { sanitizeTopic } from "../utils/text";

const EMPTY_USAGE = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });

export class SessionStore {
  private sessions: ChatSession[];
  private activeId: string;

  constructor(sessions: ChatSession[] | undefined, activeId: string | undefined, private readonly onChange: () => void) {
    this.sessions = (sessions ?? []).map(normalizeSession);
    this.activeId = activeId ?? "";
    if (!this.sessions.some((session) => session.id === this.activeId)) this.activeId = this.sessions.at(-1)?.id ?? "";
    if (!this.activeId) this.newSession();
  }

  all(): ChatSession[] {
    return this.sessions;
  }

  active(): ChatSession {
    const session = this.sessions.find((candidate) => candidate.id === this.activeId);
    if (!session) return this.newSession();
    return session;
  }

  activeSessionId(): string {
    return this.activeId;
  }

  newSession(): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      id: createId("session"),
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      messages: [],
      usage: EMPTY_USAGE()
    };
    this.sessions.push(session);
    this.activeId = session.id;
    this.onChange();
    return session;
  }

  addMessage(role: "user" | "assistant", content: string, attachments: ChatImageAttachment[] = []): ChatMessage {
    const session = this.active();
    const message: ChatMessage = {
      id: createId("message"),
      role,
      content,
      createdAt: Date.now(),
      ...(attachments.length ? { attachments } : {})
    };
    session.messages.push(message);
    session.updatedAt = message.createdAt;
    if (role === "user" && session.messages.filter((item) => item.role === "user").length === 1) {
      session.title = sanitizeTopic(content || (attachments.length ? "Image conversation" : "Conversation"));
    }
    this.onChange();
    return message;
  }

  updateMessage(id: string, content: string, sessionId?: string): void {
    const session = sessionId ? this.sessions.find((candidate) => candidate.id === sessionId) : this.active();
    if (!session) return;
    const message = session.messages.find((candidate) => candidate.id === id);
    if (!message) return;
    message.content = content;
    session.updatedAt = Date.now();
    this.onChange();
  }

  addUsage(usage: TokenUsage, sessionId?: string): void {
    const session = sessionId ? this.sessions.find((candidate) => candidate.id === sessionId) : this.active();
    if (!session) return;
    const total = session.usage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    total.costUsd += usage.costUsd;
    this.onChange();
  }

  async context(
    historySessionLimit: number,
    loadAttachment: (id: string) => Promise<StoredImageAttachment | undefined>,
    maximumImageBytes: number,
    maximumImages = 8
  ): Promise<GeminiContent[]> {
    const active = this.active();
    const previous = this.sessions
      .filter((session) => session.id !== active.id && session.messages.length > 0)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, historySessionLimit)
      .reverse();
    const selectedMessages: ChatMessage[] = [];
    for (const session of [...previous, active]) {
      selectedMessages.push(...session.messages.slice(-20));
    }
    const messages = trimMessages(selectedMessages, 60_000);
    const includedAttachmentIds = selectRecentAttachmentIds(messages, maximumImageBytes, maximumImages);
    const output: GeminiContent[] = [];
    for (const message of messages) {
      const parts: GeminiContent["parts"] = [];
      if (message.role === "user") {
        for (const attachment of message.attachments ?? []) {
          if (!includedAttachmentIds.has(attachment.id)) continue;
          try {
            const stored = await loadAttachment(attachment.id);
            if (!stored || stored.data.byteLength !== stored.size || stored.mimeType !== attachment.mimeType) continue;
            parts.push({ inlineData: { mimeType: stored.mimeType, data: arrayBufferToBase64(stored.data) } });
          } catch (error) {
            console.warn("VaultPilot OS skipped an unavailable image attachment", error);
          }
        }
      }
      if (message.content.trim()) parts.push({ text: message.content });
      if (parts.length > 0) output.push({ role: message.role === "assistant" ? "model" : "user", parts });
    }
    return output;
  }

  allAttachmentIds(): Set<string> {
    return this.attachmentIdsForSessions(new Set(this.sessions.map((session) => session.id)));
  }

  attachmentIdsForSessions(ids: Set<string>): Set<string> {
    const output = new Set<string>();
    for (const session of this.sessions) {
      if (!ids.has(session.id)) continue;
      for (const message of session.messages) {
        for (const attachment of message.attachments ?? []) output.add(attachment.id);
      }
    }
    return output;
  }

  removeSessions(ids: Set<string>): void {
    this.sessions = this.sessions.filter((session) => !ids.has(session.id));
    if (ids.has(this.activeId) || !this.sessions.some((session) => session.id === this.activeId)) {
      this.activeId = this.sessions.at(-1)?.id ?? "";
    }
    if (!this.activeId) this.newSession();
    else this.onChange();
  }
}

function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages.map(normalizeMessage) : [],
    usage: { ...EMPTY_USAGE(), ...(session.usage ?? {}) }
  };
}

function normalizeMessage(message: ChatMessage): ChatMessage {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter((attachment): attachment is ChatImageAttachment => Boolean(
      attachment
      && typeof attachment.id === "string"
      && typeof attachment.name === "string"
      && typeof attachment.size === "number"
      && attachment.size > 0
      && SUPPORTED_IMAGE_MIME_TYPES.includes(attachment.mimeType)
    ))
    : [];
  return { ...message, ...(attachments.length ? { attachments } : { attachments: undefined }) };
}

function trimMessages(messages: ChatMessage[], maximumCharacters: number): ChatMessage[] {
  const output: ChatMessage[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const length = message.content.length;
    if (used + length > maximumCharacters && output.length > 0) break;
    output.unshift(message);
    used += length;
  }
  return output;
}

function selectRecentAttachmentIds(messages: ChatMessage[], maximumBytes: number, maximumImages: number): Set<string> {
  const included = new Set<string>();
  let usedBytes = 0;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    for (const attachment of [...(message.attachments ?? [])].reverse()) {
      if (included.size >= maximumImages || usedBytes + attachment.size > maximumBytes) continue;
      included.add(attachment.id);
      usedBytes += attachment.size;
    }
  }
  return included;
}
