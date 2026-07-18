import { App } from "obsidian";
import { isForbiddenVaultPath } from "../security/pathGuard";
import { VectorStore } from "../storage/vectorStore";
import type { SearchResult, VaultPilotSettings, VectorRecord } from "../types";
import { cosineSimilarity, excerpt, lexicalScore } from "../utils/text";
import { GeminiClient } from "./geminiClient";

interface ScoredRecord {
  record: VectorRecord;
  semanticScore: number;
  lexicalScore: number;
  graphScore: number;
}

interface CachedSearch {
  revision: number;
  results: SearchResult[];
}

export class SearchService {
  private readonly cache = new Map<string, CachedSearch>();
  private graphCache: { createdAt: number; adjacency: Map<string, Map<string, number>> } | null = null;

  constructor(
    private readonly app: App,
    private readonly store: VectorStore,
    private readonly gemini: GeminiClient,
    private readonly getSettings: () => VaultPilotSettings
  ) {}

  async search(query: string, requestedLimit?: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    const settings = this.getSettings();
    const limit = Math.max(1, Math.min(30, requestedLimit ?? settings.searchResultLimit));
    const cacheKey = `${trimmedQuery.toLocaleLowerCase()}|${limit}|${settings.semanticWeight}|${settings.lexicalWeight}|${settings.graphWeight}`;
    const revision = this.store.revision();
    const cached = this.cache.get(cacheKey);
    if (cached?.revision === revision) return cloneResults(cached.results);

    const records = await this.store.getAllChunks();
    const lexicalResults = this.lexicalFromIndex(trimmedQuery, records, Math.max(limit, 12));
    if (records.length === 0) return lexicalResults.slice(0, limit);

    let queryEmbedding: number[] = [];
    try {
      queryEmbedding = await this.gemini.embed(trimmedQuery, signal);
    } catch (error) {
      console.warn("VaultPilot OS semantic query embedding failed; using indexed lexical retrieval", error);
    }

    const scored: ScoredRecord[] = [];
    for (let index = 0; index < records.length; index += 1) {
      assertNotAborted(signal);
      const record = records[index];
      if (!record) continue;
      scored.push({
        record,
        semanticScore: queryEmbedding.length ? Math.max(0, cosineSimilarity(queryEmbedding, record.embedding)) : 0,
        lexicalScore: lexicalScore(trimmedQuery, `${record.path} ${record.text}`),
        graphScore: 0
      });
      if (index > 0 && index % 400 === 0) await yieldToUi();
    }
    normalizeSemantic(scored);

    const strongestPaths = uniquePaths([...scored].sort((left, right) => right.semanticScore - left.semanticScore).slice(0, 16));
    const graphBoosts = this.graphBoosts(strongestPaths);
    const maximumGraph = Math.max(0, ...graphBoosts.values());
    for (const item of scored) item.graphScore = maximumGraph ? (graphBoosts.get(item.record.path) ?? 0) / maximumGraph : 0;

    const weights = normalizedWeights(settings.semanticWeight, settings.lexicalWeight, settings.graphWeight);
    const bestByPath = new Map<string, SearchResult>();
    for (const item of scored) {
      const score = item.semanticScore * weights.semantic + item.lexicalScore * weights.lexical + item.graphScore * weights.graph;
      const result: SearchResult = {
        path: item.record.path,
        score,
        semanticScore: item.semanticScore,
        lexicalScore: item.lexicalScore,
        graphScore: item.graphScore,
        snippet: excerpt(item.record.text, trimmedQuery),
        chunkIndex: item.record.chunkIndex,
        reasons: relevanceReasons(item.semanticScore, item.lexicalScore, item.graphScore)
      };
      if (score > (bestByPath.get(result.path)?.score ?? -1)) bestByPath.set(result.path, result);
    }

    for (const lexical of lexicalResults) {
      const existing = bestByPath.get(lexical.path);
      if (!existing) bestByPath.set(lexical.path, lexical);
      else if (lexical.lexicalScore > existing.lexicalScore) {
        existing.lexicalScore = lexical.lexicalScore;
        existing.score = existing.semanticScore * weights.semantic + existing.lexicalScore * weights.lexical + existing.graphScore * weights.graph;
        existing.reasons = relevanceReasons(existing.semanticScore, existing.lexicalScore, existing.graphScore);
      }
    }

    const results = [...bestByPath.values()].sort((left, right) => right.score - left.score).slice(0, limit);
    this.remember(cacheKey, { revision, results: cloneResults(results) }, settings.searchCacheSize);
    return results;
  }

