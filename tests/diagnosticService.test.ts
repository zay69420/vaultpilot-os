import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DiagnosticService } from "../src/services/diagnosticService";

function diagnosticApp(initial = ""): { app: App; writes: Map<string, string>; created: Map<string, string> } {
  const writes = new Map<string, string>();
  const created = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (path: string) => Boolean(initial || writes.has(path))),
    read: vi.fn(async (path: string) => writes.get(path) ?? initial),
    write: vi.fn(async (path: string, data: string) => {
      writes.set(path, data);
    })
  };
  return {
    app: {
      vault: {
        configDir: ".obsidian",
        adapter,
        getAbstractFileByPath: vi.fn(() => null),
        createFolder: vi.fn(async () => undefined),
        create: vi.fn(async (path: string, data: string) => {
          created.set(path, data);
          return {};
        })
      }
    } as unknown as App,
    writes,
    created
  };
}

describe("DiagnosticService", () => {
  it("writes a bounded plugin-local JSONL log with sensitive values redacted", async () => {
    const { app, writes } = diagnosticApp();
    const service = new DiagnosticService(app, "vaultpilot-os");
    service.record({
      level: "error",
      area: "gemini",
      event: "request_failed",
      details: {
        model: "gemini-3.5-flash",
        prompt: "private note text",
        error: "x-goog-api-key: AQ.this-is-a-secret-test-key and C:\\Users\\person\\vault\\note.md"
      }
    });
    await service.flush();

    const raw = writes.get(".obsidian/plugins/vaultpilot-os/diagnostics.jsonl") ?? "";
    expect(raw).toContain("request_failed");
    expect(raw).toContain("[redacted]");
    expect(raw).toContain("[credential]");
    expect(raw).toContain("[local-path]");
    expect(raw).not.toContain("private note text");
    expect(raw).not.toContain("this-is-a-secret-test-key");
  });

  it("keeps only the newest 300 diagnostic events", async () => {
    const { app } = diagnosticApp();
    const service = new DiagnosticService(app, "vaultpilot-os");
    for (let index = 0; index < 325; index += 1) {
      service.record({ level: "info", area: "test", event: `event-${index}`, details: { index } });
    }

    const entries = service.latest(400);
    expect(entries).toHaveLength(300);
    expect(entries[0]?.event).toBe("event-324");
    expect(entries.at(-1)?.event).toBe("event-25");
    await service.flush();
  });

  it("exports a redacted Markdown diagnostic report to the vault", async () => {
    const { app, created } = diagnosticApp();
    const service = new DiagnosticService(app, "vaultpilot-os");
    service.record({
      level: "error",
      area: "gemini",
      event: "transport_failed",
      details: { errorKind: "timeout", prompt: "private prompt", model: "gemini-3.5-flash" }
    });

    const path = await service.exportToVault();
    const report = created.get(path) ?? "";
    expect(path).toMatch(/^VaultPilot Diagnostics\/VaultPilotDiagnostics@\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/);
    expect(report).toContain("transport_failed");
    expect(report).toContain('"prompt":"[redacted]"');
    expect(report).not.toContain("private prompt");
  });
});
