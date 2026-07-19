import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { GeminiClient } from "../src/services/geminiClient";

describe("GeminiClient authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes AQ authorization keys unchanged in x-goog-api-key", async () => {
    const authorizationKey = "AQ.example_authorization-key.with-dots";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(authorizationKey);
      return new Response(JSON.stringify({ totalTokens: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient(() => ({ ...DEFAULT_SETTINGS, apiKey: authorizationKey }), fetchMock);

    await expect(client.testConnection()).resolves.toContain("Connected");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("supports an injected mobile-safe network transport", async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("x-goog-api-key")).toBe("AQ.mobile-test-key");
      return new Response(JSON.stringify({ totalTokens: 3 }), { status: 200 });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.mobile-test-key" }),
      transport
    );

    await expect(client.testConnection()).resolves.toContain("3 test tokens");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("uses the buffered generateContent endpoint when streaming is disabled for mobile", async () => {
    const deltas: string[] = [];
    const transport = vi.fn(async (url: string) => {
      expect(url).toContain(":generateContent");
      expect(url).not.toContain(":streamGenerateContent");
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Mobile response" }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.mobile-generation-test-key" }),
      transport,
      { streaming: false }
    );

    await expect(client.generateTurn({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: "Be concise.",
      onText: (delta) => deltas.push(delta)
    })).resolves.toMatchObject({ text: "Mobile response" });

    expect(deltas).toEqual(["Mobile response"]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("falls back to generateContent when a buffered SSE response contains no events", async () => {
    const transport = vi.fn(async (url: string) => {
      if (url.includes(":streamGenerateContent")) {
        return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Recovered response" }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.empty-stream-test-key" }),
      transport
    );

    await expect(client.generateTurn({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: "Be concise."
    })).resolves.toMatchObject({ text: "Recovered response" });

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("retries transient mobile network failures with bounded backoff", async () => {
    let attempts = 0;
    const transport = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(attempts === 1 ? "Request failed. The request timed out." : "The network connection was lost.");
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Recovered after retry" }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.retry-network-test-key" }),
      transport,
      { streaming: false, maxRetries: 2, retryBaseDelayMs: 0 }
    );

    await expect(client.generateTurn({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: "Be concise."
    })).resolves.toMatchObject({ text: "Recovered after retry" });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("retries retryable Gemini status codes but not permanent request errors", async () => {
    const retryableTransport = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Temporarily unavailable" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalTokens: 2 }), { status: 200 }));
    const retryableClient = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.retry-status-test-key" }),
      retryableTransport,
      { maxRetries: 1, retryBaseDelayMs: 0 }
    );
    await expect(retryableClient.testConnection()).resolves.toContain("Connected");
    expect(retryableTransport).toHaveBeenCalledTimes(2);

    const permanentTransport = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid request" } }), { status: 400 }));
    const permanentClient = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.permanent-error-test-key" }),
      permanentTransport,
      { maxRetries: 2, retryBaseDelayMs: 0 }
    );
    await expect(permanentClient.testConnection()).rejects.toThrow("Gemini API error (400): Invalid request");
    expect(permanentTransport).toHaveBeenCalledOnce();
  });

  it("uses low-latency Gemini 3 settings and a mobile output cap", async () => {
    let requestBody: { generationConfig?: Record<string, unknown> } | undefined;
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as { generationConfig?: Record<string, unknown> };
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Fast mobile response" }] } }]
      }), { status: 200 });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.mobile-thinking-test-key", model: "gemini-3.5-flash", maxOutputTokens: 16000 }),
      transport,
      { streaming: false, thinkingLevel: "low", maxOutputTokens: 8192 }
    );

    await client.generateTurn({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: "Be concise."
    });
    expect(requestBody?.generationConfig).toMatchObject({
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: "low" }
    });
    expect(requestBody?.generationConfig).not.toHaveProperty("temperature");
  });

  it("can force a final agent turn into text-only function-calling mode", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Final answer" }] } }]
      }), { status: 200 });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.text-only-test-key" }),
      transport,
      { streaming: false }
    );

    await client.generateTurn({
      contents: [{ role: "user", parts: [{ text: "Finish the answer" }] }],
      systemInstruction: "Return the final answer.",
      tools: [{ name: "vault_search", description: "Search the vault", parameters: {} }],
      toolMode: "NONE",
      maxOutputTokens: 2048,
      thinkingLevel: "minimal"
    });

    expect(requestBody).toMatchObject({
      tools: [{ functionDeclarations: [{ name: "vault_search" }] }],
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: "minimal" }
      }
    });
  });

  it("serializes mobile Gemini traffic so background work cannot compete with chat", async () => {
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const transport = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        signalFirstStarted();
        await firstGate;
      }
      return new Response(JSON.stringify({ totalTokens: calls }), { status: 200 });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.serial-mobile-test-key" }),
      transport,
      { serializeRequests: true }
    );

    const first = client.testConnection();
    await firstStarted;
    const second = client.testConnection();
    await Promise.resolve();
    expect(transport).toHaveBeenCalledOnce();
    releaseFirst();
    await Promise.all([first, second]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("reports Gemini finish metadata when a response contains no text", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ thought: true, text: "internal" }] }, finishReason: "MAX_TOKENS" }]
    }), { status: 200 }));
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.empty-finish-test-key" }),
      transport,
      { streaming: false }
    );

    await expect(client.generateTurn({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: "Be concise."
    })).rejects.toThrow("reached its output limit before producing displayable text");
  });

  it("sends image parts to Gemini as inlineData without rewriting the payload", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      const event = {
        candidates: [{ content: { role: "model", parts: [{ text: "Image received" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.multimodal-test-key" }),
      transport
    );

    await expect(client.generateTurn({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: "AQID" } },
          { text: "Describe this image" }
        ]
      }],
      systemInstruction: "Be concise."
    })).resolves.toMatchObject({ text: "Image received" });

    expect(requestBody).toMatchObject({
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: "AQID" } },
          { text: "Describe this image" }
        ]
      }]
    });
  });

  it("batches embedding requests and preserves vector order", async () => {
    let requestBody: { requests?: unknown[] } | undefined;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain(":batchEmbedContents");
      requestBody = JSON.parse(String(init.body)) as { requests?: unknown[] };
      return new Response(JSON.stringify({
        embeddings: [
          { values: [1, 0, 0] },
          { values: [0, 1, 0] }
        ]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new GeminiClient(
      () => ({ ...DEFAULT_SETTINGS, apiKey: "AQ.batch-test-key", embeddingDimensions: 3 }),
      transport
    );

    await expect(client.embedBatch(["first", "second"])).resolves.toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(requestBody?.requests).toHaveLength(2);
  });
});
