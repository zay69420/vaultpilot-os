import { App, TFile, normalizePath, requestUrl } from "obsidian";
import { assertSafeVaultPath, isForbiddenVaultPath } from "../security/pathGuard";
import type {
  FunctionDeclaration,
  ToolDefinition,
  ToolRisk,
  ToolUndoRecord,
  VaultPilotSettings
} from "../types";
import { ensureFolder } from "../utils/vault";
import { AuditService } from "./auditService";
import { IntegrationService } from "./integrationService";
import { SearchService } from "./searchService";

interface InternalToolResult extends Record<string, unknown> {
  __undo?: ToolUndoRecord;
}

interface ParsedTask {
  path: string;
  line: number;
  text: string;
  completed: boolean;
  due?: string;
  priority?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly app: App,
    private readonly search: SearchService,
    private readonly integrations: IntegrationService,
    private readonly audit: AuditService,
    private readonly getSettings: () => VaultPilotSettings
  ) {
    for (const tool of this.createTools()) this.tools.set(tool.declaration.name, tool);
  }

  declarations(): FunctionDeclaration[] {
    return [...this.tools.values()]
      .filter((tool) => tool.isAvailable?.() !== false)
      .map((tool) => tool.declaration);
  }

  get(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    return tool?.isAvailable?.() === false ? undefined : tool;
  }

  async execute(name: string, args: Record<string, unknown>, description: string): Promise<Record<string, unknown>> {
    const definition = this.get(name);
    if (!definition) throw new Error(`Unknown or unavailable tool: ${name}`);
    try {
      const result = await definition.execute(args) as InternalToolResult;
      const { __undo, ...publicResult } = result;
      this.audit.record({
        tool: name,
        description,
        risk: definition.risk,
        source: definition.source,
        ok: true,
        summary: summarizeResult(publicResult),
        undo: __undo
      });
      return publicResult;
    } catch (error) {
      this.audit.record({
        tool: name,
        description,
        risk: definition.risk,
        source: definition.source,
        ok: false,
        summary: errorMessage(error)
      });
      throw error;
    }
  }

  recordDenied(name: string, description: string): void {
    const definition = this.get(name);
    if (!definition) return;
    this.audit.record({
      tool: name,
      description,
      risk: definition.risk,
      source: definition.source,
      ok: false,
      summary: "User denied the action."
    });
  }

  private createTools(): ToolDefinition[] {
    return [
      this.vaultSearchTool(),
      this.readNoteTool(),
      this.webSearchTool(),
      this.writeNoteTool(),
      this.editNoteTool(),
      this.listTasksTool(),
      this.createTaskTool(),
      this.updateTaskTool(),
      this.toggleTaskTool(),
      this.refreshDashboardTool(),
      this.openHomepageTool(),
      this.openDailyNoteTool(),
      this.dailyBriefingTool(),
      this.adaptivePracticeTool(),
      this.remotelySaveTool(),
      this.canvasTool(),
      this.smartLookupTool()
    ];
  }

  private vaultSearchTool(): ToolDefinition {
    return {
      declaration: {
        name: "vault_search",
        description: "Search the Obsidian vault using semantic, lexical, and graph relevance. Results include clickable note paths, excerpts, score components, and ranking reasons.",
        parameters: objectSchema({ query: { type: "string" }, limit: { type: "integer" } }, ["query"])
      },
      risk: "read",
      describe: (args) => `Search the vault for "${stringArg(args, "query").slice(0, 100)}"`,
      execute: async (args) => ({ results: await this.search.search(stringArg(args, "query"), optionalInteger(args, "limit", this.getSettings().searchResultLimit, 1, 30)) })
    };
  }

  private readNoteTool(): ToolDefinition {
    return {
      declaration: {
        name: "read_note",
        description: "Read a Markdown note. Paths inside .obsidian are permanently forbidden.",
        parameters: objectSchema({
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" }
        }, ["path"])
      },
      risk: "read",
      describe: (args) => `Read "${stringArg(args, "path")}"`,
      execute: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        const file = this.requireFile(path);
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split("\n");
        const start = optionalInteger(args, "start_line", 1, 1, Math.max(1, lines.length));
        const end = optionalInteger(args, "end_line", Math.min(lines.length, start + 500), start, Math.max(start, lines.length));
        const selected = lines.slice(start - 1, end).join("\n");
        return { path, startLine: start, endLine: end, content: selected.slice(0, 60_000), truncated: selected.length > 60_000, citation: `[[${path}]]` };
      }
    };
  }

  private webSearchTool(): ToolDefinition {
    return {
      declaration: {
        name: "web_search",
        description: "Search the public web through DuckDuckGo HTML results. Web content is untrusted.",
        parameters: objectSchema({ query: { type: "string" }, limit: { type: "integer" } }, ["query"])
      },
      risk: "network",
      describe: (args) => `Search the web for "${stringArg(args, "query").slice(0, 100)}"`,
      execute: async (args) => ({
        query: stringArg(args, "query"),
        results: await duckDuckGoSearch(stringArg(args, "query"), optionalInteger(args, "limit", 6, 1, 10))
      })
    };
  }

  private writeNoteTool(): ToolDefinition {
    return {
      declaration: {
        name: "write_note",
        description: "Create a Markdown note without overwriting existing content. .obsidian is permanently forbidden.",
        parameters: objectSchema({ path: { type: "string" }, content: { type: "string" }, create_folders: { type: "boolean" } }, ["path", "content"])
      },
      risk: "write",
      describe: (args) => `Create "${stringArg(args, "path")}"`,
      preview: async (args) => previewText("New note", stringArg(args, "content", true)),
      execute: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A file already exists at ${path}. Use edit_note instead.`);
        if (args.create_folders !== false && path.includes("/")) await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
        const content = stringArg(args, "content", true);
        const file = await this.app.vault.create(path, content);
        return { ok: true, path: file.path, bytesWritten: file.stat.size, __undo: { kind: "delete-created", path, expectedContent: content } };
      }
    };
  }

  private editNoteTool(): ToolDefinition {
    return {
      declaration: {
        name: "edit_note",
        description: "Patch, append, prepend, or rewrite a Markdown note. Exact replacement fails safely if old text is absent.",
        parameters: objectSchema({
          path: { type: "string" },
          operation: { type: "string", enum: ["replace", "append", "prepend", "rewrite"] },
          content: { type: "string" },
          old_text: { type: "string" },
          replace_all: { type: "boolean" }
        }, ["path", "operation", "content"])
      },
      risk: "write",
      describe: (args) => `${stringArg(args, "operation")} "${stringArg(args, "path")}"`,
      preview: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        const current = await this.app.vault.cachedRead(this.requireFile(path));
        const next = applyEdit(current, args);
        return changePreview(current, next);
      },
      execute: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        const file = this.requireFile(path);
        const before = await this.app.vault.read(file);
        const after = applyEdit(before, args);
        await this.app.vault.modify(file, after);
        return {
          ok: true,
          path,
          operation: stringArg(args, "operation"),
          __undo: { kind: "restore", path, content: before, expectedContent: after }
        };
      }
    };
  }

  private listTasksTool(): ToolDefinition {
    return {
      declaration: {
        name: "tasks_list",
        description: "List and search Tasks-compatible Markdown tasks across the vault. Supports open, completed, overdue, and all filters.",
        parameters: objectSchema({ query: { type: "string" }, status: { type: "string", enum: ["open", "completed", "overdue", "all"] }, limit: { type: "integer" } }, []),
      },
      risk: "read",
      source: "Tasks",
      isAvailable: () => this.integrations.enabled("tasks"),
      describe: (args) => `List ${typeof args.status === "string" ? args.status : "open"} tasks`,
      execute: async (args) => ({ tasks: await this.listTasks(optionalString(args, "query"), optionalString(args, "status") || "open", optionalInteger(args, "limit", 50, 1, 200)) })
    };
  }

  private createTaskTool(): ToolDefinition {
    return {
      declaration: {
        name: "tasks_create",
        description: "Append a Tasks-compatible task to a Markdown note.",
        parameters: objectSchema({ path: { type: "string" }, task: { type: "string" }, due: { type: "string" }, priority: { type: "string", enum: ["highest", "high", "normal", "low", "lowest"] } }, ["path", "task"])
      },
      risk: "write",
      source: "Tasks",
      isAvailable: () => this.integrations.enabled("tasks"),
      describe: (args) => `Add a task to "${stringArg(args, "path")}"`,
      preview: async (args) => `Append:\n${buildTaskLine(args)}`,
      execute: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        let file = this.app.vault.getAbstractFileByPath(path);
        const created = !file;
        if (!file) {
          if (path.includes("/")) await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
          file = await this.app.vault.create(path, "");
        }
        if (!(file instanceof TFile)) throw new Error(`Task destination is not a note: ${path}`);
        const before = await this.app.vault.read(file);
        const line = buildTaskLine(args);
        const after = `${before}${before && !before.endsWith("\n") ? "\n" : ""}${line}\n`;
        await this.app.vault.modify(file, after);
        return {
          ok: true,
          path,
          task: line,
          __undo: created ? { kind: "delete-created", path, expectedContent: after } : { kind: "restore", path, content: before, expectedContent: after }
        };
      }
    };
  }

  private updateTaskTool(): ToolDefinition {
    return {
      declaration: {
        name: "tasks_update",
        description: "Replace one task line while preserving Tasks syntax.",
        parameters: objectSchema({ path: { type: "string" }, line: { type: "integer" }, task: { type: "string" } }, ["path", "line", "task"])
      },
      risk: "write",
      source: "Tasks",
      isAvailable: () => this.integrations.enabled("tasks"),
      describe: (args) => `Update task on line ${optionalInteger(args, "line", 1, 1, 1_000_000)} of "${stringArg(args, "path")}"`,
      preview: async (args) => {
        const { current, next } = await this.taskLineChange(args);
        return `- ${current}\n+ ${next}`;
      },
      execute: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        const file = this.requireFile(path);
        const before = await this.app.vault.read(file);
        const lineNumber = optionalInteger(args, "line", 1, 1, 1_000_000);
        const lines = before.split("\n");
        const current = lines[lineNumber - 1] ?? "";
        if (!isTaskLine(current)) throw new Error(`Line ${lineNumber} is not a Markdown task.`);
        const next = normalizeTaskReplacement(stringArg(args, "task"), current);
        lines[lineNumber - 1] = next;
        const after = lines.join("\n");
        await this.app.vault.modify(file, after);
        return { ok: true, path, line: lineNumber, task: next, __undo: { kind: "restore", path, content: before, expectedContent: after } };
      }
    };
  }

  private toggleTaskTool(): ToolDefinition {
    return {
      declaration: {
        name: "tasks_toggle",
        description: "Toggle completion for a Markdown task, using Tasks apiV1 when available and a safe syntax fallback otherwise.",
        parameters: objectSchema({ path: { type: "string" }, line: { type: "integer" } }, ["path", "line"])
      },
      risk: "write",
      source: "Tasks",
      isAvailable: () => this.integrations.enabled("tasks"),
      describe: (args) => `Toggle task on line ${optionalInteger(args, "line", 1, 1, 1_000_000)} of "${stringArg(args, "path")}"`,
      preview: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        const content = await this.app.vault.cachedRead(this.requireFile(path));
        const current = content.split("\n")[optionalInteger(args, "line", 1, 1, 1_000_000) - 1] ?? "";
        if (!isTaskLine(current)) throw new Error("The selected line is not a task.");
        return `- ${current}\n+ ${fallbackToggleTask(current)}`;
      },
      execute: async (args) => {
        const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
        const file = this.requireFile(path);
        const before = await this.app.vault.read(file);
        const lineNumber = optionalInteger(args, "line", 1, 1, 1_000_000);
        const lines = before.split("\n");
        const current = lines[lineNumber - 1] ?? "";
        if (!isTaskLine(current)) throw new Error(`Line ${lineNumber} is not a Markdown task.`);
        let next: string | undefined;
        const tasksApi = this.integrations.tasksApi();
        if (tasksApi?.executeToggleTaskDoneCommand) {
          try {
            const candidate = await tasksApi.executeToggleTaskDoneCommand(current, path);
            if (typeof candidate === "string" && isTaskLine(candidate)) next = candidate;
          } catch (error) {
            console.warn("Tasks apiV1 toggle failed; using Markdown fallback", error);
          }
        }
        next ??= fallbackToggleTask(current);
        lines[lineNumber - 1] = next;
        const after = lines.join("\n");
        await this.app.vault.modify(file, after);
        return { ok: true, path, line: lineNumber, task: next, __undo: { kind: "restore", path, content: before, expectedContent: after } };
      }
    };
  }

  private refreshDashboardTool(): ToolDefinition {
    return {
      declaration: {
        name: "refresh_productivity_dashboard",
        description: "Create or refresh the configured VaultPilot dashboard with today's open tasks, active note, and quick actions.",
        parameters: objectSchema({ open_homepage: { type: "boolean" } }, []),
      },
      risk: "write",
      source: "Homepage",
      isAvailable: () => this.integrations.enabled("homepage"),
      describe: () => `Refresh "${this.getSettings().dashboardPath}"`,
      preview: async () => previewText("Generated dashboard", await this.buildDashboard()),
      execute: async (args) => {
        const path = assertSafeVaultPath(this.getSettings().dashboardPath, { markdownOnly: true });
        const content = await this.buildDashboard();
        const result = await this.writeOrReplace(path, content);
        if (args.open_homepage === true) this.integrations.runFirstCommand(["homepage:open-homepage", "homepage:open-homepage-command"]);
        return { ok: true, path, tasksShown: (content.match(/^- \[[ x]\]/gm) ?? []).length, ...result };
      }
    };
  }

  private openHomepageTool(): ToolDefinition {
    return {
      declaration: { name: "open_homepage", description: "Open the Homepage plugin's configured home view.", parameters: objectSchema({}, []) },
      risk: "read",
      source: "Homepage",
      isAvailable: () => this.integrations.enabled("homepage"),
      describe: () => "Open the Obsidian homepage",
      execute: async () => ({ ok: true, command: this.integrations.runFirstCommand(["homepage:open-homepage", "homepage:open-homepage-command"]) })
    };
  }

  private openDailyNoteTool(): ToolDefinition {
    return {
      declaration: { name: "open_daily_note", description: "Open today's note through the Daily Notes core command.", parameters: objectSchema({}, []) },
      risk: "read",
      source: "Daily Notes",
      isAvailable: () => this.integrations.enabled("dailyNotes"),
      describe: () => "Open today's daily note",
      execute: async () => ({ ok: true, command: this.integrations.runFirstCommand(["daily-notes", "daily-notes:goto-today"]) })
    };
  }

  private dailyBriefingTool(): ToolDefinition {
    return {
      declaration: {
        name: "write_daily_briefing",
        description: "Append a concise briefing to today's YYYY-MM-DD note, creating Daily Notes/YYYY-MM-DD.md if no matching note exists.",
        parameters: objectSchema({ briefing: { type: "string" } }, ["briefing"])
      },
      risk: "write",
      source: "Daily Notes",
      isAvailable: () => this.integrations.enabled("dailyNotes"),
      describe: () => "Write today's daily briefing",
      preview: async (args) => previewText("Daily briefing", stringArg(args, "briefing")),
      execute: async (args) => {
        const date = localDate();
        const existing = this.app.vault.getMarkdownFiles().find((file) => file.basename === date);
        const path = assertSafeVaultPath(existing?.path ?? `Daily Notes/${date}.md`, { markdownOnly: true });
        let file = existing;
        const created = !file;
        if (!file) {
          await ensureFolder(this.app, "Daily Notes");
          file = await this.app.vault.create(path, `# ${date}\n\n`);
        }
        const before = await this.app.vault.read(file);
        const section = `## VaultPilot briefing\n\n${stringArg(args, "briefing").trim()}\n`;
        const after = `${before}${before.endsWith("\n") ? "" : "\n"}\n${section}`;
        await this.app.vault.modify(file, after);
        return { ok: true, path, __undo: created ? { kind: "delete-created", path, expectedContent: after } : { kind: "restore", path, content: before, expectedContent: after } };
      }
    };
  }

  private adaptivePracticeTool(): ToolDefinition {
    const commands: Record<string, string[]> = {
      daily: ["adaptive-practice:start-daily-practice"],
      resume: ["adaptive-practice:resume-practice-session"],
      current_note: ["adaptive-practice:practice-current-note"],
      dashboard: ["adaptive-practice:open-dashboard"],
      scan_plan: ["adaptive-practice:scan-practice-plan"]
    };
    return {
      declaration: {
        name: "adaptive_practice",
        description: "Launch an allowlisted Adaptive Practice workflow. It never reads the plugin's private index.",
        parameters: objectSchema({ action: { type: "string", enum: Object.keys(commands) } }, ["action"])
      },
      risk: "write",
      source: "Adaptive Practice",
      isAvailable: () => this.integrations.enabled("adaptivePractice"),
      describe: (args) => `Start Adaptive Practice: ${stringArg(args, "action")}`,
      execute: async (args) => {
        const action = stringArg(args, "action");
        const candidates = commands[action];
        if (!candidates) throw new Error(`Unsupported Adaptive Practice action: ${action}`);
        return { ok: true, command: this.integrations.runFirstCommand(candidates) };
      }
    };
  }

  private remotelySaveTool(): ToolDefinition {
    return {
      declaration: {
        name: "remotely_save",
        description: "Run an explicitly confirmed Remotely Save dry run or sync. This never reads credentials or plugin configuration.",
        parameters: objectSchema({ action: { type: "string", enum: ["dry_run", "sync"] } }, ["action"])
      },
      risk: "sync",
      source: "Remotely Save",
      isAvailable: () => this.integrations.enabled("remotelySave"),
      describe: (args) => `${stringArg(args, "action") === "sync" ? "Synchronize" : "Dry-run sync"} with Remotely Save`,
      preview: async () => "This invokes Remotely Save. It can contact the configured cloud provider and may change synchronized files.",
      execute: async (args) => {
        const action = stringArg(args, "action");
        const candidates = action === "sync"
          ? ["remotely-save:start-sync"]
          : ["remotely-save:start-sync-dry-run", "remotely-save:start-sync-dry-run-with-no-save"];
        return { ok: true, command: this.integrations.runFirstCommand(candidates) };
      }
    };
  }

  private canvasTool(): ToolDefinition {
    return {
      declaration: {
        name: "create_canvas_map",
        description: "Create a new Obsidian Canvas project or study map. Existing canvases are never overwritten.",
        parameters: objectSchema({
          path: { type: "string" },
          nodes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, file: { type: "string" } } } },
          edges: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } } } }
        }, ["path", "nodes"])
      },
      risk: "write",
      source: "Canvas",
      isAvailable: () => this.integrations.enabled("canvas"),
      describe: (args) => `Create Canvas "${stringArg(args, "path")}"`,
      preview: async (args) => `${arrayArg(args, "nodes").length} nodes and ${arrayArg(args, "edges", true).length} edges`,
      execute: async (args) => {
        const path = assertSafeVaultPath(normalizeCanvasPath(stringArg(args, "path")));
        if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A file already exists at ${path}.`);
        const content = buildCanvas(args);
        if (path.includes("/")) await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
        await this.app.vault.create(path, content);
        return { ok: true, path, __undo: { kind: "delete-created", path, expectedContent: content } };
      }
    };
  }

  private smartLookupTool(): ToolDefinition {
    return {
      declaration: {
        name: "open_smart_semantic_view",
        description: "Open an installed Smart Lookup or Smart Connections view. VaultPilot does not read their private indexes.",
        parameters: objectSchema({ view: { type: "string", enum: ["lookup", "connections"] } }, ["view"])
      },
      risk: "read",
      source: "Smart Environment (experimental)",
      isAvailable: () => this.integrations.enabled("smartEnvironmentExperimental"),
      describe: (args) => `Open Smart ${stringArg(args, "view")}`,
      execute: async (args) => {
        const view = stringArg(args, "view");
        const candidates = view === "lookup"
          ? ["smart-lookup:lookup", "smart-lookup:smart-lookup", "smart-lookup:open-smart-lookup"]
          : ["smart-connections:smart-connections", "smart-connections:open-smart-connections"];
        return { ok: true, command: this.integrations.runFirstCommand(candidates), experimental: true };
      }
    };
  }

  private requireFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
    return file;
  }

  private async taskLineChange(args: Record<string, unknown>): Promise<{ current: string; next: string }> {
    const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
    const content = await this.app.vault.cachedRead(this.requireFile(path));
    const current = content.split("\n")[optionalInteger(args, "line", 1, 1, 1_000_000) - 1] ?? "";
    if (!isTaskLine(current)) throw new Error("The selected line is not a task.");
    return { current, next: normalizeTaskReplacement(stringArg(args, "task"), current) };
  }

  private async listTasks(query: string, status: string, limit: number): Promise<ParsedTask[]> {
    const tasks: ParsedTask[] = [];
    const today = localDate();
    const files = this.app.vault.getMarkdownFiles();
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      if (!file || isForbiddenVaultPath(file.path)) continue;
      const lines = (await this.app.vault.cachedRead(file)).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const match = line.match(/^\s*[-*]\s+\[([^\]])\]\s+(.+)$/);
        if (!match) continue;
        const completed = /[xX]/.test(match[1] ?? "");
        const text = match[2]?.trim() ?? "";
        const due = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1];
        const matchesStatus = status === "all"
          || (status === "completed" && completed)
          || (status === "open" && !completed)
          || (status === "overdue" && !completed && Boolean(due && due < today));
        if (!matchesStatus || (query && !`${file.path} ${text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue;
        tasks.push({ path: file.path, line: index + 1, text, completed, due, priority: taskPriority(text) });
      }
      if (fileIndex > 0 && fileIndex % 25 === 0) await yieldToUi();
    }
    return tasks.sort(compareTasks).slice(0, limit);
  }

  private async buildDashboard(): Promise<string> {
    const now = new Date();
    const tasks = this.integrations.enabled("tasks") ? await this.listTasks("", "open", 20) : [];
    const activePath = this.app.workspace.getActiveFile()?.path;
    const taskLines = tasks.length
      ? tasks.map((task) => `- [ ] ${task.text} — [[${task.path}]]`).join("\n")
      : "_No open tasks found, or Tasks integration is unavailable._";
    return `# VaultPilot Dashboard\n\n> Refreshed ${now.toLocaleString()}\n\n## Focus now\n\n${activePath ? `Continue [[${activePath}]] or ask VaultPilot to identify the next action.` : "Open a project note or ask VaultPilot to plan your day."}\n\n## Open tasks\n\n${taskLines}\n\n## Quick actions\n\n- Open VaultPilot and ask: **Plan my day**\n- Run **VaultPilot OS: Refresh productivity dashboard**\n- Run **VaultPilot OS: Create daily briefing**\n- Review relevant notes in the **VaultPilot Priority** Bases view\n\n## System\n\n- Search: hybrid semantic + lexical + graph relevance\n- Memory: ${this.getSettings().memoryEnabled ? "enabled" : "disabled"}\n- Tool changes: previewed, logged, and undoable\n`;
  }

  private async writeOrReplace(path: string, content: string): Promise<InternalToolResult> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) {
      if (path.includes("/")) await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
      await this.app.vault.create(path, content);
      return { __undo: { kind: "delete-created", path, expectedContent: content } };
    }
    if (!(existing instanceof TFile)) throw new Error(`Dashboard path is not a file: ${path}`);
    const before = await this.app.vault.read(existing);
    await this.app.vault.modify(existing, content);
    return { __undo: { kind: "restore", path, content: before, expectedContent: content } };
  }
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required };
}

