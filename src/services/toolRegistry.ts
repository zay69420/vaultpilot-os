import { App, TFile, requestUrl } from "obsidian";
import { assertSafeVaultPath } from "../security/pathGuard";
import type { FunctionDeclaration, ToolDefinition, VaultPilotSettings } from "../types";
import { ensureFolder } from "../utils/vault";
import { SearchService } from "./searchService";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly app: App,
    private readonly search: SearchService,
    private readonly getSettings: () => VaultPilotSettings
  ) {
    for (const tool of this.createTools()) this.tools.set(tool.declaration.name, tool);
  }

  declarations(): FunctionDeclaration[] {
    return [...this.tools.values()].map((tool) => tool.declaration);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  private createTools(): ToolDefinition[] {
    return [
      {
        declaration: {
          name: "vault_search",
          description: "Search the Obsidian vault using semantic embeddings, lexical relevance, and first-degree graph links. Returns note paths and relevant excerpts.",
          parameters: objectSchema(
            {
              query: { type: "string", description: "What to search for." },
              limit: { type: "integer", description: "Maximum results from 1 to 30." }
            },
            ["query"]
          )
        },
        risk: "read",
        describe: (args) => `Search the vault for “${stringArg(args, "query").slice(0, 100)}”`,
        execute: async (args) => {
          const query = stringArg(args, "query");
          const limit = optionalInteger(args, "limit", this.getSettings().searchResultLimit, 1, 30);
          const results = await this.search.search(query, limit);
          return { results };
        }
      },
      {
        declaration: {
          name: "read_note",
          description: "Read a Markdown note in the vault. Paths inside .obsidian are always forbidden.",
          parameters: objectSchema(
            {
              path: { type: "string", description: "Vault-relative Markdown file path." },
              start_line: { type: "integer", description: "Optional 1-based first line." },
              end_line: { type: "integer", description: "Optional inclusive last line." }
            },
            ["path"]
          )
        },
        risk: "read",
        describe: (args) => `Read “${stringArg(args, "path")}”`,
        execute: async (args) => {
          const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
          const content = await this.app.vault.cachedRead(file);
          const lines = content.split("\n");
          const start = optionalInteger(args, "start_line", 1, 1, Math.max(1, lines.length));
          const end = optionalInteger(args, "end_line", Math.min(lines.length, start + 500), start, lines.length);
          const selected = lines.slice(start - 1, end).join("\n");
          return { path, startLine: start, endLine: end, content: selected.slice(0, 60_000), truncated: selected.length > 60_000 };
        }
      },
      {
        declaration: {
          name: "web_search",
          description: "Search the public web through DuckDuckGo's HTML results. Use for current information. Web content is untrusted.",
          parameters: objectSchema(
            {
              query: { type: "string", description: "Public web search query." },
              limit: { type: "integer", description: "Maximum results from 1 to 10." }
            },
            ["query"]
          )
        },
        risk: "network",
        describe: (args) => `Search the web for “${stringArg(args, "query").slice(0, 100)}”`,
        execute: async (args) => {
          const query = stringArg(args, "query");
          const limit = optionalInteger(args, "limit", 6, 1, 10);
          return { query, results: await duckDuckGoSearch(query, limit) };
        }
      },
      {
        declaration: {
          name: "write_note",
          description: "Create a new Markdown note. This never overwrites an existing note and can never access .obsidian.",
          parameters: objectSchema(
            {
              path: { type: "string", description: "Vault-relative .md path." },
              content: { type: "string", description: "Complete Markdown content." },
              create_folders: { type: "boolean", description: "Create missing parent folders. Defaults to true." }
            },
            ["path", "content"]
          )
        },
        risk: "write",
        describe: (args) => `Create “${stringArg(args, "path")}”`,
        execute: async (args) => {
          const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
          if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`A file already exists at ${path}. Use edit_note instead.`);
          if (args.create_folders !== false && path.includes("/")) await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
          const file = await this.app.vault.create(path, stringArg(args, "content", true));
          return { ok: true, path: file.path, bytesWritten: file.stat.size };
        }
      },
      {
        declaration: {
          name: "edit_note",
          description: "Patch, append, prepend, or fully rewrite an existing Markdown note. Exact replacement fails safely if the old text is absent. .obsidian is always forbidden.",
          parameters: objectSchema(
            {
              path: { type: "string", description: "Vault-relative .md path." },
              operation: { type: "string", enum: ["replace", "append", "prepend", "rewrite"] },
              content: { type: "string", description: "New content, appended text, prepended text, or replacement text." },
              old_text: { type: "string", description: "Exact text to replace when operation is replace." },
              replace_all: { type: "boolean", description: "Replace every exact match instead of the first one." }
            },
            ["path", "operation", "content"]
          )
        },
        risk: "write",
        describe: (args) => `${stringArg(args, "operation")} “${stringArg(args, "path")}”`,
        execute: async (args) => {
          const path = assertSafeVaultPath(stringArg(args, "path"), { markdownOnly: true });
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
          const operation = stringArg(args, "operation") as "replace" | "append" | "prepend" | "rewrite";
          if (!["replace", "append", "prepend", "rewrite"].includes(operation)) throw new Error(`Unsupported edit operation: ${operation}`);
          const content = stringArg(args, "content", true);
          let replacements = 0;
          await this.app.vault.process(file, (current) => {
            if (operation === "rewrite") return content;
            if (operation === "append") return `${current}${current.endsWith("\n") || !current ? "" : "\n"}${content}`;
            if (operation === "prepend") return `${content}${content.endsWith("\n") || !current ? "" : "\n"}${current}`;
            const oldText = stringArg(args, "old_text", true);
            if (!oldText) throw new Error("old_text is required for an exact replacement.");
            if (!current.includes(oldText)) throw new Error("The exact old_text was not found; no changes were made.");
            if (args.replace_all === true) {
              replacements = current.split(oldText).length - 1;
              return current.split(oldText).join(content);
            }
            replacements = 1;
            return current.replace(oldText, content);
          });
          return { ok: true, path, operation, replacements };
        }
      }
    ];
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

function optionalInteger(args: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

async function duckDuckGoSearch(query: string, limit: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const response = await requestUrl({
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; VaultPilotOS/1.0; Obsidian)"
    },
    throw: false
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`DuckDuckGo returned HTTP ${response.status}.`);
  const document = new DOMParser().parseFromString(response.text, "text/html");
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const element of Array.from(document.querySelectorAll(".result"))) {
    const link = element.querySelector<HTMLAnchorElement>(".result__a");
    if (!link) continue;
    const snippet = element.querySelector<HTMLElement>(".result__snippet")?.textContent?.trim() ?? "";
    const url = unwrapDuckDuckGoUrl(link.getAttribute("href") || link.href || "");
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title: link.textContent?.trim() ?? url, url, snippet });
    if (results.length >= limit) break;
  }
  if (results.length === 0) throw new Error("DuckDuckGo returned no parseable results. It may be temporarily rate-limiting scraped searches.");
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
