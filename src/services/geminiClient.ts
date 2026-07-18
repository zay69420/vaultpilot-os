import type {
  FunctionDeclaration,
  GeminiContent,
  GeminiPart,
  GeminiTurnResult,
  GeminiUsageMetadata,
  TokenUsage,
  VaultPilotSettings
} from "../types";

const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiClientOptions {
  /**
   * Obsidian's native requestUrl bridge buffers the complete response. Mobile
   * WebViews are especially inconsistent when that buffered payload is wrapped
   * as an SSE ReadableStream, so mobile callers should use generateContent.
   */
  streaming?: boolean;
}

interface GenerateOptions {
  contents: GeminiContent[];
  systemInstruction: string;
  tools?: FunctionDeclaration[];
  model?: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

interface GeminiChunk {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
  error?: { message?: string; code?: number; status?: string };
}

export class GeminiClient {
  constructor(
    private readonly getSettings: () => VaultPilotSettings,
    private readonly transport: GeminiTransport,
    private readonly clientOptions: GeminiClientOptions = {}
  ) {}

  async testConnection(): Promise<string> {
    const settings = this.requireSettings();
    const response = await this.request(
      settings.model,
      "countTokens",
      { contents: [{ role: "user", parts: [{ text: "Connection test" }] }] },
      undefined
    );
    const data = (await response.json()) as { totalTokens?: number };
    return `Connected to ${settings.model}${typeof data.totalTokens === "number" ? ` (${data.totalTokens} test tokens)` : ""}.`;
  }

  async generateTurn(options: GenerateOptions): Promise<GeminiTurnResult> {
    const settings = this.requireSettings();
    if (this.clientOptions.streaming === false) return this.generateTurnWithoutStreaming(options);

    const body = this.createGenerateBody(options, settings);
    const response = await this.request(options.model ?? settings.model, "streamGenerateContent?alt=sse", body, options.signal);
    if (!response.body) return this.generateTurnWithoutStreaming(options);

    const parts: GeminiPart[] = [];
    let usageMetadata: GeminiUsageMetadata = {};
    await this.consumeSse(response.body, (chunk) => {
      if (chunk.error?.message) throw new Error(chunk.error.message);
      if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
      const incoming = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of incoming) {
        parts.push(part);
        if (part.text && !part.thought) options.onText?.(part.text);
      }
    }, options.signal);

    const result = this.turnResult(parts, usageMetadata, settings);
    if (hasUsableTurn(result)) return result;

    // A buffered native response can expose a body while yielding no SSE data
    // on some WebViews. Retry once through Gemini's ordinary JSON endpoint.
    return this.generateTurnWithoutStreaming(options);
  }

  async generateJson<T>(options: {
    prompt: string;
    systemInstruction: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<{ value: T; usage: TokenUsage }> {
    const settings = this.requireSettings();
    const body = {
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json"
      }
    };
    const response = await this.request(options.model ?? settings.model, "generateContent", body, options.signal);
    const data = (await response.json()) as GeminiChunk;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
    try {
      return { value: JSON.parse(stripJsonFence(text)) as T, usage: this.toUsage(data.usageMetadata, settings) };
    } catch {
      throw new Error("Gemini returned an invalid structured response.");
    }
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const settings = this.requireSettings();
    const model = settings.embeddingModel.replace(/^models\//, "");
    const body = {
      model: `models/${model}`,
      content: { parts: [{ text }] },
      outputDimensionality: settings.embeddingDimensions
    };
    const response = await this.request(model, "embedContent", body, signal);
    const data = (await response.json()) as {
      embedding?: { values?: number[] };
      embeddings?: Array<{ values?: number[] }>;
    };
    const values = data.embedding?.values ?? data.embeddings?.[0]?.values;
    if (!values?.length) throw new Error("Gemini did not return an embedding vector.");
    return values;
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const settings = this.requireSettings();
    const model = settings.embeddingModel.replace(/^models\//, "");
    const batches: number[][] = [];
    for (let start = 0; start < texts.length; start += 100) {
      const slice = texts.slice(start, start + 100);
      const body = {
        requests: slice.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          outputDimensionality: settings.embeddingDimensions
        }))
      };
      const response = await this.request(model, "batchEmbedContents", body, signal);
      const data = (await response.json()) as { embeddings?: Array<{ values?: number[] }> };
      const values = data.embeddings?.map((embedding) => embedding.values ?? []) ?? [];
      if (values.length !== slice.length || values.some((embedding) => embedding.length === 0)) {
        throw new Error("Gemini returned an incomplete batch of embedding vectors.");
      }
      batches.push(...values);
    }
    return batches;
  }

