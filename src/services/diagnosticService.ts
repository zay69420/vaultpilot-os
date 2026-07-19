import { App, Platform, normalizePath } from "obsidian";
import type { DiagnosticEntry, DiagnosticEvent, DiagnosticValue } from "../types";
import { ensureFolder } from "../utils/vault";

const MAX_ENTRIES = 300;
const FLUSH_DELAY_MS = 750;
const EXPORT_FOLDER = "VaultPilot Diagnostics";
const UNSAFE_DETAIL_KEY = /^(?:api.?key|authorization|headers?|request.?body|prompt|contents?|args|function.?response|image.?data)$/i;

/**
 * Writes a bounded, metadata-only JSONL log beside the plugin. The agent tools
 * cannot access this path because the permanent .obsidian guard still applies.
 */
export class DiagnosticService {
  private readonly path: string;
  private entries: DiagnosticEntry[] = [];
  private flushHandle: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly app: App, pluginId: string) {
    this.path = normalizePath(`${app.vault.configDir}/plugins/${pluginId}/diagnostics.jsonl`);
  }

  async initialize(): Promise<void> {
    try {
      if (!await this.app.vault.adapter.exists(this.path)) return;
      const raw = await this.app.vault.adapter.read(this.path);
      const parsed: DiagnosticEntry[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = normalizeStoredEntry(JSON.parse(line) as Partial<DiagnosticEntry>);
          if (entry) parsed.push(entry);
        } catch {
          // A partial final line after an interrupted write is safe to ignore.
        }
      }
      this.entries = parsed.slice(-MAX_ENTRIES);
    } catch (error) {
      console.warn("VaultPilot diagnostics could not load the local log", error);
    }
  }

  record(event: DiagnosticEvent): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      platform: Platform.isMobile ? "mobile" : "desktop",
      level: event.level,
      area: sanitizeLabel(event.area),
      event: sanitizeLabel(event.event),
      ...(event.details ? { details: sanitizeDetails(event.details) } : {})
    });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.scheduleFlush();
  }

  latest(limit = 50): DiagnosticEntry[] {
    return this.entries.slice(-Math.max(0, limit)).reverse().map((entry) => ({
      ...entry,
      ...(entry.details ? { details: { ...entry.details } } : {})
    }));
  }

  getPath(): string {
    return this.path;
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushHandle !== null) {
      globalThis.clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    const payload = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.app.vault.adapter.write(this.path, payload ? `${payload}\n` : ""));
    try {
      await this.writeChain;
    } catch (error) {
      console.warn("VaultPilot diagnostics could not write the local log", error);
    }
  }

  async exportToVault(): Promise<string> {
    await this.flush();
    await ensureFolder(this.app, EXPORT_FOLDER);
    const base = `${EXPORT_FOLDER}/VaultPilotDiagnostics@${diagnosticTimestamp(new Date())}`;
    let path = `${base}.md`;
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(path); suffix += 1) path = `${base}-${suffix}.md`;
    const lines = [
      "# VaultPilot Diagnostics",
      "",
      "This export contains operational metadata only. Prompts, note contents, tool arguments, response bodies, images, headers, and API keys are never recorded.",
      "",
      `- Exported: ${new Date().toISOString()}`,
      `- Platform: ${Platform.isMobile ? "mobile" : "desktop"}`,
      `- Entries: ${this.entries.length}`,
      "",
      "```jsonl",
      ...this.entries.map((entry) => JSON.stringify(entry)),
      "```",
      ""
    ];
    await this.app.vault.create(path, lines.join("\n"));
    return path;
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) globalThis.clearTimeout(this.flushHandle);
    this.flushHandle = globalThis.setTimeout(() => {
      this.flushHandle = null;
      void this.flush();
    }, FLUSH_DELAY_MS) as unknown as number;
  }
}

function normalizeStoredEntry(value: Partial<DiagnosticEntry>): DiagnosticEntry | null {
  if (!value.timestamp || !value.level || !value.area || !value.event) return null;
  if (!Number.isFinite(Date.parse(value.timestamp))) return null;
  if (!(["info", "warning", "error"] as string[]).includes(value.level)) return null;
  return {
    timestamp: value.timestamp,
    platform: value.platform === "mobile" ? "mobile" : "desktop",
    level: value.level,
    area: sanitizeLabel(value.area),
    event: sanitizeLabel(value.event),
    ...(value.details ? { details: sanitizeDetails(value.details) } : {})
  };
}

function sanitizeDetails(details: Record<string, DiagnosticValue>): Record<string, DiagnosticValue> {
  const output: Record<string, DiagnosticValue> = {};
  for (const [rawKey, rawValue] of Object.entries(details).slice(0, 24)) {
    const key = sanitizeLabel(rawKey);
    if (!key) continue;
    if (UNSAFE_DETAIL_KEY.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = typeof rawValue === "string" ? redactSensitive(rawValue).slice(0, 500) : rawValue;
  }
  return output;
}

function sanitizeLabel(value: string): string {
  return redactSensitive(String(value)).replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

function redactSensitive(value: string): string {
  return value
    .replace(/\b(?:AQ\.|AIza|sk-)[A-Za-z0-9._-]{10,}\b/g, "[secret]")
    .replace(/\b(?:Bearer|x-goog-api-key)\s*[:=]?\s*[^\s,;]+/gi, "[credential]")
    .replace(/\b[A-Za-z]:\\[^\r\n\"]+/g, "[local-path]")
    .replace(/\/(?:Users|home)\/[^\r\n\"]+/g, "[local-path]");
}

function diagnosticTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
