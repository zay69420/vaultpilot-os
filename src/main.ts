import { MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { isForbiddenVaultPath } from "./security/pathGuard";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings/defaults";
import { AgentService } from "./services/agentService";
import { AuditService } from "./services/auditService";
import { ArchiveService } from "./services/archiveService";
import { GeminiClient } from "./services/geminiClient";
import { IndexService } from "./services/indexService";
import { IntegrationService } from "./services/integrationService";
import { MemoryService } from "./services/memoryService";
import { obsidianGeminiTransport } from "./services/obsidianTransport";
import { SearchService } from "./services/searchService";
import { ToolRegistry } from "./services/toolRegistry";
import { AttachmentStore } from "./storage/attachmentStore";
import { SessionStore } from "./storage/sessionStore";
import { VectorStore } from "./storage/vectorStore";
import type { AgentCallbacks, ChatMessage, ChatSession, CustomCommand, ImageAttachmentInput, IntegrationStatus, MemoryEntry, PersistedData, ToolAuditEntry, VaultPilotSettings } from "./types";
import { createId } from "./utils/id";
import { imageLimits, validateImageCandidate } from "./utils/imageAttachments";
import { CHAT_VIEW_TYPE, VaultPilotChatView, type ChatViewHost } from "./ui/chatView";
import { VaultPilotSettingTab, type SettingsHost } from "./ui/settingsTab";
import { VaultPilotPriorityBasesView } from "./ui/priorityBasesView";

export default class VaultPilotPlugin extends Plugin implements ChatViewHost, SettingsHost {
  private config: VaultPilotSettings = { ...DEFAULT_SETTINGS };
  private sessions!: SessionStore;
  private gemini!: GeminiClient;
  private vectors!: VectorStore;
  private attachments!: AttachmentStore;
  private indexer!: IndexService;
  private search!: SearchService;
  private integrations!: IntegrationService;
  private audit!: AuditService;
  private tools!: ToolRegistry;
  private memory!: MemoryService;
  private agent!: AgentService;
  private archive!: ArchiveService;
  private activeController: AbortController | null = null;
  private statusBarEl: HTMLElement | null = null;
  private saveHandle: number | null = null;
  private basesViewRegistered = false;
  private registeredCustomCommandIds = new Set<string>();
  private vaultId = "";

  async onload(): Promise<void> {
    let startupStage = "loading saved data";
    try {
    const stored = (await this.loadData()) as Partial<PersistedData> | null;
    this.config = mergeSettings(stored?.settings);
    const legacyApiKey = this.config.apiKey.trim();
    const secretId = this.config.apiKeySecretId.trim() || DEFAULT_SETTINGS.apiKeySecretId;
    if (legacyApiKey && !this.app.secretStorage.getSecret(secretId)) {
      this.app.secretStorage.setSecret(secretId, legacyApiKey);
    }
    this.config.apiKeySecretId = secretId;
    this.config.apiKey = this.app.secretStorage.getSecret(secretId) ?? "";
    this.vaultId = stored?.vaultId?.trim() || createId("vault");
    this.sessions = new SessionStore(stored?.sessions, stored?.activeSessionId, () => this.scheduleSave());
    startupStage = "opening local vector storage";
    this.gemini = new GeminiClient(
      () => this.config,
      obsidianGeminiTransport,
      { streaming: !Platform.isMobile }
    );
    const vaultIdentifier = `${this.app.vault.getName()}:${this.vaultId}`;
    this.vectors = new VectorStore(vaultIdentifier);
    this.attachments = new AttachmentStore(vaultIdentifier);
    await Promise.all([this.vectors.open(), this.attachments.open()]);
    await this.attachments.prune(this.sessions.allAttachmentIds());
    startupStage = "creating services";
    this.indexer = new IndexService(this.app, this.vectors, this.gemini, () => this.config);
    this.search = new SearchService(this.app, this.vectors, this.gemini, () => this.config);
    this.integrations = new IntegrationService(this.app, () => this.config);
    this.audit = new AuditService(this.app, stored?.toolAudit, () => this.scheduleSave());
    this.tools = new ToolRegistry(this.app, this.search, this.integrations, this.audit, () => this.config);
    this.memory = new MemoryService(this.app, this.gemini, () => this.config);
    this.agent = new AgentService(
      this.gemini,
      this.memory,
      this.tools,
      () => this.config,
      () => this.sessions.context(
        this.config.conversationHistoryLimit,
        (id) => this.attachments.get(id),
        this.config.maxImageRequestMb * 1024 * 1024
      )
    );
    this.archive = new ArchiveService(this.app, () => this.config, (id) => this.attachments.get(id));

    startupStage = "registering the Obsidian interface";
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new VaultPilotChatView(leaf, this));
    if (this.config.integrations.bases) this.registerPriorityBasesView();
    this.addRibbonIcon("bot", "Open VaultPilot OS", () => void this.activateChat());
    if (!Platform.isMobile) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addClass("vaultpilot-statusbar");
      this.statusBarEl.addEventListener("click", () => void this.activateChat());
    }
    this.addSettingTab(new VaultPilotSettingTab(this));
    this.registerCoreCommands();
    this.registerCustomCommands();
    this.registerVaultEvents();
    this.updateStatusBar();
    this.scheduleSave();

    startupStage = "scheduling workspace initialization";
    this.app.workspace.onLayoutReady(() => {
      void this.initializeAfterLayout();
    });
    } catch (error) {
      console.error(`VaultPilot OS startup failed during ${startupStage}`, error);
      new Notice(`VaultPilot OS startup failed during ${startupStage}: ${errorMessage(error)}`, 30_000);
      throw error;
    }
  }

  onunload(): void {
    this.activeController?.abort();
    if (this.saveHandle !== null) window.clearTimeout(this.saveHandle);
    void this.persistNow();
    this.indexer?.dispose();
    this.attachments?.close();
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  getSettings(): VaultPilotSettings {
    return this.config;
  }

  getActiveSession(): ChatSession {
    return this.sessions.active();
  }

  async getImageAttachmentBlob(id: string): Promise<Blob | null> {
    const attachment = await this.attachments.get(id);
    if (!attachment || attachment.data.byteLength !== attachment.size) return null;
    return new Blob([attachment.data], { type: attachment.mimeType });
  }

  async insertIntoActiveNote(content: string): Promise<string> {
    const file = this.app.workspace.getActiveFile();
    if (!file || isForbiddenVaultPath(file.path)) throw new Error("Open a safe Markdown note before inserting the response.");
    await this.tools.execute("edit_note", { path: file.path, operation: "append", content }, `Insert response into "${file.path}"`);
    return file.path;
  }

  isChatRunning(): boolean {
    return this.activeController !== null;
  }

  async updateSettings(patch: Partial<VaultPilotSettings>): Promise<void> {
    this.config = mergeSettings({ ...this.config, ...patch });
    if (patch.apiKeySecretId !== undefined) {
      this.config.apiKey = this.app.secretStorage.getSecret(this.config.apiKeySecretId) ?? "";
    }
    this.registerCustomCommands();
    if (patch.integrations?.bases) this.registerPriorityBasesView();
    this.updateStatusBar();
    this.refreshViews();
    this.scheduleSave();
    if (patch.memoryEnabled === true || patch.memoryFolder !== undefined) {
      await this.memory.initialize().catch((error) => new Notice(errorMessage(error), 7000));
    }
  }

  getIntegrationStatuses(): IntegrationStatus[] {
    return this.integrations.statuses();
  }

  getToolAuditEntries(): ToolAuditEntry[] {
    return this.audit.entries(40);
  }

  async getMemoryEntries(): Promise<MemoryEntry[]> {
    return this.memory.listEntries();
  }

  async forgetMemory(category: MemoryEntry["category"], key: string): Promise<boolean> {
    return this.memory.forget(category, key);
  }

  clearToolAudit(): void {
    this.audit.clear();
  }

  async undoLatestToolChange(): Promise<string> {
    const entry = await this.audit.undoLatest();
    this.refreshViews();
    return entry.description;
  }

  async testGeminiConnection(): Promise<string> {
    return this.gemini.testConnection();
  }

  async rebuildSearchIndex(): Promise<void> {
    if (!this.config.apiKey.trim()) throw new Error("Add a Gemini API key before rebuilding the index.");
    let lastNoticeAt = 0;
    await this.indexer.rebuild((progress) => {
      const now = Date.now();
      if (progress.total > 0 && now - lastNoticeAt > 5000) {
        lastNoticeAt = now;
        new Notice(`VaultPilot indexing ${progress.completed}/${progress.total}: ${progress.currentPath ?? ""}`, 2500);
      }
    });
  }

  async sendChat(message: string, imageAttachments: ImageAttachmentInput[], callbacks: AgentCallbacks): Promise<void> {
    if (this.activeController) throw new Error("A VaultPilot response is already running.");
    const normalizedMessage = message.trim() || (imageAttachments.length ? "Analyze the attached image or images." : "");
    if (!normalizedMessage) throw new Error("Enter a message or attach an image first.");
    if (imageAttachments.length && !this.config.imageUploadsEnabled) throw new Error("Image uploads are disabled in VaultPilot settings.");
    this.validateImageAttachments(imageAttachments);
    const controller = new AbortController();
    this.activeController = controller;
    let assistant: ChatMessage | null = null;
    let response = "";
    const sessionId = this.sessions.activeSessionId();

    try {
      const storedAttachments = await this.attachments.saveMany(imageAttachments);
      this.sessions.addMessage("user", normalizedMessage, storedAttachments);
      assistant = this.sessions.addMessage("assistant", "");
      const assistantId = assistant.id;
      const wrapped: AgentCallbacks = {
        ...callbacks,
        onText: (delta) => {
          response += delta;
          this.sessions.updateMessage(assistantId, response, sessionId);
          callbacks.onText(delta);
        },
        onUsage: (usage) => {
          this.sessions.addUsage(usage, sessionId);
          this.updateStatusBar();
          callbacks.onUsage(usage);
        }
      };
      await this.agent.run(normalizedMessage, wrapped, controller.signal);
      if (!response.trim()) {
        response = "No response was returned.";
        this.sessions.updateMessage(assistantId, response, sessionId);
        callbacks.onText(response);
      }
    } catch (error) {
      if (!assistant) {
        await this.attachments.deleteMany(imageAttachments.map((attachment) => attachment.id)).catch(() => undefined);
        throw error;
      }
      const stopped = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      if (!response.trim()) {
        response = stopped ? "Stopped." : `Error: ${errorMessage(error)}`;
        this.sessions.updateMessage(assistant.id, response, sessionId);
        callbacks.onText(response);
      }
      if (!stopped) throw error;
    } finally {
      this.activeController = null;
      this.updateStatusBar();
      this.scheduleSave();
    }
  }

  stopChat(): void {
    this.activeController?.abort();
  }

  newChat(): void {
    if (this.activeController) return;
    this.sessions.newSession();
    this.updateStatusBar();
    this.refreshViews();
  }

  async archiveAllChats(): Promise<number> {
    if (this.activeController) throw new Error("Stop the current response before archiving.");
    const result = await this.archive.archiveAll(this.sessions.all());
    const attachmentIds = this.sessions.attachmentIdsForSessions(result.sessionIds);
    this.sessions.removeSessions(result.sessionIds);
    await this.attachments.deleteMany(attachmentIds);
    this.updateStatusBar();
    this.refreshViews();
    this.scheduleSave();
    return result.paths.length;
  }

  private validateImageAttachments(attachments: ImageAttachmentInput[]): void {
    const limits = imageLimits(this.config.maxImagesPerMessage, this.config.maxImageSizeMb, this.config.maxImageRequestMb);
    const ids = new Set<string>();
    let totalBytes = 0;
    for (const attachment of attachments) {
      if (!attachment.id || ids.has(attachment.id)) throw new Error("An image attachment has an invalid identifier.");
      const mimeType = validateImageCandidate(
        { name: attachment.name, type: attachment.mimeType, size: attachment.size },
        ids.size,
        totalBytes,
        limits
      );
      if (mimeType !== attachment.mimeType || attachment.data.byteLength !== attachment.size) {
        throw new Error(`${attachment.name} changed while it was being attached. Select it again.`);
      }
      ids.add(attachment.id);
      totalBytes += attachment.size;
    }
  }

  openSettings(): void {
    const appWithSettings = this.app as typeof this.app & {
      setting: { open(): void; openTabById(id: string): void };
    };
    appWithSettings.setting.open();
    appWithSettings.setting.openTabById(this.manifest.id);
  }

  private async initializeAfterLayout(): Promise<void> {
    await this.memory.initialize().catch((error) => console.warn("VaultPilot OS memory initialization failed", error));
    if (this.config.autoIndexOnStartup && this.config.apiKey.trim()) {
      await this.indexer.indexChangedFiles(undefined).catch((error) => {
        console.error("VaultPilot OS startup indexing failed", error);
        new Notice(`VaultPilot indexing paused: ${errorMessage(error)}`, 8000);
      });
    }
  }

  private registerPriorityBasesView(): void {
    if (this.basesViewRegistered) return;
    this.basesViewRegistered = this.registerBasesView("vaultpilot-priority", {
      name: "VaultPilot Priority",
      icon: "list-checks",
      factory: (controller, containerEl) => new VaultPilotPriorityBasesView(controller, containerEl)
    });
  }

  private registerCoreCommands(): void {
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.activateChat()
    });
    this.addCommand({
      id: "open-settings",
      name: "Open settings",
      callback: () => this.openSettings()
    });
    this.addCommand({
      id: "new-chat",
      name: "Start new conversation",
      callback: () => {
        this.newChat();
        void this.activateChat();
      }
    });
    this.addCommand({
      id: "archive-all-chats",
      name: "Archive all conversations",
      callback: () => void this.archiveAllChats().then((count) => new Notice(count ? `Archived ${count} conversation${count === 1 ? "" : "s"}.` : "No conversations to archive."))
    });
    this.addCommand({
      id: "rebuild-vector-index",
      name: "Rebuild local vector index",
      callback: () => void this.rebuildSearchIndex().then(() => new Notice("VaultPilot OS index rebuilt.")).catch((error) => new Notice(errorMessage(error), 8000))
    });
    this.addCommand({
      id: "undo-last-change",
      name: "Undo last VaultPilot file change",
      callback: () => void this.undoLatestToolChange()
        .then((description) => new Notice(`Undid: ${description}`))
        .catch((error) => new Notice(errorMessage(error), 8000))
    });
    this.addCommand({
      id: "refresh-productivity-dashboard",
      name: "Refresh productivity dashboard",
      callback: () => void this.tools.execute("refresh_productivity_dashboard", {}, "Refresh productivity dashboard")
        .then(() => new Notice("VaultPilot dashboard refreshed."))
        .catch((error) => new Notice(errorMessage(error), 8000))
    });
    this.addCommand({
      id: "create-daily-briefing",
      name: "Create daily briefing",
      callback: () => void this.activateChat().then((view) => view.submitExternal("Create a concise daily briefing from my open tasks, active projects, and relevant recent vault context, then write it to today's daily note."))
    });
    this.addCommand({
      id: "plan-my-day",
      name: "Plan my day",
      callback: () => void this.activateChat().then((view) => view.submitExternal("Review my open and overdue tasks and relevant project notes. Produce a realistic prioritized plan for today with time blocks, dependencies, and a short fallback plan."))
    });
  }

  private registerCustomCommands(): void {
    for (const command of this.config.customCommands) {
      const id = `custom-${safeCommandId(command.id)}`;
      if (!command.name.trim() || !command.prompt.trim() || this.registeredCustomCommandIds.has(id)) continue;
      this.registeredCustomCommandIds.add(id);
      this.addCommand({
        id,
        name: command.name,
        callback: () => void this.runCustomCommand(command.id)
      });
    }
  }

  private async runCustomCommand(commandId: string): Promise<void> {
    const command = this.config.customCommands.find((candidate) => candidate.id === commandId);
    if (!command) {
      new Notice("That VaultPilot custom command no longer exists. Reload the plugin to refresh the Command Palette.");
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    let currentNote = "";
    let currentNotePath = "";
    if (activeFile && !isForbiddenVaultPath(activeFile.path)) {
      currentNotePath = activeFile.path;
      currentNote = await this.app.vault.cachedRead(activeFile);
    }
    const selection = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getSelection() ?? "";
    const prompt = expandCommand(command, { currentNote, currentNotePath, selection });
    const view = await this.activateChat();
    await view.submitExternal(prompt);
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      this.search.invalidateGraph();
      if (file instanceof TFile && file.extension.toLocaleLowerCase() === "md") this.indexer.scheduleFile(file);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      this.search.invalidateGraph();
      if (file instanceof TFile && file.extension.toLocaleLowerCase() === "md") this.indexer.scheduleFile(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.search.invalidateGraph();
      this.indexer.scheduleFile(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.search.invalidateGraph();
      this.indexer.scheduleFile(oldPath);
      if (file instanceof TFile && file.extension.toLocaleLowerCase() === "md") this.indexer.scheduleFile(file);
    }));
  }

  private async activateChat(): Promise<VaultPilotChatView> {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = Platform.isMobile
        ? this.app.workspace.getLeaf("tab")
        : this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (Platform.isMobile) this.app.workspace.setActiveLeaf(leaf, { focus: false });
    const view = leaf.view;
    if (!(view instanceof VaultPilotChatView)) throw new Error("Could not open the VaultPilot OS chat view.");
    view.refresh();
    if (!Platform.isMobile) view.focusInput();
    return view;
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof VaultPilotChatView) leaf.view.refresh();
    }
  }

  private updateStatusBar(): void {
    if (Platform.isMobile || !this.statusBarEl) return;
    this.statusBarEl.toggle(this.config.showStatusBarCost);
    if (!this.config.showStatusBarCost) return;
    const usage = this.sessions.active().usage;
    this.statusBarEl.setText(`VaultPilot $${usage.costUsd.toFixed(4)}`);
    this.statusBarEl.setAttr("aria-label", "Open VaultPilot OS chat");
    this.statusBarEl.setAttr("title", `${usage.inputTokens} input · ${usage.outputTokens} output tokens`);
  }

  private scheduleSave(): void {
    if (this.saveHandle !== null) window.clearTimeout(this.saveHandle);
    this.saveHandle = window.setTimeout(() => {
      this.saveHandle = null;
      void this.persistNow();
    }, 250);
  }

  private async persistNow(): Promise<void> {
    if (!this.sessions) return;
    const data: PersistedData = {
      settings: { ...this.config, apiKey: "" },
      sessions: this.sessions.all(),
      activeSessionId: this.sessions.activeSessionId(),
      vaultId: this.vaultId,
      toolAudit: this.audit?.entries(300).reverse()
    };
    await this.saveData(data);
  }
}

function expandCommand(
  command: CustomCommand,
  values: { currentNote: string; currentNotePath: string; selection: string }
): string {
  return command.prompt
    .replaceAll("{{currentNote}}", values.currentNote)
    .replaceAll("{{currentNotePath}}", values.currentNotePath)
    .replaceAll("{{selection}}", values.selection);
}

function safeCommandId(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "command";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
