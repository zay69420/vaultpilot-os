import { Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { CustomCommand, DiagnosticEntry, IntegrationStatus, MemoryEntry, ToolAuditEntry, ToolPolicy, VaultPilotSettings } from "../types";
import { createId } from "../utils/id";

export interface SettingsHost {
  getSettings(): VaultPilotSettings;
  updateSettings(patch: Partial<VaultPilotSettings>): Promise<void>;
  testGeminiConnection(): Promise<string>;
  rebuildSearchIndex(): Promise<void>;
  getIntegrationStatuses(): IntegrationStatus[];
  getToolAuditEntries(): ToolAuditEntry[];
  getMemoryEntries(): Promise<MemoryEntry[]>;
  forgetMemory(category: MemoryEntry["category"], key: string): Promise<boolean>;
  clearToolAudit(): void;
  undoLatestToolChange(): Promise<string>;
  getDiagnosticEntries(): DiagnosticEntry[];
  getDiagnosticsPath(): string;
  clearDiagnostics(): Promise<void>;
  exportDiagnostics(): Promise<string>;
}

export class VaultPilotSettingTab extends PluginSettingTab {
  constructor(private readonly host: SettingsHost) {
    const plugin = host as unknown as Plugin;
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.host.getSettings();
    containerEl.empty();
    containerEl.addClass("vaultpilot-settings");
    containerEl.toggleClass("vaultpilot-settings-mobile", Platform.isMobile);
    new Setting(containerEl).setName("VaultPilot OS").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Local-first Gemini agent settings. Your selected key is stored in Obsidian SecretStorage and sent only to Google's Gemini API."
    });

    new Setting(containerEl).setName("Gemini API").setHeading();
    new Setting(containerEl)
      .setName("API key")
      .setDesc("Choose or create a Gemini key in Obsidian SecretStorage. Standard and AQ. key formats are accepted unchanged.")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(settings.apiKeySecretId)
        .onChange(async (apiKeySecretId) => this.host.updateSettings({ apiKeySecretId })));
    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Makes a minimal token-count request; it does not expose the key in the interface or logs.")
      .addButton((button) => button.setButtonText("Test connection").onClick(async () => {
        button.setDisabled(true).setButtonText("Testing…");
        try {
          new Notice(await this.host.testGeminiConnection());
        } catch (error) {
          new Notice(errorMessage(error), 8000);
        } finally {
          button.setDisabled(false).setButtonText("Test connection");
        }
      }));
    textSetting(containerEl, "Chat model", "Gemini model used for agent turns.", settings.model, (model) => this.host.updateSettings({ model }));
    textSetting(containerEl, "Embedding model", "Model used to build and query the local vector index.", settings.embeddingModel, (embeddingModel) => this.host.updateSettings({ embeddingModel }));

    new Setting(containerEl).setName("Image attachments").setHeading();
    new Setting(containerEl)
      .setName("Enable image uploads")
      .setDesc("Adds a desktop/mobile image picker to chat. Images are stored in local IndexedDB and sent only to Gemini with the message that needs them.")
      .addToggle((toggle) => toggle
        .setValue(settings.imageUploadsEnabled)
        .onChange(async (imageUploadsEnabled) => this.host.updateSettings({ imageUploadsEnabled })));
    numberSetting(containerEl, "Images per message", "Maximum number of PNG, JPEG, WebP, HEIC, or HEIF attachments in one message.", settings.maxImagesPerMessage, 1, 8, 1, (maxImagesPerMessage) => this.host.updateSettings({ maxImagesPerMessage }));
    numberSetting(containerEl, "Per-image limit (MB)", "Rejects unusually large images before reading or storing them.", settings.maxImageSizeMb, 1, 12, 1, (maxImageSizeMb) => this.host.updateSettings({ maxImageSizeMb }));
    numberSetting(containerEl, "Image request budget (MB)", "Caps raw image bytes retained in a Gemini request so base64 data plus prompts stay below the inline request limit.", settings.maxImageRequestMb, 1, 12, 1, (maxImageRequestMb) => this.host.updateSettings({ maxImageRequestMb }));

    new Setting(containerEl).setName("Agent behavior").setHeading();
    new Setting(containerEl)
      .setName("Tool execution")
      .setDesc("Quick preset. Fine-grained policies below control each action category.")
      .addDropdown((dropdown) => dropdown
        .addOption("automatic", "Automatic execution")
        .addOption("manual", "Manual approval")
        .setValue(settings.executionMode)
        .onChange(async (value) => {
          const executionMode = value as "automatic" | "manual";
          await this.host.updateSettings({
            executionMode,
            toolPolicies: executionMode === "manual"
              ? { read: "manual", network: "manual", write: "manual", sync: "manual" }
              : { read: "automatic", network: "manual", write: "manual", sync: "manual" }
          });
          this.display();
        }));
    policySetting(containerEl, "Vault reads and searches", "Read-only actions can usually run safely in the background.", settings.toolPolicies.read, (read) => this.host.updateSettings({ toolPolicies: { ...this.host.getSettings().toolPolicies, read } }));
    policySetting(containerEl, "Public web requests", "Controls DuckDuckGo searches and other public network requests.", settings.toolPolicies.network, (network) => this.host.updateSettings({ toolPolicies: { ...this.host.getSettings().toolPolicies, network } }));
    policySetting(containerEl, "Vault and task changes", "Shows an exact preview when approval is required. Successful changes are logged and undoable.", settings.toolPolicies.write, (write) => this.host.updateSettings({ toolPolicies: { ...this.host.getSettings().toolPolicies, write } }));
    policySetting(containerEl, "Sync actions", "Sync always asks for confirmation, even if Automatic is selected.", settings.toolPolicies.sync, (sync) => this.host.updateSettings({ toolPolicies: { ...this.host.getSettings().toolPolicies, sync } }), false);
    numberSetting(containerEl, "Maximum agent steps", "Stops runaway tool loops, then asks Gemini for a final answer.", settings.maxAgentSteps, 1, 20, 1, (maxAgentSteps) => this.host.updateSettings({ maxAgentSteps }));
    numberSetting(containerEl, "Maximum output tokens", "Upper output-token budget per Gemini turn.", settings.maxOutputTokens, 256, 65536, 256, (maxOutputTokens) => this.host.updateSettings({ maxOutputTokens }));
    numberSetting(containerEl, "Temperature", "Lower values are more deterministic.", settings.temperature, 0, 2, 0.1, (temperature) => this.host.updateSettings({ temperature }));
    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Hidden instruction prepended to each agent request. The security path guard cannot be overridden here.")
      .addTextArea((area) => {
        area.inputEl.rows = 12;
        area.inputEl.addClass("vaultpilot-wide-textarea");
        area.setValue(settings.systemPrompt).onChange(async (systemPrompt) => this.host.updateSettings({ systemPrompt }));
      });

    new Setting(containerEl).setName("Tokens and approximate cost").setHeading();
    new Setting(containerEl)
      .setName("Show status-bar cost")
      .setDesc(Platform.isMobile
        ? "Obsidian mobile has no bottom status bar. Cost remains visible in the VaultPilot chat header."
        : "Displays the active session's approximate USD cost in Obsidian's bottom status bar.")
      .addToggle((toggle) => toggle
        .setValue(settings.showStatusBarCost)
        .setDisabled(Platform.isMobile)
        .onChange(async (showStatusBarCost) => this.host.updateSettings({ showStatusBarCost })));
    numberSetting(containerEl, "Input price per million", "USD per 1,000,000 input tokens for the configured model and tier.", settings.inputPricePerMillion, 0, 1000, 0.01, (inputPricePerMillion) => this.host.updateSettings({ inputPricePerMillion }));
    numberSetting(containerEl, "Output price per million", "USD per 1,000,000 output and thinking tokens.", settings.outputPricePerMillion, 0, 1000, 0.01, (outputPricePerMillion) => this.host.updateSettings({ outputPricePerMillion }));

    new Setting(containerEl).setName("Local vector index and hybrid search").setHeading();
    new Setting(containerEl)
      .setName("Auto-index on startup")
      .setDesc("Embeds only new, modified, or removed Markdown notes after the workspace is ready.")
      .addToggle((toggle) => toggle.setValue(settings.autoIndexOnStartup).onChange(async (autoIndexOnStartup) => this.host.updateSettings({ autoIndexOnStartup })));
    new Setting(containerEl)
      .setName("Index file changes")
      .setDesc("Debounces vault create, modify, rename, and delete events into IndexedDB updates.")
      .addToggle((toggle) => toggle.setValue(settings.indexOnFileChange).onChange(async (indexOnFileChange) => this.host.updateSettings({ indexOnFileChange })));
    numberSetting(containerEl, "Embedding dimensions", "Smaller vectors save browser storage. Rebuild after changing.", settings.embeddingDimensions, 128, 3072, 128, (embeddingDimensions) => this.host.updateSettings({ embeddingDimensions }));
    numberSetting(containerEl, "Chunk size", "Approximate characters per Markdown chunk.", settings.chunkSize, 500, 12000, 100, (chunkSize) => this.host.updateSettings({ chunkSize }));
    numberSetting(containerEl, "Chunk overlap", "Characters repeated across adjacent chunks.", settings.chunkOverlap, 0, Math.max(0, settings.chunkSize - 1), 20, (chunkOverlap) => this.host.updateSettings({ chunkOverlap }));
    numberSetting(containerEl, "Maximum chunks per file", "Caps indexing work for unusually large notes.", settings.maxChunksPerFile, 1, 1000, 1, (maxChunksPerFile) => this.host.updateSettings({ maxChunksPerFile }));
    numberSetting(containerEl, "Embedding batch size", "Sends multiple chunks per embedding request for faster, cheaper indexing. Falls back safely if batching is unavailable.", settings.embeddingBatchSize, 1, 100, 1, (embeddingBatchSize) => this.host.updateSettings({ embeddingBatchSize }));
    numberSetting(containerEl, "Search result cache", "Number of recent searches kept in memory. Set to 0 to disable.", settings.searchCacheSize, 0, 200, 5, (searchCacheSize) => this.host.updateSettings({ searchCacheSize }));
    new Setting(containerEl)
      .setName("Allow indexing on mobile")
      .setDesc("Turn off to search the existing index without background embedding work on phones or tablets.")
      .addToggle((toggle) => toggle.setValue(settings.mobileIndexingEnabled).onChange(async (mobileIndexingEnabled) => this.host.updateSettings({ mobileIndexingEnabled })));
    numberSetting(containerEl, "Semantic weight", "Relative contribution from embedding similarity.", settings.semanticWeight, 0, 1, 0.05, (semanticWeight) => this.host.updateSettings({ semanticWeight }));
    numberSetting(containerEl, "Lexical weight", "Relative contribution from exact terms and phrase matches.", settings.lexicalWeight, 0, 1, 0.05, (lexicalWeight) => this.host.updateSettings({ lexicalWeight }));
    numberSetting(containerEl, "Graph weight", "Relative first-degree linked-note and backlink boost.", settings.graphWeight, 0, 1, 0.05, (graphWeight) => this.host.updateSettings({ graphWeight }));
    numberSetting(containerEl, "Search result limit", "Default number of notes returned to the agent.", settings.searchResultLimit, 1, 30, 1, (searchResultLimit) => this.host.updateSettings({ searchResultLimit }));
    new Setting(containerEl)
      .setName("Rebuild vector index")
      .setDesc("Clears only VaultPilot's IndexedDB records and embeds the vault again. No vault files are deleted.")
      .addButton((button) => button.setWarning().setButtonText("Rebuild index").onClick(async () => {
        button.setDisabled(true).setButtonText("Rebuilding…");
        try {
          await this.host.rebuildSearchIndex();
          new Notice("VaultPilot OS index rebuilt.");
        } catch (error) {
          new Notice(errorMessage(error), 8000);
        } finally {
          button.setDisabled(false).setButtonText("Rebuild index");
        }
      }));

    new Setting(containerEl).setName("Long-term memory").setHeading();
    new Setting(containerEl)
      .setName("Enable memory")
      .setDesc("Uses segmented Markdown memory notes and pre-query retrieval.")
      .addToggle((toggle) => toggle.setValue(settings.memoryEnabled).onChange(async (memoryEnabled) => this.host.updateSettings({ memoryEnabled })));
    textSetting(containerEl, "Memory folder", "Dedicated vault folder, separate from conversation archives. .obsidian is forbidden.", settings.memoryFolder, (memoryFolder) => this.host.updateSettings({ memoryFolder }));
    new Setting(containerEl)
      .setName("Proactive memory intercept")
      .setDesc("Before the main response, a lightweight Gemini pass extracts durable facts and updates memory when warranted.")
      .addToggle((toggle) => toggle.setValue(settings.memoryInterceptEnabled).onChange(async (memoryInterceptEnabled) => this.host.updateSettings({ memoryInterceptEnabled })));
    new Setting(containerEl)
      .setName("Memory update timing")
      .setDesc("Background keeps chat responsive. Blocking finishes durable-memory review before answering.")
      .addDropdown((dropdown) => dropdown
        .addOption("background", "Background")
        .addOption("blocking", "Blocking")
        .setValue(settings.memoryInterceptMode)
        .onChange(async (memoryInterceptMode) => this.host.updateSettings({ memoryInterceptMode: memoryInterceptMode as "background" | "blocking" })));
    textSetting(containerEl, "Memory model", "Lower-cost model used only for structured memory extraction.", settings.memoryModel, (memoryModel) => this.host.updateSettings({ memoryModel }));
    numberSetting(containerEl, "Memory confidence threshold", "Only writes model-extracted facts at or above this score.", settings.memoryThreshold, 0, 1, 0.01, (memoryThreshold) => this.host.updateSettings({ memoryThreshold }));
    numberSetting(containerEl, "Recent conversation buffer", "Number of previous conversations added to short-term context.", settings.conversationHistoryLimit, 0, 20, 1, (conversationHistoryLimit) => this.host.updateSettings({ conversationHistoryLimit }));

    const memoryManager = containerEl.createDiv({ cls: "vaultpilot-memory-manager" });
    memoryManager.createEl("p", { cls: "setting-item-description", text: "Memory entries include their source, confidence, and update date. You can remove individual entries here." });
    void this.renderMemoryManager(memoryManager);

    new Setting(containerEl).setName("Productivity bridge").setHeading();
    textSetting(containerEl, "Dashboard note", "Homepage integration refreshes this Markdown note. .obsidian is forbidden.", settings.dashboardPath, (dashboardPath) => this.host.updateSettings({ dashboardPath }));
    for (const status of this.host.getIntegrationStatuses()) {
      new Setting(containerEl)
        .setName(status.name)
        .setDesc(`${status.detail}${status.version ? ` Installed version ${status.version}.` : ""}${status.available ? "" : " Companion plugin is not currently available."}`)
        .addToggle((toggle) => toggle
          .setValue(settings.integrations[status.id])
          .setDisabled(!status.available)
          .onChange(async (enabled) => this.host.updateSettings({ integrations: { ...this.host.getSettings().integrations, [status.id]: enabled } })));
    }

    new Setting(containerEl).setName("Accessibility and mobile").setHeading();
    new Setting(containerEl).setName("Announce live activity").setDesc("Screen readers announce response, memory, and tool status changes.").addToggle((toggle) => toggle.setValue(settings.screenReaderAnnouncements).onChange(async (screenReaderAnnouncements) => this.host.updateSettings({ screenReaderAnnouncements })));
    new Setting(containerEl).setName("Voice dictation").setDesc("Shows a microphone when the device supports browser speech recognition. The operating system or browser may use an online speech service.").addToggle((toggle) => toggle.setValue(settings.voiceInputEnabled).onChange(async (voiceInputEnabled) => this.host.updateSettings({ voiceInputEnabled })));
    new Setting(containerEl).setName("Read responses aloud").setDesc("Shows a read-aloud response action using the device's speech synthesizer.").addToggle((toggle) => toggle.setValue(settings.readAloudEnabled).onChange(async (readAloudEnabled) => this.host.updateSettings({ readAloudEnabled })));
    new Setting(containerEl).setName("Reduce motion").setDesc("Disables smooth scrolling, blinking cursors, and spinning activity icons.").addToggle((toggle) => toggle.setValue(settings.reduceMotion).onChange(async (reduceMotion) => this.host.updateSettings({ reduceMotion })));
    new Setting(containerEl).setName("High contrast").setDesc("Strengthens borders and focus indicators inside VaultPilot.").addToggle((toggle) => toggle.setValue(settings.highContrast).onChange(async (highContrast) => this.host.updateSettings({ highContrast })));
    new Setting(containerEl).setName("Large touch targets").setDesc("Uses at least 44×44 pixel controls on desktop and mobile.").addToggle((toggle) => toggle.setValue(settings.largeTouchTargets).onChange(async (largeTouchTargets) => this.host.updateSettings({ largeTouchTargets })));
    numberSetting(containerEl, "Interface scale", "Scales VaultPilot chat text and controls without changing the rest of Obsidian.", settings.interfaceScale, 80, 160, 5, (interfaceScale) => this.host.updateSettings({ interfaceScale }));
    new Setting(containerEl).setName("Show source explanations").setDesc("Show semantic, keyword, and graph relevance details when sources are returned.").addToggle((toggle) => toggle.setValue(settings.showSourceDetails).onChange(async (showSourceDetails) => this.host.updateSettings({ showSourceDetails })));

    new Setting(containerEl).setName("Tool activity and undo").setHeading();
    const audit = containerEl.createDiv({ cls: "vaultpilot-audit-list" });
    this.renderAudit(audit);
    new Setting(containerEl)
      .addButton((button) => button.setButtonText("Undo last change").onClick(async () => {
        try { new Notice(`Undid: ${await this.host.undoLatestToolChange()}`); } catch (error) { new Notice(errorMessage(error), 8000); }
        this.display();
      }))
      .addButton((button) => button.setButtonText("Clear activity log").setWarning().onClick(() => {
        this.host.clearToolAudit();
        this.display();
      }));

    new Setting(containerEl).setName("Conversation archiving").setHeading();
    textSetting(containerEl, "Archive folder", "Archive files use Topic@YYYY-MM-DD_HH-mm.md exactly. .obsidian is forbidden.", settings.conversationsFolder, (conversationsFolder) => this.host.updateSettings({ conversationsFolder }));

    new Setting(containerEl).setName("Custom commands").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Commands are added to Obsidian's Command Palette. Use {{currentNote}}, {{currentNotePath}}, or {{selection}} placeholders. Newly added commands are available immediately; renamed commands refresh after a plugin reload."
    });
    this.renderCustomCommands(settings.customCommands);
    new Setting(containerEl).addButton((button) => button.setButtonText("Add custom command").setCta().onClick(async () => {
      const customCommands = [...this.host.getSettings().customCommands, {
        id: createId("command").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80),
        name: "New VaultPilot command",
        prompt: "Use the current note to help with this task:\n\n{{currentNote}}"
      }];
      await this.host.updateSettings({ customCommands });
      this.display();
    }));

    new Setting(containerEl).setName("Privacy-safe diagnostics").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "VaultPilot keeps up to 300 local operational events for troubleshooting. It records timing, status codes, retry counts, Gemini finish reasons, token counts, and tool-call counts—not prompts, note contents, response bodies, tool arguments, images, headers, or API keys. The hidden log remains inaccessible to AI tools."
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `Local log: ${this.host.getDiagnosticsPath()}`
    });
    const diagnostics = containerEl.createDiv({ cls: "vaultpilot-audit-list" });
    this.renderDiagnostics(diagnostics);
    new Setting(containerEl)
      .addButton((button) => button.setButtonText("Export diagnostic log").onClick(async () => {
        button.setDisabled(true).setButtonText("Exporting…");
        try {
          new Notice(`VaultPilot diagnostics exported to ${await this.host.exportDiagnostics()}`);
        } catch (error) {
          new Notice(errorMessage(error), 8000);
        } finally {
          button.setDisabled(false).setButtonText("Export diagnostic log");
        }
      }))
      .addButton((button) => button.setButtonText("Clear diagnostic log").setWarning().onClick(async () => {
        await this.host.clearDiagnostics();
        this.display();
      }));

    new Setting(containerEl).setName("Permanent security boundary").setHeading();
    const security = containerEl.createDiv({ cls: "vaultpilot-security-note" });
    security.createEl("strong", { text: ".obsidian is always forbidden to the AI." });
    security.createEl("p", {
      text: "All model-accessible file paths pass through a hard path guard. Prompts, automatic mode, custom commands, and model tool arguments cannot disable it. Normal plugin settings still use Obsidian's own local plugin-data mechanism."
    });
  }

  private renderCustomCommands(commands: CustomCommand[]): void {
    const { containerEl } = this;
    for (const command of commands) {
      const block = containerEl.createDiv({ cls: "vaultpilot-command-editor" });
      new Setting(block)
        .setName("Command name")
        .setDesc(`Command ID: ${command.id}`)
        .addText((text) => text.setValue(command.name).onChange(async (name) => this.updateCommand(command.id, { name })))
        .addButton((button) => button.setIcon("trash-2").setTooltip("Remove command").onClick(async () => {
          await this.host.updateSettings({ customCommands: this.host.getSettings().customCommands.filter((item) => item.id !== command.id) });
          this.display();
        }));
      new Setting(block)
        .setName("Prompt template")
        .addTextArea((area) => {
          area.inputEl.rows = 5;
          area.inputEl.addClass("vaultpilot-wide-textarea");
          area.setValue(command.prompt).onChange(async (prompt) => this.updateCommand(command.id, { prompt }));
        });
    }
  }

  private async renderMemoryManager(container: HTMLElement): Promise<void> {
    try {
      const entries = await this.host.getMemoryEntries();
      if (!container.isConnected) return;
      if (!entries.length) {
        container.createEl("p", { cls: "vaultpilot-empty-setting", text: "No structured memory entries yet." });
        return;
      }
      for (const entry of entries.slice(0, 100)) {
        const row = container.createDiv({ cls: "vaultpilot-memory-entry" });
        const body = row.createDiv();
        body.createDiv({ cls: "vaultpilot-memory-content", text: entry.content });
        body.createDiv({
          cls: "vaultpilot-memory-meta",
          text: `${entry.category} · ${entry.key} · confidence ${entry.confidence.toFixed(2)} · ${entry.updatedAt}`
        });
        const remove = row.createEl("button", { text: "Forget", attr: { "aria-label": `Forget memory: ${entry.content}` } });
        remove.addEventListener("click", () => void (async () => {
          remove.disabled = true;
          await this.host.forgetMemory(entry.category, entry.key);
          this.display();
        })());
      }
    } catch (error) {
      if (container.isConnected) container.createEl("p", { cls: "vaultpilot-empty-setting", text: `Memory manager unavailable: ${errorMessage(error)}` });
    }
  }

  private renderAudit(container: HTMLElement): void {
    const entries = this.host.getToolAuditEntries();
    if (!entries.length) {
      container.createEl("p", { cls: "vaultpilot-empty-setting", text: "No tool activity recorded yet." });
      return;
    }
    for (const entry of entries.slice(0, 20)) {
      const row = container.createDiv({ cls: `vaultpilot-audit-entry ${entry.ok ? "is-ok" : "is-error"}` });
      row.createDiv({ cls: "vaultpilot-audit-title", text: entry.description });
      row.createDiv({
        cls: "vaultpilot-audit-meta",
        text: `${entry.source} · ${entry.risk} · ${entry.ok ? "completed" : "blocked/failed"} · ${new Date(entry.createdAt).toLocaleString()}`
      });
      row.createDiv({ cls: "vaultpilot-audit-summary", text: entry.summary });
    }
  }

  private renderDiagnostics(container: HTMLElement): void {
    const entries = this.host.getDiagnosticEntries();
    if (!entries.length) {
      container.createEl("p", { cls: "vaultpilot-empty-setting", text: "No diagnostic events recorded yet." });
      return;
    }
    for (const entry of entries.slice(0, 20)) {
      const row = container.createDiv({ cls: `vaultpilot-audit-entry ${entry.level === "error" ? "is-error" : "is-ok"}` });
      row.createDiv({ cls: "vaultpilot-audit-title", text: `${entry.area}: ${entry.event}` });
      row.createDiv({
        cls: "vaultpilot-audit-meta",
        text: `${entry.level} · ${entry.platform} · ${new Date(entry.timestamp).toLocaleString()}`
      });
      if (entry.details && Object.keys(entry.details).length) {
        row.createDiv({ cls: "vaultpilot-audit-summary", text: JSON.stringify(entry.details) });
      }
    }
  }

  private async updateCommand(id: string, patch: Partial<CustomCommand>): Promise<void> {
    const customCommands = this.host.getSettings().customCommands.map((command) => command.id === id ? { ...command, ...patch } : command);
    await this.host.updateSettings({ customCommands });
  }
}