  private async generateTurnWithoutStreaming(options: GenerateOptions): Promise<GeminiTurnResult> {
    const settings = this.requireSettings();
    const response = await this.request(
      options.model ?? settings.model,
      "generateContent",
      this.createGenerateBody(options, settings),
      options.signal
    );
    const data = (await response.json()) as GeminiChunk;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const publicText = parts.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
    if (publicText) options.onText?.(publicText);
    const result = this.turnResult(parts, data.usageMetadata ?? {}, settings);
    if (!hasUsableTurn(result)) {
      throw new Error("Gemini completed the request but returned neither response text nor a tool call.");
    }
    return result;
  }

  private createGenerateBody(options: GenerateOptions, settings: VaultPilotSettings): Record<string, unknown> {
    return {
      contents: options.contents,
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      ...(options.tools?.length ? { tools: [{ functionDeclarations: options.tools }] } : {}),
      generationConfig: {
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens
      }
    };
  }

  private turnResult(parts: GeminiPart[], metadata: GeminiUsageMetadata, settings: VaultPilotSettings): GeminiTurnResult {
    const text = parts.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
    const functionCalls = parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
    return {
      content: { role: "model", parts },
      text,
      functionCalls,
      usage: this.toUsage(metadata, settings)
    };
  }

  private toUsage(metadata: GeminiUsageMetadata | undefined, settings: VaultPilotSettings): TokenUsage {
    const inputTokens = metadata?.promptTokenCount ?? 0;
    const explicitOutput = (metadata?.candidatesTokenCount ?? 0) + (metadata?.thoughtsTokenCount ?? 0);
    const outputTokens = explicitOutput || Math.max(0, (metadata?.totalTokenCount ?? 0) - inputTokens);
    const totalTokens = metadata?.totalTokenCount ?? inputTokens + outputTokens;
    const costUsd = (inputTokens * settings.inputPricePerMillion + outputTokens * settings.outputPricePerMillion) / 1_000_000;
    return { inputTokens, outputTokens, totalTokens, costUsd };
  }

  private requireSettings(): VaultPilotSettings {
    const settings = this.getSettings();
    if (!settings.apiKey.trim()) throw new Error("Add a Gemini API key in VaultPilot OS settings first.");
    return settings;
  }

  private async request(modelInput: string, method: string, body: unknown, signal: AbortSignal | undefined): Promise<Response> {
    const settings = this.requireSettings();
    const model = modelInput.replace(/^models\//, "").trim();
    if (!model || /[?#]/.test(model)) throw new Error("The configured Gemini model name is invalid.");
    const url = `${GEMINI_API_ROOT}/models/${encodeURIComponent(model)}:${method}`;
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": settings.apiKey.trim()
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException("The request was stopped.", "AbortError");
      throw new Error(`Could not reach the Gemini API: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      const message = await readApiError(response);
      throw new Error(`Gemini API error (${response.status}): ${message}`);
    }
    return response;
  }

  private async consumeSse(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: GeminiChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException("The request was stopped.", "AbortError");
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          this.parseSseEvent(event, onChunk);
          if (events.length > 1) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
        }
        if (done) break;
      }
      if (buffer.trim()) this.parseSseEvent(buffer, onChunk);
    } finally {
      reader.releaseLock();
    }
  }

  private parseSseEvent(event: string, onChunk: (chunk: GeminiChunk) => void): void {
    const payload = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!payload || payload === "[DONE]") return;
    try {
      onChunk(JSON.parse(payload) as GeminiChunk);
    } catch {
      throw new Error("Gemini returned an unreadable streaming response.");
    }
  }
}

function hasUsableTurn(result: GeminiTurnResult): boolean {
  return Boolean(result.text.trim() || result.functionCalls.length);
}

function stripJsonFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { error?: { message?: string } };
    return data.error?.message ?? "Unknown API error";
  } catch {
    return text.slice(0, 500) || response.statusText;
  }
}
