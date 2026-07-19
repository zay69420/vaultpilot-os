import type {
  DiagnosticReporter,
  FunctionDeclaration,
  GeminiContent,
  GeminiPart,
  GeminiTurnResult,
  GeminiUsageMetadata,
  TokenUsage,
  VaultPilotSettings
} from "../types";
import { diagnosticErrorKind } from "../utils/diagnostics";

const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiClientOptions {
  /**
   * Obsidian's native requestUrl bridge buffers the complete response. Mobile
   * WebViews are especially inconsistent when that buffered payload is wrapped
   * as an SSE ReadableStream, so mobile callers should use generateContent.
   */
  streaming?: boolean;
  /** Retries after the initial attempt for transient network and API failures. */
  maxRetries?: number;
  /** Initial exponential-backoff delay. Set to zero in deterministic tests. */
  retryBaseDelayMs?: number;
  /** Serializes Gemini traffic so mobile chat, memory, and indexing do not compete. */
  serializeRequests?: boolean;
  /** Gemini 3 thinking level for latency-sensitive clients such as mobile. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  /** Optional per-turn output cap for constrained clients. */
  maxOutputTokens?: number;
  /** Receives metadata-only diagnostics. Prompts and response bodies are excluded. */
  diagnostics?: DiagnosticReporter;
}

interface GenerateOptions {
  contents: GeminiContent[];
  systemInstruction: string;
  tools?: FunctionDeclaration[];
  model?: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  toolMode?: "AUTO" | "NONE";
}

interface GeminiChunk {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
    finishMessage?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
  responseId?: string;
  modelVersion?: string;
  error?: { message?: string; code?: number; status?: string };
}