function stringArg(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${key} must be a non-empty string.`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? String(args[key]).trim() : "";
}

function optionalInteger(args: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Math.round(Number(args[key] ?? fallback));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function arrayArg(args: Record<string, unknown>, key: string, optional = false): unknown[] {
  const value = args[key];
  if (optional && value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array.`);
  return value;
}

function applyEdit(current: string, args: Record<string, unknown>): string {
  const operation = stringArg(args, "operation") as "replace" | "append" | "prepend" | "rewrite";
  if (!["replace", "append", "prepend", "rewrite"].includes(operation)) throw new Error(`Unsupported edit operation: ${operation}`);
  const content = stringArg(args, "content", true);
  if (operation === "rewrite") return content;
  if (operation === "append") return `${current}${current.endsWith("\n") || !current ? "" : "\n"}${content}`;
  if (operation === "prepend") return `${content}${content.endsWith("\n") || !current ? "" : "\n"}${current}`;
  const oldText = stringArg(args, "old_text", true);
  if (!oldText) throw new Error("old_text is required for an exact replacement.");
  if (!current.includes(oldText)) throw new Error("The exact old_text was not found; no changes were made.");
  return args.replace_all === true ? current.split(oldText).join(content) : current.replace(oldText, content);
}

function previewText(label: string, value: string): string {
  const clean = value.slice(0, 3000);
  return `${label} (${value.length} characters):\n${clean}${value.length > clean.length ? "\n…preview truncated" : ""}`;
}