function policySetting(
  container: HTMLElement,
  name: string,
  description: string,
  value: ToolPolicy,
  onChange: (value: ToolPolicy) => Promise<void>,
  allowAutomatic = true
): void {
  new Setting(container).setName(name).setDesc(description).addDropdown((dropdown) => {
    if (allowAutomatic) dropdown.addOption("automatic", "Run automatically");
    dropdown
      .addOption("manual", "Always ask")
      .addOption("disabled", "Disabled")
      .setValue(allowAutomatic ? value : value === "automatic" ? "manual" : value)
      .onChange(async (next) => onChange(next as ToolPolicy));
  });
}

function textSetting(
  container: HTMLElement,
  name: string,
  description: string,
  value: string,
  onChange: (value: string) => Promise<void>
): void {
  new Setting(container).setName(name).setDesc(description).addText((text) => text.setValue(value).onChange(onChange));
}

function numberSetting(
  container: HTMLElement,
  name: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  step: number,
  onChange: (value: number) => Promise<void>
): void {
  new Setting(container).setName(name).setDesc(description).addText((text) => {
    text.inputEl.type = "number";
    text.inputEl.min = String(minimum);
    text.inputEl.max = String(maximum);
    text.inputEl.step = String(step);
    text.setValue(String(value)).onChange(async (raw) => {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) await onChange(Math.max(minimum, Math.min(maximum, parsed)));
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
