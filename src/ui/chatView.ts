import { ItemView, MarkdownRenderer, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type { AgentCallbacks, ChatSession, ToolApprovalRequest, VaultPilotSettings } from "../types";
import { composerEnterKeyHint, shouldSubmitComposerKey } from "../utils/mobile";

export const CHAT_VIEW_TYPE = "vaultpilot-os-chat";

export interface ChatViewHost {
  getSettings(): VaultPilotSettings;
  getActiveSession(): ChatSession;
  sendChat(message: string, callbacks: AgentCallbacks): Promise<void>;
  newChat(): void;
  archiveAllChats(): Promise<number>;
  stopChat(): void;
  openSettings(): void;
  isChatRunning(): boolean;
}

export class VaultPilotChatView extends ItemView {
  private messagesEl: HTMLElement | null = null;
  private usageEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private pendingApprovals = new Set<(allowed: boolean) => void>();

  constructor(leaf: WorkspaceLeaf, private readonly host: ChatViewHost) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "VaultPilot OS";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
  }

  async onClose(): Promise<void> {
    for (const resolve of this.pendingApprovals) resolve(false);
    this.pendingApprovals.clear();
  }

  refresh(): void {
    this.renderMessages();
    this.renderUsage();
    this.setRunning(this.host.isChatRunning());
  }

  focusInput(): void {
    this.inputEl?.focus();
  }

  async submitExternal(prompt: string): Promise<void> {
    if (this.inputEl) this.inputEl.value = prompt;
    await this.submit();
  }

  private renderShell(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("vaultpilot-view");
    container.toggleClass("vaultpilot-mobile", Platform.isMobile);

    const header = container.createDiv({ cls: "vaultpilot-header" });
    const identity = header.createDiv({ cls: "vaultpilot-identity" });
    const logo = identity.createSpan({ cls: "vaultpilot-logo" });
    setIcon(logo, "bot");
    identity.createDiv({ text: "VaultPilot OS", cls: "vaultpilot-title" });
    this.usageEl = identity.createDiv({ cls: "vaultpilot-usage" });

    const actions = header.createDiv({ cls: "vaultpilot-header-actions" });
    iconButton(actions, "plus", "New conversation", () => {
      if (this.host.isChatRunning()) return;
      this.host.newChat();
      this.refresh();
    });
    iconButton(actions, "archive", "Archive all conversations", () => void this.archiveAll());
    iconButton(actions, "settings", "Open VaultPilot settings", () => this.host.openSettings());

    this.statusEl = container.createDiv({ cls: "vaultpilot-status", attr: { "aria-live": "polite" } });
    this.statusEl.hide();
    this.messagesEl = container.createDiv({ cls: "vaultpilot-messages", attr: { role: "log", "aria-live": "polite" } });

    const composer = container.createDiv({ cls: "vaultpilot-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "vaultpilot-input",
      attr: {
        placeholder: "Ask about your vault or request an action…",
        rows: "3",
        "aria-label": "Message VaultPilot OS",
        enterkeyhint: composerEnterKeyHint(Platform.isMobile)
      }
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (shouldSubmitComposerKey(event, Platform.isMobile)) {
        event.preventDefault();
        void this.submit();
      }
    });
    this.sendButton = composer.createEl("button", { cls: "vaultpilot-send mod-cta", text: "Send" });
    this.sendButton.addEventListener("click", () => {
      if (this.host.isChatRunning()) {
        this.denyPendingApprovals();
        this.host.stopChat();
      }
      else void this.submit();
    });

    this.renderMessages();
    this.renderUsage();
    this.setRunning(this.host.isChatRunning());
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    const session = this.host.getActiveSession();
    if (session.messages.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: "vaultpilot-empty" });
      const icon = empty.createDiv({ cls: "vaultpilot-empty-icon" });
      setIcon(icon, "sparkles");
      empty.createEl("h3", { text: "Your vault, with an agent at the controls" });
      empty.createEl("p", { text: "Search notes, connect ideas, work with files, or look up current information." });
      return;
    }
    for (const message of session.messages) {
      if (!message.content) continue;
      const bubble = this.createBubble(message.role);
      if (message.role === "assistant") void this.renderMarkdown(bubble, message.content);
      else bubble.setText(message.content);
    }
    this.scrollToBottom();
  }

  private async submit(): Promise<void> {
    const value = this.inputEl?.value.trim() ?? "";
    if (!value || this.host.isChatRunning() || !this.messagesEl) return;
    if (this.inputEl) this.inputEl.value = "";
    if (this.messagesEl.querySelector(".vaultpilot-empty")) this.messagesEl.empty();
    this.createBubble("user").setText(value);
    const assistantBubble = this.createBubble("assistant");
    assistantBubble.addClass("is-streaming");
    const events = this.messagesEl.createDiv({ cls: "vaultpilot-tool-events" });
    let assistantText = "";
    this.setRunning(true);
    this.setStatus("Thinking…");
    this.scrollToBottom();

    const callbacks: AgentCallbacks = {
      onText: (delta) => {
        assistantText += delta;
        assistantBubble.setText(assistantText);
        this.setStatus(null);
        this.scrollToBottom();
      },
      onToolStart: (description) => this.addToolEvent(events, description, "running"),
      onToolEnd: (description, ok) => this.completeToolEvent(events, description, ok),
      onApproval: (request) => this.requestApproval(events, request),
      onUsage: () => this.renderUsage(),
      onMemoryStatus: (status) => this.setStatus(status)
    };

    try {
      await this.host.sendChat(value, callbacks);
    } catch (error) {
      if (!assistantText) assistantText = error instanceof Error ? error.message : String(error);
    } finally {
      assistantBubble.removeClass("is-streaming");
      if (assistantText) await this.renderMarkdown(assistantBubble, assistantText);
      else assistantBubble.remove();
      this.setStatus(null);
      this.setRunning(false);
      this.renderUsage();
      this.scrollToBottom();
      if (!Platform.isMobile) this.inputEl?.focus();
    }
  }

  private createBubble(role: "user" | "assistant"): HTMLElement {
    if (!this.messagesEl) throw new Error("Chat view is not open.");
    const row = this.messagesEl.createDiv({ cls: `vaultpilot-message-row is-${role}` });
    const label = row.createDiv({ cls: "vaultpilot-message-label", text: role === "user" ? "You" : "VaultPilot" });
    label.setAttr("aria-hidden", "true");
    return row.createDiv({ cls: `vaultpilot-bubble vaultpilot-${role}` });
  }

  private async renderMarkdown(element: HTMLElement, content: string): Promise<void> {
    element.empty();
    await MarkdownRenderer.render(this.app, content, element, "", this);
  }

  private requestApproval(container: HTMLElement, request: ToolApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const card = container.createDiv({ cls: `vaultpilot-approval risk-${request.risk}` });
      const heading = card.createDiv({ cls: "vaultpilot-approval-title" });
      const icon = heading.createSpan();
      setIcon(icon, request.risk === "write" ? "file-pen-line" : request.risk === "network" ? "globe" : "search");
      heading.createSpan({ text: request.description });
      card.createEl("pre", { text: JSON.stringify(request.call.args, null, 2) });
      const actions = card.createDiv({ cls: "vaultpilot-approval-actions" });
      const allow = actions.createEl("button", { text: "Allow", cls: "mod-cta" });
      const deny = actions.createEl("button", { text: "Deny" });
      let settled = false;
      const settle = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        this.pendingApprovals.delete(settle);
        allow.disabled = true;
        deny.disabled = true;
        card.addClass(approved ? "is-approved" : "is-denied");
        card.createDiv({ cls: "vaultpilot-approval-result", text: approved ? "Allowed" : "Denied" });
        resolve(approved);
      };
      this.pendingApprovals.add(settle);
      allow.addEventListener("click", () => settle(true));
      deny.addEventListener("click", () => settle(false));
      this.scrollToBottom();
    });
  }

  private addToolEvent(container: HTMLElement, description: string, state: "running"): void {
    const event = container.createDiv({ cls: `vaultpilot-tool-event is-${state}` });
    event.dataset.description = description;
    const icon = event.createSpan();
    setIcon(icon, "loader-circle");
    event.createSpan({ text: description });
    this.setStatus("Using a tool…");
    this.scrollToBottom();
  }

  private completeToolEvent(container: HTMLElement, description: string, ok: boolean): void {
    const candidates = Array.from(container.querySelectorAll<HTMLElement>(".vaultpilot-tool-event:not(.is-done)"));
    const event = candidates.reverse().find((candidate) => candidate.dataset.description === description);
    if (!event) return;
    event.addClass("is-done", ok ? "is-ok" : "is-error");
    event.removeClass("is-running");
    const icon = event.querySelector<HTMLElement>("span");
    if (icon) setIcon(icon, ok ? "check" : "x");
    this.setStatus(null);
  }

  private renderUsage(): void {
    if (!this.usageEl) return;
    const usage = this.host.getActiveSession().usage;
    this.usageEl.setText(`${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · $${usage.costUsd.toFixed(4)}`);
    this.usageEl.setAttr("title", "Session input tokens, output tokens, and approximate USD cost");
  }

  private setRunning(running: boolean): void {
    if (this.inputEl) this.inputEl.disabled = running;
    if (this.sendButton) {
      this.sendButton.disabled = false;
      this.sendButton.setText(running ? "Stop" : "Send");
      this.sendButton.toggleClass("mod-warning", running);
    }
  }

  private setStatus(value: string | null): void {
    if (!this.statusEl) return;
    if (value) {
      this.statusEl.setText(value);
      this.statusEl.show();
    } else {
      this.statusEl.hide();
      this.statusEl.empty();
    }
  }

  private async archiveAll(): Promise<void> {
    if (this.host.isChatRunning()) return;
    const count = await this.host.archiveAllChats();
    this.refresh();
    this.setStatus(count ? `Archived ${count} conversation${count === 1 ? "" : "s"}.` : "No conversations to archive.");
    this.containerEl.win.setTimeout(() => this.setStatus(null), 3000);
  }

  private denyPendingApprovals(): void {
    for (const resolve of [...this.pendingApprovals]) resolve(false);
  }

  private scrollToBottom(): void {
    if (!this.messagesEl) return;
    this.containerEl.win.requestAnimationFrame(() => {
      if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }
}

function iconButton(container: HTMLElement, iconName: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = container.createEl("button", {
    cls: "clickable-icon vaultpilot-icon-button",
    attr: { "aria-label": label, title: label }
  });
  setIcon(button, iconName);
  button.addEventListener("click", onClick);
  return button;
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
