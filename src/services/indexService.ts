import { App, Platform, TFile } from "obsidian";
import { isForbiddenVaultPath } from "../security/pathGuard";
import { VectorStore } from "../storage/vectorStore";
import type { IndexProgress, IndexedFileMeta, VaultPilotSettings, VectorRecord } from "../types";
import { chunkMarkdown, fnv1a } from "../utils/text";
import { GeminiClient } from "./geminiClient";

export class IndexService {
  private activeRun: Promise<void> | null = null;
  private pendingPaths = new Set<string>();
  private debounceHandle: number | null = null;

  constructor(
    private readonly app: App,
    private readonly store: VectorStore,
    private readonly gemini: GeminiClient,
    private readonly getSettings: () => VaultPilotSettings
  ) {}

  async initialize(): Promise<void> {
    await this.store.open();
  }

  async indexChangedFiles(onProgress?: (progress: IndexProgress) => void, signal?: AbortSignal): Promise<void> {
    if (Platform.isMobile && !this.getSettings().mobileIndexingEnabled) {
      onProgress?.({ completed: 0, total: 0 });
      return;
    }
    return this.runExclusive(async () => {
      const files = this.app.vault.getMarkdownFiles().filter((file) => !isForbiddenVaultPath(file.path));
      const known = new Map((await this.store.getAllFileMeta()).map((meta) => [meta.path, meta]));
      const changed = files.filter((file) => {
        const meta = known.get(file.path);
        return !meta || meta.mtime !== file.stat.mtime || meta.size !== file.stat.size;
      });
      const existing = new Set(files.map((file) => file.path));
      const removed = [...known.keys()].filter((path) => !existing.has(path));
      const total = changed.length + removed.length;
      let completed = 0;

      for (const path of removed) {
        assertNotAborted(signal);
        await this.store.deleteFile(path);
        completed += 1;
        onProgress?.({ completed, total, currentPath: path });
      }
      for (const file of changed) {
        assertNotAborted(signal);
        onProgress?.({ completed, total, currentPath: file.path });
        try {
          await this.indexFileNow(file, signal);
        } catch (error) {
          onProgress?.({ completed, total, currentPath: file.path, error: errorMessage(error) });
          throw error;
        }
        completed += 1;
        onProgress?.({ completed, total, currentPath: file.path });
      }
      if (total === 0) onProgress?.({ completed: 0, total: 0 });
    });
  }

  scheduleFile(fileOrPath: TFile | string): void {
    if (!this.getSettings().indexOnFileChange) return;
    const path = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
    if (isForbiddenVaultPath(path)) return;
    this.pendingPaths.add(path);
    if (this.debounceHandle !== null) window.clearTimeout(this.debounceHandle);
    this.debounceHandle = window.setTimeout(() => {
      this.debounceHandle = null;
      void this.flushPending();
    }, 1800);
  }

  async rebuild(onProgress?: (progress: IndexProgress) => void, signal?: AbortSignal): Promise<void> {
    await this.runExclusive(async () => this.store.clear());
    await this.indexChangedFiles(onProgress, signal);
  }

  dispose(): void {
    if (this.debounceHandle !== null) window.clearTimeout(this.debounceHandle);
    this.store.close();
  }

  private async flushPending(): Promise<void> {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    await this.runExclusive(async () => {
      for (const path of paths) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile && file.extension.toLocaleLowerCase() === "md") await this.indexFileNow(file);
        else await this.store.deleteFile(path);
      }
    }).catch((error) => console.error("VaultPilot OS background indexing failed", error));
  }

  private async indexFileNow(file: TFile, signal?: AbortSignal): Promise<void> {
    if (isForbiddenVaultPath(file.path)) return;
    const settings = this.getSettings();
    const content = await this.app.vault.cachedRead(file);
    const contentHash = fnv1a(content);
    const chunks = chunkMarkdown(content, settings.chunkSize, settings.chunkOverlap, settings.maxChunksPerFile);
    const records: VectorRecord[] = [];
    const batchSize = Math.max(1, Math.min(100, settings.embeddingBatchSize));
    for (let start = 0; start < chunks.length; start += batchSize) {
      assertNotAborted(signal);
      const slice = chunks.slice(start, start + batchSize);
      let embeddings: number[][];
      try {
        embeddings = await this.gemini.embedBatch(slice.map((text) => `${file.basename}\n\n${text}`), signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn("VaultPilot batch embedding failed; retrying the batch one item at a time", error);
        embeddings = [];
        for (const text of slice) embeddings.push(await this.gemini.embed(`${file.basename}\n\n${text}`, signal));
      }
      for (let offset = 0; offset < slice.length; offset += 1) {
        const text = slice[offset];
        const embedding = embeddings[offset];
        if (!text || !embedding) continue;
        const index = start + offset;
        records.push({
          id: `${fnv1a(file.path)}:${index}:${contentHash}`,
          path: file.path,
          chunkIndex: index,
          text,
          embedding: new Float32Array(embedding),
          mtime: file.stat.mtime,
          contentHash
        });
      }
      await yieldToUi();
    }
    const meta: IndexedFileMeta = {
      path: file.path,
      mtime: file.stat.mtime,
      size: file.stat.size,
      contentHash,
      chunkCount: records.length
    };
    await this.store.replaceFile(meta, records);
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    while (this.activeRun) await this.activeRun;
    const run = operation();
    this.activeRun = run;
    try {
      await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Indexing was stopped.", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
