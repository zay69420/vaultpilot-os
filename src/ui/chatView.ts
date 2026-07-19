import { ItemView, MarkdownRenderer, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type { AgentCallbacks, ChatImageAttachment, ChatMessage, ChatSession, CommandCenterSnapshot, ImageAttachmentInput, MemoryEntry, ToolApprovalRequest, VaultPilotSettings } from "../types";
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
import { initialTabForViewMode, type CommandCenterTab, type VaultPilotViewMode } from "../utils/viewMode";

export const CHAT_VIEW_TYPE = "vaultpilot-os-chat";
export const COMMAND_CENTER_VIEW_TYPE = "vaultpilot-os-command-center";

export interface ChatViewHost {
  getSettings(): VaultPilotSettings;
  getActiveSession(): ChatSession;
  getCommandCenterSnapshot(): Promise<CommandCenterSnapshot>;
  getMemoryEntries(): Promise<MemoryEntry[]>;
  getImageAttachmentBlob(id: string): Promise<Blob | null>;
  insertIntoActiveNote(content: string): Promise<string>;
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
  private navigationEl: HTMLElement | null = null;
  private activeTab: CommandCenterTab;
  private pendingImages: PendingImageAttachment[] = [];
  private messagePreviewUrls = new Set<string>();
  private renderGeneration = 0;
  private pendingApprovals = new Set<(allowed: boolean) => void>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: ChatViewHost,
    private readonly mode: VaultPilotViewMode = "compact"
  ) {
    super(leaf);
    this.activeTab = initialTabForViewMode(mode);
  }

  getViewType(): string {
    return this.mode === "command-center" ? COMMAND_CENTER_VIEW_TYPE : CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.mode === "command-center" ? "VaultPilot Command Center" : "VaultPilot Chat";
  }

  getIcon(): string {
    return this.mode === "command-center" ? "layout-dashboard" : "bot";
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
    this.activeTab = "chat";
    this.renderNavigation();
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
    container.toggleClass("vaultpilot-compact", this.mode === "compact");
    container.toggleClass("vaultpilot-command-center", this.mode === "command-center");
    container.toggleClass("vaultpilot-mobile", Platform.isMobile);
    const settings = this.host.getSettings();
    container.toggleClass("vaultpilot-reduce-motion", settings.reduceMotion);
    container.toggleClass("vaultpilot-high-contrast", settings.highContrast);
    container.toggleClass("vaultpilot-large-targets", settings.largeTouchTargets);
    container.style.setProperty("--vp-interface-scale", `${settings.interfaceScale / 100}`);

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
      this.activeTab = "chat";
      this.refresh();
    });
    iconButton(actions, "archive", "Archive all conversations", () => void this.archiveAll());
    iconButton(actions, "settings", "Open VaultPilot settings", () => this.host.openSettings());

    this.statusEl = container.createDiv({ cls: "vaultpilot-status", attr: { "aria-live": settings.screenReaderAnnouncements ? "polite" : "off", role: "status" } });
    this.statusEl.hide();
    this.messagesEl = container.createDiv({ cls: "vaultpilot-messages", attr: { role: "log", "aria-live": settings.screenReaderAnnouncements ? "polite" : "off", "aria-label": "VaultPilot conversation" } });

    const composer = container.createDiv({ cls: "vaultpilot-composer" });
    this.attachmentPreviewEl = composer.createDiv({ cls: "vaultpilot-attachment-preview" });
    this.attachmentPreviewEl.hide();
    this.attachmentButton = iconButton(composer, "image-plus", Platform.isMobile ? "Attach or take a photo" : "Attach images", () => this.attachmentInput?.click());
    this.attachmentButton.addClass("vaultpilot-attach");
    this.attachmentInput = composer.createEl("input", {
      cls: "vaultpilot-file-input",
      attr: {
        type: "file",
        accept: Platform.isMobile ? "image/*" : IMAGE_FILE_ACCEPT,
        multiple: "",
        "aria-label": Platform.isMobile ? "Choose or take images for VaultPilot OS" : "Choose images for VaultPilot OS"
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
      if (event.key === "Escape" && this.host.isChatRunning()) {
        event.preventDefault();
        this.denyPendingApprovals();
        this.host.stopChat();
        return;
      }
      if (shouldSubmitComposerKey(event, Platform.isMobile)) {
        event.preventDefault();
        void this.submit();
      }
    });
    if (settings.voiceInputEnabled) this.addDictationButton(composer);
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

    if (this.mode === "command-center") {
      this.navigationEl = container.createDiv({ cls: "vaultpilot-navigation", attr: { role: "tablist", "aria-label": "VaultPilot sections" } });
      this.renderNavigation();
    } else {
      this.navigationEl = null;
    }

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
    if (this.mode === "command-center" && this.activeTab === "today") {
      this.renderCommandCenter(generation);
      return;
    }
    if (this.mode === "command-center" && this.activeTab === "search") {
      this.renderSearchCenter();
      return;
    }
    if (this.mode === "command-center" && this.activeTab === "memory") {
      this.renderMemoryCenter(generation);
      return;
    }
    const session = this.host.getActiveSession();
    if (session.messages.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: "vaultpilot-empty" });
      const icon = empty.createDiv({ cls: "vaultpilot-empty-icon" });
      setIcon(icon, "sparkles");
      empty.createEl("h3", { text: "Start a conversation" });
      empty.createEl("p", { text: "Ask about your vault, connect ideas, or request an action." });
      const quick = empty.createDiv({ cls: "vaultpilot-quick-actions", attr: { "aria-label": "Suggested actions" } });
      const activePath = this.app.workspace.getActiveFile()?.path;
      quickAction(quick, "Plan my day", "Review my open and overdue tasks and relevant project notes, then create a realistic prioritized plan for today.", (prompt) => void this.submitExternal(prompt));
      quickAction(quick, "Current note summary", activePath ? `Read "${activePath}" and summarize it with key decisions and next actions.` : "Ask me to open a note, then summarize it.", (prompt) => void this.submitExternal(prompt));
      quickAction(quick, "Refresh dashboard", "Refresh my productivity dashboard using open tasks and relevant project context.", (prompt) => void this.submitExternal(prompt));
      quickAction(quick, "Study this note", activePath ? `Read "${activePath}" and create an accessible study plan and practice questions for it.` : "Ask me to open a note, then create a study plan.", (prompt) => void this.submitExternal(prompt));
      return;
    }
    for (const message of session.messages) {
      if (!message.content && !message.attachments?.length) continue;
      const bubble = this.createBubble(message.role);
      if (message.role === "assistant") void this.renderMarkdown(bubble, message.content).then(() => this.addResponseActions(bubble, message.content));
      else void this.renderUserMessage(bubble, message, generation);
    }
    this.scrollToBottom();
  }

  private renderNavigation(): void {
    if (this.mode !== "command-center" || !this.navigationEl) return;
    this.navigationEl.empty();
    const tabs: Array<{ id: CommandCenterTab; label: string; icon: string }> = [
      { id: "today", label: "Today", icon: "house" },
      { id: "chat", label: "Chat", icon: "message-circle" },
      { id: "search", label: "Search", icon: "search" },
      { id: "memory", label: "Memory", icon: "brain" }
    ];
    for (const tab of tabs) {
      const button = this.navigationEl.createEl("button", {
        cls: `vaultpilot-navigation-item${this.activeTab === tab.id ? " is-active" : ""}`,
        attr: {
          role: "tab",
          "aria-selected": String(this.activeTab === tab.id),
          "aria-label": tab.label
        }
      });
      const icon = button.createSpan({ cls: "vaultpilot-navigation-icon" });
      setIcon(icon, tab.icon);
      button.createSpan({ text: tab.label });
      button.disabled = this.host.isChatRunning() && tab.id !== "chat";
      button.addEventListener("click", () => {
        if (this.host.isChatRunning() && tab.id !== "chat") return;
        this.activeTab = tab.id;
        this.renderNavigation();
        this.renderMessages();
      });
    }
  }

  private renderCommandCenter(generation: number): void {
    if (!this.messagesEl) return;
    const root = this.messagesEl.createDiv({ cls: "vaultpilot-dashboard", attr: { "aria-busy": "true" } });
    const loading = root.createDiv({ cls: "vaultpilot-dashboard-loading" });
    const loadingIcon = loading.createSpan();
    setIcon(loadingIcon, "loader-circle");
    loading.createSpan({ text: "Preparing today’s command center…" });

    void this.host.getCommandCenterSnapshot().then((snapshot) => {
      if (generation !== this.renderGeneration || this.activeTab !== "today" || !root.isConnected) return;
      root.empty();
      root.setAttr("aria-busy", "false");
      const hero = root.createDiv({ cls: "vaultpilot-dashboard-hero" });
      const heading = hero.createDiv();
      heading.createEl("h2", { text: "Today" });
      heading.createDiv({ text: snapshot.dateLabel, cls: "vaultpilot-dashboard-date" });
      const plan = hero.createEl("button", { cls: "vaultpilot-plan-day mod-cta" });
      const planIcon = plan.createSpan();
      setIcon(planIcon, "sparkles");
      plan.createSpan({ text: "Plan my day" });
      plan.addEventListener("click", () => void this.submitExternal("Review my open and overdue tasks and relevant project notes, then create a realistic prioritized plan for today with time blocks and a fallback plan."));

      const grid = root.createDiv({ cls: "vaultpilot-dashboard-grid" });
      this.renderTasksCard(grid, snapshot);
      this.renderProjectsCard(grid, snapshot);
      this.renderRecentNotesCard(grid, snapshot);
      this.renderBriefingCard(grid, snapshot);
    }).catch((error) => {
      if (generation !== this.renderGeneration || !root.isConnected) return;
      root.empty();
      const failed = root.createDiv({ cls: "vaultpilot-dashboard-error" });
      setIcon(failed.createSpan(), "circle-alert");
      failed.createSpan({ text: `Could not prepare the dashboard: ${error instanceof Error ? error.message : String(error)}` });
    });
  }

  private renderTasksCard(container: HTMLElement, snapshot: CommandCenterSnapshot): void {
    const card = dashboardCard(container, "list-checks", "Priority tasks", snapshot.tasks.length ? `${snapshot.tasks.length} ready` : "All clear");
    const body = card.createDiv({ cls: "vaultpilot-dashboard-list" });
    if (!snapshot.tasks.length) {
      body.createDiv({ cls: "vaultpilot-dashboard-empty", text: "No open tasks were found in recently active notes." });
      return;
    }
    for (const task of snapshot.tasks.slice(0, 4)) {
      const row = body.createEl("button", { cls: "vaultpilot-dashboard-row vaultpilot-task-row" });
      const checkbox = row.createSpan({ cls: "vaultpilot-task-checkbox", attr: { "aria-hidden": "true" } });
      setIcon(checkbox, "square");
      const content = row.createSpan({ cls: "vaultpilot-dashboard-row-content" });
      content.createSpan({ cls: "vaultpilot-dashboard-row-title", text: cleanTaskText(task.text) });
      content.createSpan({ cls: "vaultpilot-dashboard-row-meta", text: task.due ? `${task.overdue ? "Overdue" : "Due"} ${friendlyDate(task.due)}` : task.path });
      if (task.overdue) row.addClass("is-overdue");
      row.addEventListener("click", () => void this.openVaultPath(task.path));
    }
  }

  private renderProjectsCard(container: HTMLElement, snapshot: CommandCenterSnapshot): void {
    const card = dashboardCard(container, "folder-kanban", "Active projects", snapshot.projects.length ? `${snapshot.projects.length} in progress` : "No projects detected");
    const body = card.createDiv({ cls: "vaultpilot-dashboard-list" });
    if (!snapshot.projects.length) {
      body.createDiv({ cls: "vaultpilot-dashboard-empty", text: "Add type: project or status: active to project note properties to feature them here." });
      return;
    }
    for (const project of snapshot.projects) {
      const row = body.createEl("button", { cls: "vaultpilot-dashboard-row vaultpilot-project-row" });
      const content = row.createSpan({ cls: "vaultpilot-dashboard-row-content" });
      content.createSpan({ cls: "vaultpilot-dashboard-row-title", text: project.name });
      content.createSpan({ cls: "vaultpilot-dashboard-row-meta", text: relativeTime(project.updatedAt) });
      if (project.progress !== undefined) {
        const progress = row.createSpan({ cls: "vaultpilot-project-progress", attr: { "aria-label": `${project.progress}% complete` } });
        progress.createSpan({ cls: "vaultpilot-project-progress-fill", attr: { style: `width:${project.progress}%` } });
        row.createSpan({ cls: "vaultpilot-project-percent", text: `${project.progress}%` });
      }
      row.addEventListener("click", () => void this.openVaultPath(project.path));
    }
  }

  private renderRecentNotesCard(container: HTMLElement, snapshot: CommandCenterSnapshot): void {
    const card = dashboardCard(container, "notebook-tabs", "Recent notes", "Recently updated");
    const body = card.createDiv({ cls: "vaultpilot-dashboard-list" });
    for (const note of snapshot.recentNotes.slice(0, 4)) {
      const row = body.createEl("button", { cls: "vaultpilot-dashboard-row" });
      const noteIcon = row.createSpan({ cls: "vaultpilot-row-icon" });
      setIcon(noteIcon, "file-text");
      const content = row.createSpan({ cls: "vaultpilot-dashboard-row-content" });
      content.createSpan({ cls: "vaultpilot-dashboard-row-title", text: note.name });
      content.createSpan({ cls: "vaultpilot-dashboard-row-meta", text: relativeTime(note.updatedAt) });
      row.addEventListener("click", () => void this.openVaultPath(note.path));
    }
  }

  private renderBriefingCard(container: HTMLElement, snapshot: CommandCenterSnapshot): void {
    const card = dashboardCard(container, "lightbulb", "Daily briefing", "Vault activity at a glance");
    const body = card.createDiv({ cls: "vaultpilot-briefing-list" });
    for (const item of snapshot.briefing) {
      const row = body.createDiv({ cls: "vaultpilot-briefing-item" });
      const icon = row.createSpan();
      setIcon(icon, "target");
      row.createSpan({ text: item });
    }
    const action = card.createEl("button", { cls: "vaultpilot-card-action", text: "Create a detailed briefing" });
    action.addEventListener("click", () => void this.submitExternal("Create a concise daily briefing from my open tasks, active projects, and relevant recent vault context. Include priorities, risks, and next actions."));
  }

  private renderSearchCenter(): void {
    if (!this.messagesEl) return;
    const root = this.messagesEl.createDiv({ cls: "vaultpilot-center-view" });
    centerHeading(root, "search", "Search", "Ask focused questions across notes, links, and current information.");
    const actions = root.createDiv({ cls: "vaultpilot-center-actions" });
    const activePath = this.app.workspace.getActiveFile()?.path;
    commandCenterAction(actions, "scan-search", "Search the vault", "Find notes, passages, and connected ideas", () => this.preparePrompt("Search my vault for the most relevant notes and passages about: "));
    commandCenterAction(actions, "waypoints", "Find related notes", "Combine semantic, keyword, and graph evidence", () => activePath ? void this.submitExternal(`Find notes most closely related to "${activePath}" and explain the connections.`) : this.preparePrompt("Find notes related to: "));
    commandCenterAction(actions, "globe", "Search the web", "Look up current information with citations", () => this.preparePrompt("Search the web for current, reliable information about: "));
    commandCenterAction(actions, "git-compare-arrows", "Compare sources", "Contrast multiple notes or external sources", () => this.preparePrompt("Compare these sources, identify agreements and conflicts, and cite the evidence: "));
  }

  private renderMemoryCenter(generation: number): void {
    if (!this.messagesEl) return;
    const root = this.messagesEl.createDiv({ cls: "vaultpilot-center-view", attr: { "aria-busy": "true" } });
    centerHeading(root, "brain", "Memory", "Review the context VaultPilot can retrieve before answering.");
    const list = root.createDiv({ cls: "vaultpilot-memory-cards" });
    list.createDiv({ cls: "vaultpilot-dashboard-loading", text: "Loading memory…" });
    void this.host.getMemoryEntries().then((entries) => {
      if (generation !== this.renderGeneration || this.activeTab !== "memory" || !root.isConnected) return;
      root.setAttr("aria-busy", "false");
      list.empty();
      if (!entries.length) {
        list.createDiv({ cls: "vaultpilot-dashboard-empty", text: "No long-term memory has been saved yet." });
        return;
      }
      for (const entry of entries.slice(0, 12)) {
        const card = list.createDiv({ cls: "vaultpilot-memory-card" });
        const meta = card.createDiv({ cls: "vaultpilot-memory-meta" });
        meta.createSpan({ text: entry.category.replaceAll("_", " ") });
        meta.createSpan({ text: `${Math.round(entry.confidence * 100)}% confidence` });
        card.createDiv({ cls: "vaultpilot-memory-content", text: entry.content });
        card.createDiv({ cls: "vaultpilot-memory-source", text: entry.source });
      }
    }).catch((error) => {
      if (generation !== this.renderGeneration || !list.isConnected) return;
      list.empty();
      list.createDiv({ cls: "vaultpilot-dashboard-error", text: error instanceof Error ? error.message : String(error) });
    });
  }

  private async openVaultPath(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      this.setStatus(`Could not find ${path}.`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private preparePrompt(prompt: string): void {
    this.activeTab = "chat";
    this.renderNavigation();
    this.renderMessages();
    if (this.inputEl) {
      this.inputEl.value = prompt;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(prompt.length, prompt.length);
    }
  }

  private async submit(): Promise<void> {
    const value = this.inputEl?.value.trim() ?? "";
    if ((!value && this.pendingImages.length === 0) || this.host.isChatRunning() || !this.messagesEl) return;
    const submittedImages = this.pendingImages;
    this.pendingImages = [];
    const displayValue = value || "Analyze the attached image or images.";
    if (this.inputEl) this.inputEl.value = "";
    this.activeTab = "chat";
    this.renderNavigation();
    this.renderAttachmentPreview();
    this.messagesEl.empty();
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
      if (assistantText) {
        await this.renderMarkdown(assistantBubble, assistantText);
        this.addResponseActions(assistantBubble, assistantText);
      }
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
      const card = container.createDiv({ cls: `vaultpilot-approval risk-${request.risk}`, attr: { role: "alertdialog", "aria-label": request.description } });
      const heading = card.createDiv({ cls: "vaultpilot-approval-title" });
      const icon = heading.createSpan();
      setIcon(icon, request.risk === "write" ? "file-pen-line" : request.risk === "sync" ? "cloud" : request.risk === "network" ? "globe" : "search");
      heading.createSpan({ text: request.description });
      card.createEl("pre", { text: request.preview || JSON.stringify(request.call.args, null, 2) });
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
      allow.focus();
      this.scrollToBottom();
    });
  }

  private addToolEvent(container: HTMLElement, description: string, state: "running"): void {
    const event = container.createDiv({ cls: `vaultpilot-tool-event is-${state}`, attr: { role: "status" } });
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

  private addResponseActions(bubble: HTMLElement, content: string): void {
    if (!content.trim() || bubble.querySelector(".vaultpilot-response-actions")) return;
    const actions = bubble.createDiv({ cls: "vaultpilot-response-actions", attr: { role: "group", "aria-label": "Response actions" } });
    responseAction(actions, "copy", "Copy response", async () => {
      await this.containerEl.win.navigator.clipboard.writeText(content);
      this.setStatus("Response copied.");
    });
    responseAction(actions, "file-plus-2", "Insert into active note", async () => {
      const path = await this.host.insertIntoActiveNote(content);
      this.setStatus(`Inserted into ${path}. Use Undo last VaultPilot change if needed.`);
    });
    if (this.host.getSettings().readAloudEnabled && "speechSynthesis" in this.containerEl.win) {
      responseAction(actions, "volume-2", "Read response aloud", async () => {
        this.containerEl.win.speechSynthesis.cancel();
        this.containerEl.win.speechSynthesis.speak(new SpeechSynthesisUtterance(content.replace(/[`#*_\[\]]/g, " ")));
      });
    }
  }

  private addDictationButton(composer: HTMLElement): void {
    type RecognitionEvent = Event & { results?: ArrayLike<{ 0?: { transcript?: string } }> };
    type Recognition = {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      start(): void;
      stop(): void;
      onresult: ((event: RecognitionEvent) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
    };
    const recognitionWindow = this.containerEl.win as Window & {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Constructor = recognitionWindow.SpeechRecognition ?? recognitionWindow.webkitSpeechRecognition;
    if (!Constructor) return;
    const button = iconButton(composer, "mic", "Dictate message", () => {
      if (button.getAttribute("aria-pressed") === "true") {
        recognition.stop();
        return;
      }
      button.setAttr("aria-pressed", "true");
      this.setStatus("Listening…");
      recognition.start();
    });
    button.addClass("vaultpilot-dictation");
    button.setAttr("aria-pressed", "false");
    const recognition = new Constructor();
    recognition.lang = this.containerEl.doc.documentElement.lang || "en-AU";
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      const transcripts: string[] = [];
      for (let index = 0; index < (event.results?.length ?? 0); index += 1) {
        const transcript = event.results?.[index]?.[0]?.transcript;
        if (transcript) transcripts.push(transcript.trim());
      }
      if (this.inputEl && transcripts.length) {
        this.inputEl.value = `${this.inputEl.value}${this.inputEl.value && !this.inputEl.value.endsWith(" ") ? " " : ""}${transcripts.join(" ")}`;
      }
    };
    recognition.onerror = () => this.setStatus("Dictation was unavailable or permission was denied.");
    recognition.onend = () => {
      button.setAttr("aria-pressed", "false");
      if (!this.host.isChatRunning()) this.setStatus(null);
      this.inputEl?.focus();
    };
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
    this.renderNavigation();
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

function dashboardCard(container: HTMLElement, iconName: string, title: string, subtitle: string): HTMLElement {
  const card = container.createDiv({ cls: "vaultpilot-dashboard-card" });
  const header = card.createDiv({ cls: "vaultpilot-dashboard-card-header" });
  const icon = header.createSpan({ cls: "vaultpilot-dashboard-card-icon" });
  setIcon(icon, iconName);
  const copy = header.createDiv({ cls: "vaultpilot-dashboard-card-copy" });
  copy.createEl("h3", { text: title });
  copy.createDiv({ text: subtitle });
  return card;
}

function centerHeading(container: HTMLElement, iconName: string, title: string, description: string): void {
  const heading = container.createDiv({ cls: "vaultpilot-center-heading" });
  const icon = heading.createSpan();
  setIcon(icon, iconName);
  const copy = heading.createDiv();
  copy.createEl("h2", { text: title });
  copy.createEl("p", { text: description });
}

function commandCenterAction(container: HTMLElement, iconName: string, title: string, description: string, run: () => void): void {
  const button = container.createEl("button", { cls: "vaultpilot-center-action" });
  const icon = button.createSpan({ cls: "vaultpilot-center-action-icon" });
  setIcon(icon, iconName);
  const copy = button.createSpan({ cls: "vaultpilot-center-action-copy" });
  copy.createSpan({ cls: "vaultpilot-center-action-title", text: title });
  copy.createSpan({ cls: "vaultpilot-center-action-description", text: description });
  const arrow = button.createSpan({ cls: "vaultpilot-center-action-arrow" });
  setIcon(arrow, "chevron-right");
  button.addEventListener("click", run);
}

function cleanTaskText(value: string): string {
  return value
    .replace(/(?:📅\s*|due::\s*)\d{4}-\d{2}-\d{2}/gi, "")
    .replace(/[🔺⏫🔼🔽⏬]/g, "")
    .trim();
}

function friendlyDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(parsed);
}

function relativeTime(timestamp: number): string {
  const difference = Date.now() - timestamp;
  const minutes = Math.max(0, Math.round(difference / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
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

function quickAction(container: HTMLElement, label: string, prompt: string, run: (prompt: string) => void): void {
  const button = container.createEl("button", { cls: "vaultpilot-quick-action", text: label });
  button.addEventListener("click", () => run(prompt));
}

function responseAction(container: HTMLElement, iconName: string, label: string, run: () => Promise<void>): void {
  const button = iconButton(container, iconName, label, () => {
    button.disabled = true;
    void run().catch(() => undefined).finally(() => { button.disabled = false; });
  });
  button.addClass("vaultpilot-response-action");
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