function changePreview(before: string, after: string): string {
  if (before === after) return "No textual change.";
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  const contextStart = Math.max(0, start - 200);
  return `Before:\n${before.slice(contextStart, start + 1200)}\n\nAfter:\n${after.slice(contextStart, start + 1200)}`;
}

function buildTaskLine(args: Record<string, unknown>): string {
  const text = stringArg(args, "task").replace(/^\s*[-*]\s+\[[^\]]\]\s+/, "").trim();
  const due = optionalString(args, "due");
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("due must use YYYY-MM-DD format.");
  const symbols: Record<string, string> = { highest: "⏫", high: "🔼", normal: "", low: "🔽", lowest: "⏬" };
  const priority = optionalString(args, "priority") || "normal";
  if (!(priority in symbols)) throw new Error(`Unsupported task priority: ${priority}`);
  return `- [ ] ${text}${symbols[priority] ? ` ${symbols[priority]}` : ""}${due ? ` 📅 ${due}` : ""}`;
}

function isTaskLine(value: string): boolean {
  return /^\s*[-*]\s+\[[^\]]\]\s+/.test(value);
}

function normalizeTaskReplacement(value: string, current: string): string {
  const replacement = value.trim();
  if (isTaskLine(replacement)) return replacement;
  const prefix = current.match(/^\s*[-*]\s+\[[^\]]\]\s+/)?.[0] ?? "- [ ] ";
  return `${prefix}${replacement}`;
}