  invalidateGraph(): void {
    this.graphCache = null;
    this.cache.clear();
  }

  private graphBoosts(seedPaths: Map<string, number>): Map<string, number> {
    const adjacency = this.graphAdjacency();
    const boosts = new Map<string, number>();
    for (const [seed, relevance] of seedPaths) {
      for (const [neighbor, count] of adjacency.get(seed) ?? []) {
        boosts.set(neighbor, (boosts.get(neighbor) ?? 0) + relevance * Math.min(2, count));
      }
    }
    return boosts;
  }

  private graphAdjacency(): Map<string, Map<string, number>> {
    if (this.graphCache && Date.now() - this.graphCache.createdAt < 60_000) return this.graphCache.adjacency;
    const adjacency = new Map<string, Map<string, number>>();
    const add = (from: string, to: string, count: number): void => {
      if (isForbiddenVaultPath(from) || isForbiddenVaultPath(to)) return;
      const neighbors = adjacency.get(from) ?? new Map<string, number>();
      neighbors.set(to, (neighbors.get(to) ?? 0) + count);
      adjacency.set(from, neighbors);
    };
    for (const [source, destinations] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      for (const [destination, count] of Object.entries(destinations)) {
        add(source, destination, count);
        add(destination, source, count);
      }
    }
    this.graphCache = { createdAt: Date.now(), adjacency };
    return adjacency;
  }

  private lexicalFromIndex(query: string, records: VectorRecord[], limit: number): SearchResult[] {
    const best = new Map<string, SearchResult>();
    const unquoted = query.replace(/^[\s\"'\u201c\u201d]+|[\s\"'\u201c\u201d]+$/g, "").trim();
    for (const record of records) {
      const score = lexicalScore(unquoted, `${record.path} ${record.text}`);
      if (score <= 0) continue;
      const result: SearchResult = {
        path: record.path,
        score,
        semanticScore: 0,
        lexicalScore: score,
        graphScore: 0,
        snippet: excerpt(record.text, query),
        chunkIndex: record.chunkIndex,
        reasons: ["keyword match"]
      };
      if (score > (best.get(record.path)?.score ?? -1)) best.set(record.path, result);
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isForbiddenVaultPath(file.path) || file.basename.toLocaleLowerCase() !== unquoted.toLocaleLowerCase()) continue;
      const existing = best.get(file.path);
      best.set(file.path, {
        path: file.path,
        score: 1,
        semanticScore: existing?.semanticScore ?? 0,
        lexicalScore: 1,
        graphScore: existing?.graphScore ?? 0,
        snippet: existing?.snippet ?? `Exact title match: ${file.basename}`,
        chunkIndex: existing?.chunkIndex ?? 0,
        reasons: ["exact title match"]
      });
    }
    return [...best.values()].sort((left, right) => right.score - left.score).slice(0, Math.max(1, Math.min(30, limit)));
  }

  private remember(key: string, value: CachedSearch, maximum: number): void {
    if (maximum <= 0) return;
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > maximum) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}

function relevanceReasons(semantic: number, lexical: number, graph: number): string[] {
  const reasons: string[] = [];
  if (semantic >= 0.25) reasons.push("semantic match");
  if (lexical > 0) reasons.push("keyword match");
  if (graph > 0) reasons.push("linked-note boost");
  return reasons.length ? reasons : ["related indexed note"];
}

function normalizeSemantic(items: ScoredRecord[]): void {
  const maximum = Math.max(0, ...items.map((item) => item.semanticScore));
  if (!maximum) return;
  for (const item of items) item.semanticScore /= maximum;
}

function uniquePaths(items: ScoredRecord[]): Map<string, number> {
  const paths = new Map<string, number>();
  for (const item of items) if (!paths.has(item.record.path)) paths.set(item.record.path, item.semanticScore);
  return paths;
}

function normalizedWeights(semantic: number, lexical: number, graph: number): { semantic: number; lexical: number; graph: number } {
  const safe = [semantic, lexical, graph].map((value) => Math.max(0, Number(value) || 0));
  const total = safe.reduce((sum, value) => sum + value, 0) || 1;
  return { semantic: (safe[0] ?? 0) / total, lexical: (safe[1] ?? 0) / total, graph: (safe[2] ?? 0) / total };
}

function cloneResults(results: SearchResult[]): SearchResult[] {
  return results.map((result) => ({ ...result, reasons: result.reasons ? [...result.reasons] : undefined }));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Search was stopped.", "AbortError");
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
