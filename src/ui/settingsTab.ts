import { Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { CustomCommand, VaultPilotSettings } from "../types";
import { createId } from "../utils/id";

export interface SettingsHost {
  getSettings(): VaultPilotSettings;
  updateSettings(patch: Partial<VaultPilotSettings>): Promise<void>;
  testGeminiConnection(): Promise<string>;
  rebuildSearchIndex(): Promise<void>;
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
      .setDesc("Automatic runs tools immediately. Manual shows an inline Allow/Deny card before every tool call.")
      .addDropdown((dropdown) => dropdown
        .addOption("automatic", "Automatic execution")
        .addOption("manual", "Manual approval")
        .setValue(settings.executionMode)
        .onChange(async (value) => this.host.updateSettings({ executionMode: value as "automatic" | "manual" })));
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
    textSetting(containerEl, "Memory model", "Lower-cost model used only for structured memory extraction.", settings.memoryModel, (memoryModel) => this.host.updateSettings({ memoryModel }));
    numberSetting(containerEl, "Memory confidence threshold", "Only writes model-extracted facts at or above this score.", settings.memoryThreshold, 0, 1, 0.01, (memoryThreshold) => this.host.updateSettings({ memoryThreshold }));
    numberSetting(containerEl, "Recent conversation buffer", "Number of previous conversations added to short-term context.", settings.conversationHistoryLimit, 0, 20, 1, (conversationHistoryLimit) => this.host.updateSettings({ conversationHistoryLimit }));

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

  private async updateCommand(id: string, patch: Partial<CustomCommand>): Promise<void> {
    const customCommands = this.host.getSettings().customCommands.map((command) => command.id === id ? { ...command, ...patch } : command);
    await this.host.updateSettings({ customCommands });
  }
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