function fallbackToggleTask(value: string): string {
  return value.replace(/^(\s*[-*]\s+\[)([^\]])(\])/, (_match, start: string, state: string, end: string) => `${start}${/[xX]/.test(state) ? " " : "x"}${end}`);
}

function taskPriority(text: string): string | undefined {
  if (text.includes("⏫")) return "highest";
  if (text.includes("🔼")) return "high";
  if (text.includes("🔽")) return "low";
  if (text.includes("⏬")) return "lowest";
  return undefined;
}

function compareTasks(left: ParsedTask, right: ParsedTask): number {
  const priority = (value?: string): number => ({ highest: 0, high: 1, low: 3, lowest: 4 }[value ?? ""] ?? 2);
  return priority(left.priority) - priority(right.priority)
    || (left.due ?? "9999-99-99").localeCompare(right.due ?? "9999-99-99")
    || left.path.localeCompare(right.path)
    || left.line - right.line;
}

function localDate(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeCanvasPath(value: string): string {
  const path = normalizePath(value.trim());
  return path.toLocaleLowerCase().endsWith(".canvas") ? path : `${path}.canvas`;
}

function buildCanvas(args: Record<string, unknown>): string {
  const rawNodes = arrayArg(args, "nodes");
  if (rawNodes.length === 0 || rawNodes.length > 100) throw new Error("Canvas nodes must contain between 1 and 100 items.");
  const ids = new Set<string>();
  const nodes = rawNodes.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error("Each Canvas node must be an object.");
    const item = value as Record<string, unknown>;
    const id = (typeof item.id === "string" ? item.id : `node-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    if (!id || ids.has(id)) throw new Error(`Canvas node ID is missing or duplicated: ${id}`);
    ids.add(id);
    const x = (index % 3) * 360;
    const y = Math.floor(index / 3) * 240;
    if (typeof item.file === "string" && item.file.trim()) {
      const file = assertSafeVaultPath(item.file, { markdownOnly: true });
      return { id, type: "file", file, x, y, width: 300, height: 180 };
    }
    return { id, type: "text", text: String(item.text ?? "Untitled"), x, y, width: 300, height: 180 };
  });
  const edges = arrayArg(args, "edges", true).slice(0, 200).map((value, index) => {
    if (!value || typeof value !== "object") throw new Error("Each Canvas edge must be an object.");
    const item = value as Record<string, unknown>;
    const fromNode = String(item.from ?? "");
    const toNode = String(item.to ?? "");
    if (!ids.has(fromNode) || !ids.has(toNode)) throw new Error("Canvas edges must reference existing node IDs.");
    return { id: `edge-${index + 1}`, fromNode, toNode, ...(typeof item.label === "string" && item.label ? { label: item.label.slice(0, 200) } : {}) };
  });
  return JSON.stringify({ nodes, edges }, null, 2);
}

function summarizeResult(result: Record<string, unknown>): string {
  if (typeof result.path === "string") return `${result.ok === false ? "Failed" : "Completed"}: ${result.path}`;
  if (Array.isArray(result.results)) return `Returned ${result.results.length} results.`;
  if (Array.isArray(result.tasks)) return `Returned ${result.tasks.length} tasks.`;
  if (typeof result.command === "string") return `Ran ${result.command}.`;
  return result.ok === false ? "The tool reported a failure." : "The tool completed.";
}

async function duckDuckGoSearch(query: string, limit: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const response = await requestUrl({
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    method: "GET",
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; VaultPilotOS/1.3; Obsidian)" },
    throw: false
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`DuckDuckGo returned HTTP ${response.status}.`);
  const document = new DOMParser().parseFromString(response.text, "text/html");
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const element of Array.from(document.querySelectorAll(".result"))) {
    const link = element.querySelector<HTMLAnchorElement>(".result__a");
    if (!link) continue;
    const url = unwrapDuckDuckGoUrl(link.getAttribute("href") || link.href || "");
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title: link.textContent?.trim() ?? url, url, snippet: element.querySelector<HTMLElement>(".result__snippet")?.textContent?.trim() ?? "" });
    if (results.length >= limit) break;
  }
  if (!results.length) throw new Error("DuckDuckGo returned no parseable results. It may be temporarily rate-limiting scraped searches.");
  return results;
}

function unwrapDuckDuckGoUrl(value: string): string {
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") ?? parsed.href;
  } catch {
    return value;
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
