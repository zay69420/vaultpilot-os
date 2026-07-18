import { ItemView, MarkdownRenderer, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type { AgentCallbacks, ChatImageAttachment, ChatMessage, ChatSession, ImageAttachmentInput, ToolApprovalRequest, VaultPilotSettings } from "../types";
import { createId } from "../utils/id";
import {
  displayImageName,
  formatBytes,
  IMAGE_FILE_ACCEPT,
  imageLimits,
  totalAttachmentBytes,
  validateImageCandidate
} from "../utils/imageAttachments";
import { composerEnterKeyHint, shouldSubmitComposerKey } from "../utils/mobile";

export const CHAT_VIEW_TYPE = "vaultpilot-os-chat";

export interface ChatViewHost {
  getSettings(): VaultPilotSettings;
  getActiveSession(): ChatSession;
  getImageAttachmentBlob(id: string): Promise<Blob | null>;
  sendChat(message: string, imageAttachments: ImageAttachmentInput[], callbacks: AgentCallbacks): Promise<void>;
  newChat(): void;
  archiveAllChats(): Promise<number>;
  stopChat(): void;
  openSettings(): void;
  isChatRunning(): boolean;
}

interface PendingImageAttachment {
  input: ImageAttachmentInput;
  previewUrl: string;
}

export class VaultPilotChatView extends ItemView {
  private messagesEl: HTMLElement | null = null;
  private usageEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private attachmentButton: HTMLButtonElement | null = null;
  private attachmentInput: HTMLInputElement | null = null;
  private attachmentPreviewEl: HTMLElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private pendingImages: PendingImageAttachment[] = [];
  private messagePreviewUrls = new Set<string>();
  private renderGeneration = 0;
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
    this.clearPendingImages();
    this.releaseMessagePreviews();
  }

  refresh(): void {
    this.renderMessages();
    this.renderUsage();
    this.setRunning(this.host.isChatRunning());
    this.syncAttachmentAvailability();
  }

  focusInput(): void {
    this.inputEl?.focus();
  }

  async submitExternal(prompt: string): Promise<void> {
    this.clearPendingImages();
    if (this.inputEl) this.inputEl.value = prompt;
    await this.submit();
  }

  private renderShell(): void {
    this.clearPendingImages();
    this.releaseMessagePreviews();
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
    this.attachmentPreviewEl = composer.createDiv({ cls: "vaultpilot-attachment-preview" });
    this.attachmentPreviewEl.hide();
    this.attachmentButton = iconButton(composer, "image-plus", "Attach images", () => this.attachmentInput?.click());
    this.attachmentButton.addClass("vaultpilot-attach");
    this.attachmentInput = composer.createEl("input", {
      cls: "vaultpilot-file-input",
      attr: {
        type: "file",
        accept: IMAGE_FILE_ACCEPT,
        multiple: "",
        "aria-label": "Choose images for VaultPilot OS"
      }
    });
    this.attachmentInput.addEventListener("change", () => {
      const files = Array.from(this.attachmentInput?.files ?? []);
      if (this.attachmentInput) this.attachmentInput.value = "";
      void this.addImageFiles(files);
    });
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
    this.inputEl.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      void this.addImageFiles(files);
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
    this.syncAttachmentAvailability();
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.renderGeneration += 1;
    const generation = this.renderGeneration;
    this.releaseMessagePreviews();
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
      if (!message.content && !message.attachments?.length) continue;
      const bubble = this.createBubble(message.role);
      if (message.role === "assistant") void this.renderMarkdown(bubble, message.content);
      else void this.renderUserMessage(bubble, message, generation);
    }
    this.scrollToBottom();
  }

  private async submit(): Promise<void> {
    const value = this.inputEl?.value.trim() ?? "";
    if ((!value && this.pendingImages.length === 0) || this.host.isChatRunning() || !this.messagesEl) return;
    const submittedImages = this.pendingImages;
    this.pendingImages = [];
    const displayValue = value || "Analyze the attached image or images.";
    if (this.inputEl) this.inputEl.value = "";
    this.renderAttachmentPreview();
    if (this.messagesEl.querySelector(".vaultpilot-empty")) this.messagesEl.empty();
    this.renderPendingUserMessage(this.createBubble("user"), displayValue, submittedImages);
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
      await this.host.sendChat(value, submittedImages.map((attachment) => attachment.input), callbacks);
    } catch (error) {
      if (!assistantText) assistantText = error instanceof Error ? error.message : String(error);
    } finally {
      for (const attachment of submittedImages) globalThis.URL.revokeObjectURL(attachment.previewUrl);
      assistantBubble.removeClass("is-streaming");
      if (assistantText) await this.renderMarkdown(assistantBubble, assistantText);
      else assistantBubble.remove();
      this.setStatus(null);
      this.setRunning(false);
      this.renderUsage();
      this.renderMessages();
      if (!Platform.isMobile) this.inputEl?.focus();
    }
  }

  private async renderUserMessage(element: HTMLElement, message: ChatMessage, generation: number): Promise<void> {
    element.empty();
    if (message.attachments?.length) {
      const gallery = element.createDiv({ cls: "vaultpilot-message-images" });
      for (const attachment of message.attachments) {
        const item = this.createImageTile(gallery, attachment);
        try {
          const blob = await this.host.getImageAttachmentBlob(attachment.id);
          if (!blob || generation !== this.renderGeneration || !item.isConnected) continue;
          const url = globalThis.URL.createObjectURL(blob);
          this.messagePreviewUrls.add(url);
          this.setTileImage(item, url, attachment.name);
        } catch {
          item.addClass("is-unavailable");
        }
      }
    }
    if (message.content) element.createDiv({ cls: "vaultpilot-user-text", text: message.content });
  }

  private renderPendingUserMessage(element: HTMLElement, content: string, attachments: PendingImageAttachment[]): void {
    if (attachments.length) {
      const gallery = element.createDiv({ cls: "vaultpilot-message-images" });
      for (const attachment of attachments) {
        const item = this.createImageTile(gallery, attachment.input);
        this.setTileImage(item, attachment.previewUrl, attachment.input.name);
      }
    }
    if (content) element.createDiv({ cls: "vaultpilot-user-text", text: content });
  }

  private createImageTile(container: HTMLElement, attachment: ChatImageAttachment): HTMLElement {
    const item = container.createDiv({ cls: "vaultpilot-image-tile", attr: { title: `${attachment.name} · ${formatBytes(attachment.size)}` } });
    const fallback = item.createDiv({ cls: "vaultpilot-image-fallback" });
    setIcon(fallback, "image");
    item.createDiv({ cls: "vaultpilot-image-name", text: attachment.name });
    return item;
  }

  private setTileImage(item: HTMLElement, url: string, name: string): void {
    const fallback = item.querySelector<HTMLElement>(".vaultpilot-image-fallback");
    const image = item.createEl("img", { cls: "vaultpilot-image-thumbnail", attr: { src: url, alt: name } });
    image.addEventListener("load", () => fallback?.hide(), { once: true });
    image.addEventListener("error", () => {
      image.hide();
      fallback?.show();
      item.addClass("is-unavailable");
    }, { once: true });
  }

  private async addImageFiles(files: File[]): Promise<void> {
    const settings = this.host.getSettings();
    if (!settings.imageUploadsEnabled) {
      this.setStatus("Image uploads are disabled in settings.");
      return;
    }
    const limits = imageLimits(settings.maxImagesPerMessage, settings.maxImageSizeMb, settings.maxImageRequestMb);
    let count = this.pendingImages.length;
    let bytes = totalAttachmentBytes(this.pendingImages.map((attachment) => attachment.input));
    let lastError = "";
    for (const file of files) {
      try {
        const mimeType = validateImageCandidate(file, count, bytes, limits);
        const data = await file.arrayBuffer();
        if (data.byteLength !== file.size) throw new Error(`${displayImageName(file.name)} could not be read completely.`);
        const input: ImageAttachmentInput = {
          id: createId("image"),
          name: displayImageName(file.name),
          mimeType,
          size: file.size,
          data
        };
        this.pendingImages.push({ input, previewUrl: globalThis.URL.createObjectURL(file) });
        count += 1;
        bytes += file.size;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.renderAttachmentPreview();
    this.setStatus(lastError || (this.pendingImages.length ? `${this.pendingImages.length} image${this.pendingImages.length === 1 ? "" : "s"} ready.` : null));
    if (!lastError && this.pendingImages.length) {
      this.containerEl.win.setTimeout(() => {
        if (!this.host.isChatRunning()) this.setStatus(null);
      }, 1800);
    }
  }

  private renderAttachmentPreview(): void {
    if (!this.attachmentPreviewEl) return;
    this.attachmentPreviewEl.empty();
    this.attachmentPreviewEl.toggle(this.pendingImages.length > 0);
    for (const pending of this.pendingImages) {
      const card = this.attachmentPreviewEl.createDiv({ cls: "vaultpilot-pending-image" });
      const image = card.createEl("img", {
        attr: { src: pending.previewUrl, alt: pending.input.name },
        cls: "vaultpilot-pending-thumbnail"
      });
      image.addEventListener("error", () => image.addClass("is-unavailable"), { once: true });
      const details = card.createDiv({ cls: "vaultpilot-pending-details" });
      details.createDiv({ cls: "vaultpilot-pending-name", text: pending.input.name });
      details.createDiv({ cls: "vaultpilot-pending-size", text: formatBytes(pending.input.size) });
      const remove = card.createEl("button", {
        cls: "clickable-icon vaultpilot-remove-image",
        attr: { "aria-label": `Remove ${pending.input.name}`, title: `Remove ${pending.input.name}` }
      });
      setIcon(remove, "x");
      remove.disabled = this.host.isChatRunning();
      remove.addEventListener("click", () => this.removePendingImage(pending.input.id));
    }
  }

  private removePendingImage(id: string): void {
    const pending = this.pendingImages.find((attachment) => attachment.input.id === id);
    if (pending) globalThis.URL.revokeObjectURL(pending.previewUrl);
    this.pendingImages = this.pendingImages.filter((attachment) => attachment.input.id !== id);
    this.renderAttachmentPreview();
    if (this.pendingImages.length === 0) this.setStatus(null);
  }

  private clearPendingImages(): void {
    for (const attachment of this.pendingImages) globalThis.URL.revokeObjectURL(attachment.previewUrl);
    this.pendingImages = [];
    this.renderAttachmentPreview();
  }

  private releaseMessagePreviews(): void {
    for (const url of this.messagePreviewUrls) globalThis.URL.revokeObjectURL(url);
    this.messagePreviewUrls.clear();
  }

  private syncAttachmentAvailability(): void {
    const enabled = this.host.getSettings().imageUploadsEnabled;
    this.attachmentButton?.toggle(enabled);
    if (this.attachmentInput) this.attachmentInput.disabled = !enabled || this.host.isChatRunning();
    if (!enabled && this.pendingImages.length) this.clearPendingImages();
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
    if (this.attachmentButton) this.attachmentButton.disabled = running;
    if (this.attachmentInput) this.attachmentInput.disabled = running || !this.host.getSettings().imageUploadsEnabled;
    if (this.sendButton) {
      this.sendButton.disabled = false;
      this.sendButton.setText(running ? "Stop" : "Send");
      this.sendButton.toggleClass("mod-warning", running);
    }
    this.renderAttachmentPreview();
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
