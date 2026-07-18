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
