import { App, TFile } from "obsidian";
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

export class SearchService {
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
    const lexicalResults = await this.lexicalVaultFallback(trimmedQuery, Math.max(limit, 12));
    const records = await this.store.getAllChunks();
    if (records.length === 0) return lexicalResults.slice(0, limit);

    let queryEmbedding: number[] = [];
    try {
      queryEmbedding = await this.gemini.embed(trimmedQuery, signal);
    } catch (error) {
      console.warn("VaultPilot OS semantic query embedding failed; using lexical retrieval", error);
    }

    const scored: ScoredRecord[] = records.map((record) => ({
      record,
      semanticScore: queryEmbedding.length ? Math.max(0, cosineSimilarity(queryEmbedding, record.embedding)) : 0,
      lexicalScore: lexicalScore(trimmedQuery, `${record.path} ${record.text}`),
      graphScore: 0
    }));
    normalizeField(scored, "semanticScore");

    const strongestSemanticPaths = uniquePaths(
      [...scored].sort((left, right) => right.semanticScore - left.semanticScore).slice(0, 12)
    );
    const graphBoosts = this.graphBoosts(strongestSemanticPaths);
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
        chunkIndex: item.record.chunkIndex
      };
      if (score > (bestByPath.get(result.path)?.score ?? -1)) bestByPath.set(result.path, result);
    }

    // IndexedDB can be incomplete while a background index is still building or
    // after an embedding request fails. Merge a vault-wide lexical pass so exact
    // titles and newly created notes remain searchable at all times.
    for (const lexical of lexicalResults) {
      const existing = bestByPath.get(lexical.path);
      if (!existing) {
        bestByPath.set(lexical.path, lexical);
        continue;
      }
      existing.lexicalScore = Math.max(existing.lexicalScore, lexical.lexicalScore);
      if (lexical.score > existing.score) {
        existing.score = lexical.score;
        existing.snippet = lexical.snippet;
      }
    }

    return [...bestByPath.values()].sort((left, right) => right.score - left.score).slice(0, limit);
  }

  private graphBoosts(seedPaths: Map<string, number>): Map<string, number> {
    const boosts = new Map<string, number>();
    for (const [path, relevance] of seedPaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      for (const link of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
        const destination = this.app.metadataCache.getFirstLinkpathDest(link.link, path);
        if (destination && !isForbiddenVaultPath(destination.path)) {
          boosts.set(destination.path, (boosts.get(destination.path) ?? 0) + relevance);
        }
      }
    }

    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    for (const [source, destinations] of Object.entries(resolvedLinks)) {
      if (isForbiddenVaultPath(source)) continue;
      for (const [seedPath, relevance] of seedPaths) {
        const linkCount = destinations[seedPath] ?? 0;
        if (linkCount > 0) boosts.set(source, (boosts.get(source) ?? 0) + relevance * Math.min(2, linkCount));
      }
    }
    return boosts;
  }

  private async lexicalVaultFallback(query: string, limit: number): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const unquotedQuery = query.replace(/^[\s\"'\u201c\u201d]+|[\s\"'\u201c\u201d]+$/g, "").trim();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isForbiddenVaultPath(file.path)) continue;
      const content = await this.app.vault.cachedRead(file);
      const exactTitle = file.basename.toLocaleLowerCase() === unquotedQuery.toLocaleLowerCase();
      const pathScore = lexicalScore(unquotedQuery, file.path);
      const contentScore = lexicalScore(unquotedQuery, content);
      const score = exactTitle ? 1 : Math.max(pathScore, contentScore * 0.85);
      if (score <= 0) continue;
      results.push({
        path: file.path,
        score,
        semanticScore: 0,
        lexicalScore: score,
        graphScore: 0,
        snippet: excerpt(content, query),
        chunkIndex: 0
      });
    }
    return results.sort((left, right) => right.score - left.score).slice(0, Math.max(1, Math.min(30, limit)));
  }
}

function normalizeField(items: ScoredRecord[], field: "semanticScore"): void {
  const maximum = Math.max(0, ...items.map((item) => item[field]));
  if (!maximum) return;
  for (const item of items) item[field] /= maximum;
}

function uniquePaths(items: ScoredRecord[]): Map<string, number> {
  const paths = new Map<string, number>();
  for (const item of items) {
    if (!paths.has(item.record.path)) paths.set(item.record.path, item.semanticScore);
  }
  return paths;
}

function normalizedWeights(semantic: number, lexical: number, graph: number): { semantic: number; lexical: number; graph: number } {
  const safe = [semantic, lexical, graph].map((value) => Math.max(0, Number(value) || 0));
  const total = safe.reduce((sum, value) => sum + value, 0) || 1;
  return { semantic: (safe[0] ?? 0) / total, lexical: (safe[1] ?? 0) / total, graph: (safe[2] ?? 0) / total };
}
