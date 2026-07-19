import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { AgentService } from "../src/services/agentService";
import type { GeminiClient } from "../src/services/geminiClient";
import type { MemoryService } from "../src/services/memoryService";
import type { ToolRegistry } from "../src/services/toolRegistry";
import type { AgentCallbacks, GeminiContent, GeminiTurnResult, TokenUsage } from "../src/types";

const usage = (): TokenUsage => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 });

function callbacks(text: string[]): AgentCallbacks {
  return {
    onText: (delta) => text.push(delta),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onApproval: vi.fn(async () => true),
    onUsage: vi.fn()
  };
}

describe("AgentService resilience", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    {
      caseName: "an empty STOP response",
      failedFinalTurn: new Error("Gemini completed the request without displayable text (STOP).")
    },
    {
      caseName: "an unexpected function call",
      failedFinalTurn: {
        content: { role: "model", parts: [{ functionCall: { id: "call-2", name: "vault_search", args: { query: "again" } } }] },
        text: "",
        functionCalls: [{ id: "call-2", name: "vault_search", args: { query: "again" } }],
        usage: usage()
      } satisfies GeminiTurnResult
    }
  ])("automatically recovers from $caseName after tools", async ({ failedFinalTurn }) => {
    const turns: Array<GeminiTurnResult | Error> = [
      {
        content: { role: "model", parts: [{ functionCall: { id: "call-1", name: "vault_search", args: { query: "test" } } }] },
        text: "",
        functionCalls: [{ id: "call-1", name: "vault_search", args: { query: "test" } }],
        usage: usage()
      },
      failedFinalTurn,
      {
        content: { role: "model", parts: [{ text: "Recovered final answer" }] },
        text: "Recovered final answer",
        functionCalls: [],
        usage: usage()
      }
    ];
    const gemini = {
      generateTurn: vi.fn(async (options: { onText?: (delta: string) => void }) => {
        const turn = turns.shift();
        if (!turn) throw new Error("Unexpected extra Gemini turn");
        if (turn instanceof Error) throw turn;
        if (turn.text) options.onText?.(turn.text);
        return turn;
      })
    } as unknown as GeminiClient;
    const memory = {
      retrieve: vi.fn(async () => ""),
      intercept: vi.fn(async () => 0)
    } as unknown as MemoryService;
    const tool = {
      risk: "read",
      declaration: { name: "vault_search", description: "Search", parameters: {} },
      describe: () => "Search vault",
      execute: vi.fn(async () => ({ matches: [] }))
    };
    const tools = {
      declarations: vi.fn(() => [tool.declaration]),
      get: vi.fn(() => tool),
      execute: vi.fn(async () => ({ matches: [] })),
      recordDenied: vi.fn()
    } as unknown as ToolRegistry;
    const text: string[] = [];
    const service = new AgentService(
      gemini,
      memory,
      tools,
      () => ({ ...DEFAULT_SETTINGS, memoryEnabled: false, maxAgentSteps: 1 }),
      async () => [
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }, { text: "Inspect this image" }] },
        { role: "model", parts: [{ text: "Gemini finished without text after an automatic recovery attempt." }] },
        { role: "user", parts: [{ text: "Find it" }] }
      ]
    );

    await expect(service.run("Find it", callbacks(text))).resolves.toBe("Recovered final answer");
    expect(text.join("")).toBe("Recovered final answer");
    expect(gemini.generateTurn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(gemini.generateTurn).mock.calls[1]?.[0]).toMatchObject({ toolMode: "NONE" });
    const recoveryOptions = vi.mocked(gemini.generateTurn).mock.calls[2]?.[0] as unknown as {
      contents: GeminiContent[];
      tools?: unknown;
      toolMode?: unknown;
      maxOutputTokens?: number;
      thinkingLevel?: string;
    };
    expect(recoveryOptions.tools).toBeUndefined();
    expect(recoveryOptions.toolMode).toBeUndefined();
    expect(recoveryOptions.maxOutputTokens).toBe(2048);
    expect(recoveryOptions.thinkingLevel).toBe("minimal");
    expect(recoveryOptions.contents).toHaveLength(1);
    const recoveryPayload = JSON.stringify(recoveryOptions.contents);
    expect(recoveryPayload).toContain("Result data from vault search");
    expect(recoveryPayload).not.toContain("[vault_search]");
    expect(recoveryPayload).toContain('"inlineData":{"mimeType":"image/png","data":"AQID"}');
    expect(recoveryPayload).not.toContain("Gemini finished without text");
    expect(recoveryPayload).not.toContain("functionCall");
    expect(recoveryPayload).not.toContain("functionResponse");
  });

  it("converts an exact raw write receipt into a concise user-facing confirmation", async () => {
    const turns: GeminiTurnResult[] = [
      {
        content: { role: "model", parts: [{ functionCall: { id: "write-1", name: "edit_note", args: { path: "memory/link_index.md" } } }] },
        text: "",
        functionCalls: [{ id: "write-1", name: "edit_note", args: { path: "memory/link_index.md" } }],
        usage: usage()
      },
      {
        content: { role: "model", parts: [{ functionCall: { id: "write-2", name: "edit_note", args: { path: "memory/link_index.md" } } }] },
        text: "",
        functionCalls: [{ id: "write-2", name: "edit_note", args: { path: "memory/link_index.md" } }],
        usage: usage()
      },
      {
        content: { role: "model", parts: [{ text: '[edit_note] {"ok":true,"operation":"rewrite","path":"memory/link_index.md"}' }] },
        text: '[edit_note] {"ok":true,"operation":"rewrite","path":"memory/link_index.md"}',
        functionCalls: [],
        usage: usage()
      }
    ];
    const gemini = {
      generateTurn: vi.fn(async (options: { onText?: (delta: string) => void }) => {
        const turn = turns.shift();
        if (!turn) throw new Error("Unexpected extra Gemini turn");
        if (turn.text) options.onText?.(turn.text);
        return turn;
      })
    } as unknown as GeminiClient;
    const memory = { retrieve: vi.fn(async () => ""), intercept: vi.fn(async () => 0) } as unknown as MemoryService;
    const tool = {
      risk: "write",
      declaration: { name: "edit_note", description: "Edit", parameters: {} },
      describe: () => "Rewrite note",
      execute: vi.fn(async () => ({ ok: true, operation: "rewrite", path: "memory/link_index.md" }))
    };
    const tools = {
      declarations: vi.fn(() => [tool.declaration]),
      get: vi.fn(() => tool),
      execute: vi.fn(async () => ({ ok: true, operation: "rewrite", path: "memory/link_index.md" })),
      recordDenied: vi.fn()
    } as unknown as ToolRegistry;
    const text: string[] = [];
    const service = new AgentService(
      gemini,
      memory,
      tools,
      () => ({ ...DEFAULT_SETTINGS, memoryEnabled: false, maxAgentSteps: 1 }),
      async () => [
        { role: "model", parts: [{ text: "x".repeat(50_000) }] },
        { role: "user", parts: [{ text: "Update my link index" }] }
      ]
    );

    await expect(service.run("Update my link index", callbacks(text))).resolves.toBe("Done — I rewrote `memory/link_index.md`.");
    expect(text.join("")).toBe("Done — I rewrote `memory/link_index.md`.");
    expect(text.join("")).not.toContain("[edit_note]");
    const firstContents = (vi.mocked(gemini.generateTurn).mock.calls[0]?.[0] as unknown as { contents: GeminiContent[] }).contents;
    const firstTextChars = firstContents.reduce((total, content) => total + content.parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0), 0);
    expect(firstTextChars).toBeLessThanOrEqual(24_000);
  });

  it("defers background memory extraction until after the mobile response", async () => {
    vi.useFakeTimers();
    const gemini = {
      generateTurn: vi.fn(async (options: { onText?: (delta: string) => void }) => {
        options.onText?.("Immediate answer");
        return {
          content: { role: "model", parts: [{ text: "Immediate answer" }] },
          text: "Immediate answer",
          functionCalls: [],
          usage: usage()
        } satisfies GeminiTurnResult;
      })
    } as unknown as GeminiClient;
    const memory = {
      retrieve: vi.fn(async () => ""),
      intercept: vi.fn(async () => 0)
    } as unknown as MemoryService;
    const tools = { declarations: vi.fn(() => []) } as unknown as ToolRegistry;
    const text: string[] = [];
    const service = new AgentService(
      gemini,
      memory,
      tools,
      () => ({ ...DEFAULT_SETTINGS, memoryEnabled: true, memoryInterceptEnabled: true, memoryInterceptMode: "background" }),
      async () => [{ role: "user", parts: [{ text: "Remember this" }] }],
      { deferBackgroundMemoryMs: 1500 }
    );

    await expect(service.run("Remember this", callbacks(text))).resolves.toBe("Immediate answer");
    expect(memory.intercept).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(memory.intercept).toHaveBeenCalledOnce();
  });
});
