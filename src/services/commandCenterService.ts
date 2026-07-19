import type { App, CachedMetadata, TFile } from "obsidian";
import type { CommandCenterProject, CommandCenterSnapshot, CommandCenterTask, VaultPilotSettings } from "../types";
import { isForbiddenVaultPath } from "../security/pathGuard";

const CACHE_MS = 30_000;
const MAX_TASK_FILES = 120;

export class CommandCenterService {
  private cached: { expiresAt: number; value: CommandCenterSnapshot } | null = null;

  constructor(private readonly app: App, private readonly getSettings: () => VaultPilotSettings) {}

  invalidate(): void {
    this.cached = null;
  }

  async snapshot(): Promise<CommandCenterSnapshot> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;

    const settings = this.getSettings();
    const excludedFolders = [settings.memoryFolder, settings.conversationsFolder]
      .map((folder) => folder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").toLocaleLowerCase())
      .filter(Boolean);
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => !isForbiddenVaultPath(file.path))
      .filter((file) => !excludedFolders.some((folder) => {
        const path = file.path.toLocaleLowerCase();
        return path === folder || path.startsWith(`${folder}/`);
      }))
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
    const taskFiles = files
      .filter((file) => hasTasks(this.app.metadataCache.getFileCache(file)))
      .slice(0, MAX_TASK_FILES);
    const taskGroups = await Promise.all(taskFiles.map(async (file) => {
      const content = await this.app.vault.cachedRead(file);
      return extractOpenTasks(file.path, content, new Date());
    }));
    const tasks = taskGroups.flat().sort(compareTasks).slice(0, 8);
    const projects = files
      .filter((file) => isProjectFile(file, this.app.metadataCache.getFileCache(file)))
      .slice(0, 8)
      .map((file) => projectFromFile(file, this.app.metadataCache.getFileCache(file)))
      .slice(0, 4);
    const recentNotes = files.slice(0, 5).map((file) => ({
      name: file.basename,
      path: file.path,
      updatedAt: file.stat.mtime
    }));
    const value: CommandCenterSnapshot = {
      dateLabel: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date()),
      tasks,
      projects,
      recentNotes,
      briefing: buildBriefing(tasks, projects, recentNotes[0]?.name)
    };
    this.cached = { expiresAt: Date.now() + CACHE_MS, value };
    return value;
  }
}

export function extractOpenTasks(path: string, content: string, today: Date): CommandCenterTask[] {
  const todayKey = localDateKey(today);
  const output: CommandCenterTask[] = [];
  const lines = content.split(/\r?\n/);
  let inCodeFence = false;
  for (let line = 0; line < lines.length; line += 1) {
    const sourceLine = lines[line] ?? "";
    if (/^\s*```/.test(sourceLine)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const match = sourceLine.match(/^\s*[-*+]\s+\[([^\]])\]\s+(.+?)\s*$/);
    const marker = match?.[1];
    const taskText = match?.[2];
    if (!marker || !taskText || marker.trim().toLocaleLowerCase() === "x") continue;
    const text = taskText.trim();
    const due = extractDueDate(text);
    output.push({ text, path, line, due, overdue: Boolean(due && due < todayKey) });
  }
  return output;
}

function hasTasks(cache: CachedMetadata | null): boolean {
  return Boolean(cache?.listItems?.some((item) => item.task !== undefined));
}

function isProjectFile(file: TFile, cache: CachedMetadata | null): boolean {
  const frontmatter = cache?.frontmatter;
  const type = String(frontmatter?.type ?? frontmatter?.kind ?? "").toLocaleLowerCase();
  const status = String(frontmatter?.status ?? "").toLocaleLowerCase();
  return type === "project"
    || ["active", "in progress", "in-progress"].includes(status)
    || /(^|\/)projects?\//i.test(file.path);
}

function projectFromFile(file: TFile, cache: CachedMetadata | null): CommandCenterProject {
  const taskItems = cache?.listItems?.filter((item) => item.task !== undefined) ?? [];
  const completed = taskItems.filter((item) => String(item.task).toLocaleLowerCase() === "x").length;
  return {
    name: file.basename,
    path: file.path,
    ...(taskItems.length ? { progress: Math.round((completed / taskItems.length) * 100) } : {}),
    updatedAt: file.stat.mtime
  };
}

function compareTasks(left: CommandCenterTask, right: CommandCenterTask): number {
  if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
  if (left.due && right.due) return left.due.localeCompare(right.due);
  if (left.due !== right.due) return left.due ? -1 : 1;
  return left.path.localeCompare(right.path);
}

function extractDueDate(value: string): string | undefined {
  return value.match(/(?:📅\s*|due::\s*)(\d{4}-\d{2}-\d{2})/i)?.[1];
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildBriefing(tasks: CommandCenterTask[], projects: CommandCenterProject[], recentName: string | undefined): string[] {
  const today = localDateKey(new Date());
  const overdue = tasks.filter((task) => task.overdue).length;
  const dueToday = tasks.filter((task) => task.due === today).length;
  const output = [tasks.length ? `${tasks.length} priority task${tasks.length === 1 ? " is" : "s are"} ready for review.` : "No open tasks were found in recently active notes."];
  if (overdue) output.push(`${overdue} overdue task${overdue === 1 ? " needs" : "s need"} attention.`);
  else if (dueToday) output.push(`${dueToday} task${dueToday === 1 ? " is" : "s are"} due today.`);
  const primaryProject = projects[0];
  if (primaryProject) output.push(`${primaryProject.name} is your most recently active project.`);
  else if (recentName) output.push(`${recentName} is your most recently updated note.`);
  return output.slice(0, 3);
}
