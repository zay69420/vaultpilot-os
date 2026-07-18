import type { App } from "obsidian";
import type { IntegrationSettings, IntegrationStatus, VaultPilotSettings } from "../types";

interface RuntimePlugin {
  manifest?: { version?: string };
  apiV1?: {
    createTaskLineModal?(): Promise<string | undefined> | string | undefined;
    editTaskLineModal?(line: string): Promise<string | undefined> | string | undefined;
    executeToggleTaskDoneCommand?(line: string, path: string): Promise<string | undefined> | string | undefined;
  };
}

interface RuntimeApp extends App {
  plugins?: { getPlugin(id: string): RuntimePlugin | null | undefined };
  commands?: { executeCommandById(id: string): boolean };
  internalPlugins?: { getPluginById(id: string): { enabled?: boolean } | null | undefined };
}

const DEFINITIONS: Array<{
  id: keyof IntegrationSettings;
  name: string;
  pluginId?: string;
  detail: string;
}> = [
  { id: "tasks", name: "Tasks", pluginId: "obsidian-tasks-plugin", detail: "Task search, planning, creation, editing, and completion." },
  { id: "homepage", name: "Homepage", pluginId: "homepage", detail: "Daily command center and homepage navigation." },
  { id: "bases", name: "Bases", detail: "VaultPilot Priority custom Bases view." },
  { id: "dailyNotes", name: "Daily Notes", detail: "Daily briefing and today's-note navigation." },
  { id: "adaptivePractice", name: "Adaptive Practice", pluginId: "adaptive-practice", detail: "Launch supported practice workflows." },
  { id: "remotelySave", name: "Remotely Save", pluginId: "remotely-save", detail: "Explicitly confirmed dry-run or sync commands only." },
  { id: "smartEnvironmentExperimental", name: "Smart Connections / Lookup", pluginId: "smart-connections", detail: "Experimental detection and navigation; no private index access." },
  { id: "canvas", name: "Canvas", detail: "Generate accessible project and study maps." }
];

export class IntegrationService {
  constructor(private readonly app: App, private readonly getSettings: () => VaultPilotSettings) {}

  statuses(): IntegrationStatus[] {
    const settings = this.getSettings();
    return DEFINITIONS.map((definition) => {
      const plugin = definition.pluginId ? this.plugin(definition.pluginId) : undefined;
      let available = definition.pluginId ? Boolean(plugin) : this.coreAvailable(definition.id);
      if (definition.id === "smartEnvironmentExperimental") {
        available = Boolean(this.plugin("smart-connections") || this.plugin("smart-lookup"));
      }
      return {
        id: definition.id,
        name: definition.name,
        enabled: settings.integrations[definition.id],
        available,
        version: plugin?.manifest?.version,
        detail: definition.id === "remotelySave" && this.corePluginEnabled("sync")
          ? `${definition.detail} Obsidian Sync is also enabled; using two sync engines on the same files can increase conflict risk.`
          : definition.detail
      };
    });
  }

  enabled(id: keyof IntegrationSettings): boolean {
    const status = this.statuses().find((candidate) => candidate.id === id);
    return Boolean(status?.enabled && status.available);
  }

  tasksApi(): RuntimePlugin["apiV1"] | undefined {
    if (!this.enabled("tasks")) return undefined;
    return this.plugin("obsidian-tasks-plugin")?.apiV1;
  }

  runCommand(commandId: string): boolean {
    return Boolean((this.app as RuntimeApp).commands?.executeCommandById(commandId));
  }

  runFirstCommand(commandIds: string[]): string {
    for (const id of commandIds) {
      if (this.runCommand(id)) return id;
    }
    throw new Error("The companion plugin is installed, but this version does not expose the expected command.");
  }

  private plugin(id: string): RuntimePlugin | undefined {
    return (this.app as RuntimeApp).plugins?.getPlugin(id) ?? undefined;
  }

  private coreAvailable(id: keyof IntegrationSettings): boolean {
    const coreId = id === "bases" ? "bases" : id === "dailyNotes" ? "daily-notes" : id === "canvas" ? "canvas" : null;
    if (coreId) return Boolean((this.app as RuntimeApp).internalPlugins?.getPluginById(coreId)?.enabled);
    return true;
  }

  private corePluginEnabled(id: string): boolean {
    return Boolean((this.app as RuntimeApp).internalPlugins?.getPluginById(id)?.enabled);
  }
}
