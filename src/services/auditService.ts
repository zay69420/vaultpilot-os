import { App, TFile } from "obsidian";
import { assertSafeVaultPath } from "../security/pathGuard";
import type { ToolAuditEntry, ToolRisk, ToolUndoRecord } from "../types";
import { createId } from "../utils/id";

const MAX_AUDIT_ENTRIES = 300;
const MAX_UNDO_ENTRIES = 20;
const MAX_UNDO_CHARACTERS = 5_000_000;

export class AuditService {
  private readonly items: ToolAuditEntry[];

  constructor(
    private readonly app: App,
    initial: ToolAuditEntry[] | undefined,
    private readonly onChange: () => void
  ) {
    this.items = Array.isArray(initial)
      ? initial.filter(isValidEntry).slice(-MAX_AUDIT_ENTRIES)
      : [];
    this.pruneUndoHistory();
  }

  entries(limit = 50): ToolAuditEntry[] {
    return this.items.slice(-Math.max(1, limit)).reverse().map((entry) => ({ ...entry, undo: entry.undo ? { ...entry.undo } : undefined }));
  }

  record(value: {
    tool: string;
    description: string;
    risk: ToolRisk;
    source?: string;
    ok: boolean;
    summary: string;
    undo?: ToolUndoRecord;
  }): ToolAuditEntry {
    const entry: ToolAuditEntry = {
      id: createId("audit"),
      createdAt: Date.now(),
      tool: value.tool.slice(0, 100),
      description: value.description.slice(0, 500),
      risk: value.risk,
      source: (value.source || "VaultPilot").slice(0, 100),
      ok: value.ok,
      summary: value.summary.slice(0, 1000),
      undo: value.undo
    };
    this.items.push(entry);
    if (this.items.length > MAX_AUDIT_ENTRIES) this.items.splice(0, this.items.length - MAX_AUDIT_ENTRIES);
    this.pruneUndoHistory();
    this.onChange();
    return entry;
  }

  async undoLatest(): Promise<ToolAuditEntry> {
    const entry = [...this.items].reverse().find((candidate) => candidate.ok && candidate.undo);
    if (!entry?.undo) throw new Error("There is no VaultPilot file change available to undo.");
    const undo = entry.undo;
    const path = assertSafeVaultPath(undo.path, { markdownOnly: undo.path.toLocaleLowerCase().endsWith(".md") });
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`The file needed for undo no longer exists: ${path}`);
    const current = await this.app.vault.read(file);
    if (undo.expectedContent !== undefined && current !== undo.expectedContent) {
      throw new Error(`Undo stopped because ${path} changed after VaultPilot's edit.`);
    }
    if (undo.kind === "delete-created") {
      await this.app.vault.delete(file);
    } else {
      await this.app.vault.modify(file, undo.content ?? "");
    }
    entry.undo = undefined;
    this.record({
      tool: "undo",
      description: `Undo ${entry.description}`,
      risk: "write",
      source: "VaultPilot",
      ok: true,
      summary: undo.kind === "delete-created" ? `Removed newly created ${path}` : `Restored ${path}`
    });
    this.onChange();
    return entry;
  }

  clear(): void {
    this.items.length = 0;
    this.onChange();
  }

  private pruneUndoHistory(): void {
    let retained = 0;
    let characters = 0;
    for (const entry of [...this.items].reverse()) {
      if (!entry.undo) continue;
      const size = (entry.undo.content?.length ?? 0) + (entry.undo.expectedContent?.length ?? 0);
      if (retained >= MAX_UNDO_ENTRIES || characters + size > MAX_UNDO_CHARACTERS) {
        entry.undo = undefined;
        continue;
      }
      retained += 1;
      characters += size;
    }
  }
}

function isValidEntry(value: unknown): value is ToolAuditEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ToolAuditEntry>;
  return typeof entry.id === "string"
    && typeof entry.createdAt === "number"
    && typeof entry.tool === "string"
    && typeof entry.description === "string"
    && typeof entry.ok === "boolean";
}