export class GeminiClient {
  private requestQueueTail: Promise<void> = Promise.resolve();

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
    this.reportGeneration(options.model ?? settings.model, "stream_turn", {
      candidates: [{ content: { role: "model", parts } }],
      usageMetadata
    });
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
        ...this.createGenerationConfig(options.model ?? settings.model, settings, 2048, 0.1),
        responseMimeType: "application/json"
      }
    };
    const response = await this.request(options.model ?? settings.model, "generateContent", body, options.signal);
    const data = (await response.json()) as GeminiChunk;
    this.reportGeneration(options.model ?? settings.model, "structured_generation", data);
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
    this.reportGeneration(options.model ?? settings.model, "buffered_turn", data);
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const publicText = parts.filter((part) => !part.thought).map((part) => part.text ?? "").join("");
    if (publicText) options.onText?.(publicText);
    const result = this.turnResult(parts, data.usageMetadata ?? {}, settings);
    if (!hasUsableTurn(result)) {
      throw emptyResponseError(data);
    }
    return result;
  }

  private createGenerateBody(options: GenerateOptions, settings: VaultPilotSettings): Record<string, unknown> {
    return {
      contents: options.contents,
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      ...(options.tools?.length ? { tools: [{ functionDeclarations: options.tools }] } : {}),
      ...(options.toolMode && options.tools?.length
        ? { toolConfig: { functionCallingConfig: { mode: options.toolMode } } }
        : {}),
      generationConfig: this.createGenerationConfig(options.model ?? settings.model, settings)
    };
  }

  private createGenerationConfig(
    modelInput: string,
    settings: VaultPilotSettings,
    outputLimit = settings.maxOutputTokens,
    temperature = settings.temperature
  ): Record<string, unknown> {
    const model = modelInput.replace(/^models\//, "").trim();
    const isGemini3 = /^gemini-3(?:[.\-]|$)/i.test(model);
    const configuredCap = Math.max(256, this.clientOptions.maxOutputTokens ?? outputLimit);
    const maxOutputTokens = Math.min(outputLimit, configuredCap);
    return {
      maxOutputTokens,
      // Gemini 3.x is optimized for its default sampling parameters. Keeping a
      // user temperature remains useful for earlier model families.
      ...(!isGemini3 ? { temperature } : {}),
      ...(isGemini3 && this.clientOptions.thinkingLevel
        ? { thinkingConfig: { thinkingLevel: this.clientOptions.thinkingLevel } }
        : {})
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
    return this.withRequestSlot(signal, () => this.requestWithRetries(modelInput, method, body, signal));
  }

  private async requestWithRetries(modelInput: string, method: string, body: unknown, signal: AbortSignal | undefined): Promise<Response> {
    const settings = this.requireSettings();
    const model = modelInput.replace(/^models\//, "").trim();
    if (!model || /[?#]/.test(model)) throw new Error("The configured Gemini model name is invalid.");
    const url = `${GEMINI_API_ROOT}/models/${encodeURIComponent(model)}:${method}`;
    const maxRetries = Math.max(0, Math.min(4, Math.round(this.clientOptions.maxRetries ?? 0)));
    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": settings.apiKey.trim()
      },
      body: JSON.stringify(body),
      signal
    };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      assertNotAborted(signal);
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.transport(url, requestInit);
      } catch (error) {
        if (signal?.aborted) {
          this.diagnose("info", "request_aborted", { method, model, attempt: attempt + 1, durationMs: Date.now() - startedAt });
          throw new DOMException("The request was stopped.", "AbortError");
        }
        if (attempt < maxRetries) {
          this.diagnose("warning", "transport_retry", {
            method,
            model,
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            durationMs: Date.now() - startedAt,
            errorKind: diagnosticErrorKind(error)
          });
          await this.waitBeforeRetry(attempt, undefined, signal);
          continue;
        }
        this.diagnose("error", "transport_failed", {
          method,
          model,
          attempts: attempt + 1,
          durationMs: Date.now() - startedAt,
          errorKind: diagnosticErrorKind(error)
        });
        throw new Error(`Could not reach the Gemini API after ${attempt + 1} ${attempt === 0 ? "attempt" : "attempts"}: ${errorMessage(error)}`);
      }
      if (response.ok) {
        if (/generateContent|countTokens/i.test(method)) {
          this.diagnose("info", "request_succeeded", {
            method,
            model,
            attempt: attempt + 1,
            status: response.status,
            durationMs: Date.now() - startedAt
          });
        }
        return response;
      }
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        this.diagnose("warning", "api_retry", {
          method,
          model,
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          status: response.status,
          durationMs: Date.now() - startedAt
        });
        await this.waitBeforeRetry(attempt, response.headers.get("Retry-After") ?? undefined, signal);
        continue;
      }
      const message = await readApiError(response);
      this.diagnose("error", "api_failed", {
        method,
        model,
        attempts: attempt + 1,
        status: response.status,
        durationMs: Date.now() - startedAt,
        errorKind: diagnosticErrorKind(new Error(`Gemini API error (${response.status})`))
      });
      throw new Error(`Gemini API error (${response.status}): ${message}`);
    }
    throw new Error("Could not reach the Gemini API after retrying.");
  }

  private async waitBeforeRetry(attempt: number, retryAfter: string | undefined, signal: AbortSignal | undefined): Promise<void> {
    const base = Math.max(0, this.clientOptions.retryBaseDelayMs ?? 750);
    const serverDelay = parseRetryAfter(retryAfter);
    const exponential = Math.min(8_000, base * (2 ** attempt));
    const jitter = base > 0 ? Math.floor(Math.random() * Math.min(250, base)) : 0;
    await abortableDelay(Math.max(serverDelay, exponential + jitter), signal);
  }

  private async withRequestSlot<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (!this.clientOptions.serializeRequests) return operation();

    const predecessor = this.requestQueueTail;
    let released = false;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    this.requestQueueTail = predecessor.then(() => slot);
    let acquired = false;
    try {
      await waitForQueue(predecessor, signal);
      acquired = true;
      assertNotAborted(signal);
      return await operation();
    } finally {
      if (acquired) release();
      else void predecessor.then(release);
    }
  }

  private reportGeneration(modelInput: string, operation: string, data: GeminiChunk): void {
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const textChars = parts.filter((part) => !part.thought).reduce((total, part) => total + (part.text?.length ?? 0), 0);
    const functionCalls = parts.filter((part) => Boolean(part.functionCall)).length;
    this.diagnose(textChars > 0 || functionCalls > 0 ? "info" : "warning", "generation_response", {
      operation,
      model: modelInput.replace(/^models\//, ""),
      finishReason: candidate?.finishReason ?? "unspecified",
      promptBlockReason: data.promptFeedback?.blockReason ?? "",
      responseId: data.responseId ?? "",
      modelVersion: data.modelVersion ?? "",
      parts: parts.length,
      textChars,
      thoughtParts: parts.filter((part) => part.thought).length,
      functionCalls,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0
    });
  }

  private diagnose(level: "info" | "warning" | "error", event: string, details: Record<string, string | number | boolean | null>): void {
    this.clientOptions.diagnostics?.({ level, area: "gemini", event, details });
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

function emptyResponseError(data: GeminiChunk): Error {
  const candidate = data.candidates?.[0];
  const reason = candidate?.finishReason?.trim();
  const detail = candidate?.finishMessage?.trim();
  const blocked = data.promptFeedback?.blockReason?.trim();
  if (blocked) return new Error(`Gemini blocked the request before generating a response (${blocked}). Try rephrasing it.`);
  if (reason === "MAX_TOKENS") {
    return new Error("Gemini reached its output limit before producing displayable text. Retry once or reduce the request context.");
  }
  if (reason === "UNEXPECTED_TOOL_CALL" || reason === "MALFORMED_FUNCTION_CALL" || reason === "MISSING_THOUGHT_SIGNATURE") {
    return new Error(`Gemini could not complete the tool exchange (${reason}). VaultPilot will retry the next request with a fresh turn.`);
  }
  const suffix = [reason, detail].filter(Boolean).join(": ");
  return new Error(`Gemini completed the request without displayable text${suffix ? ` (${suffix})` : ""}.`);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string | undefined): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(30_000, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(30_000, date - Date.now())) : 0;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The request was stopped.", "AbortError");
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (milliseconds <= 0) {
    assertNotAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const handle = globalThis.setTimeout(() => finish(resolve), milliseconds);
    const onAbort = (): void => finish(() => reject(new DOMException("The request was stopped.", "AbortError")));
    const finish = (action: () => void): void => {
      globalThis.clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForQueue(queue: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return queue;
  assertNotAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => finish(() => reject(new DOMException("The request was stopped.", "AbortError")));
    const finish = (action: () => void): void => {
      signal.removeEventListener("abort", onAbort);
      action();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void queue.then(() => finish(resolve));
  });
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
