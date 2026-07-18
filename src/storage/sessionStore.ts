import type { ChatMessage, ChatSession, GeminiContent, TokenUsage } from "../types";
import { createId } from "../utils/id";
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

  addMessage(role: "user" | "assistant", content: string): ChatMessage {
    const session = this.active();
    const message: ChatMessage = { id: createId("message"), role, content, createdAt: Date.now() };
    session.messages.push(message);
    session.updatedAt = message.createdAt;
    if (role === "user" && session.messages.filter((item) => item.role === "user").length === 1) {
      session.title = sanitizeTopic(content);
    }
    this.onChange();
    return message;
  }

  updateMessage(id: string, content: string): void {
    const message = this.active().messages.find((candidate) => candidate.id === id);
    if (!message) return;
    message.content = content;
    this.active().updatedAt = Date.now();
    this.onChange();
  }

  addUsage(usage: TokenUsage): void {
    const total = this.active().usage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    total.costUsd += usage.costUsd;
    this.onChange();
  }

  context(historySessionLimit: number): GeminiContent[] {
    const active = this.active();
    const previous = this.sessions
      .filter((session) => session.id !== active.id && session.messages.length > 0)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, historySessionLimit)
      .reverse();
    const output: GeminiContent[] = [];
    for (const session of [...previous, active]) {
      const messages = session.messages.slice(-20);
      for (const message of messages) {
        if (!message.content.trim()) continue;
        output.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] });
      }
    }
    return trimContext(output, 60_000);
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
    messages: Array.isArray(session.messages) ? session.messages : [],
    usage: { ...EMPTY_USAGE(), ...(session.usage ?? {}) }
  };
}

function trimContext(contents: GeminiContent[], maximumCharacters: number): GeminiContent[] {
  const output: GeminiContent[] = [];
  let used = 0;
  for (const content of [...contents].reverse()) {
    const length = content.parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
    if (used + length > maximumCharacters && output.length > 0) break;
    output.unshift(content);
    used += length;
  }
  return output;
}
