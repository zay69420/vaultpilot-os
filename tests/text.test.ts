import { describe, expect, it } from "vitest";
import { chunkMarkdown, cosineSimilarity, formatArchiveTimestamp, lexicalScore, sanitizeTopic } from "../src/utils/text";

describe("text and retrieval utilities", () => {
  it("chunks long Markdown with a hard maximum", () => {
    const content = `# Start\n\n${"alpha beta gamma\n".repeat(300)}\n# Finish\n\nfinal facts`;
    const chunks = chunkMarkdown(content, 500, 50, 5);
    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toContain("# Start");
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("ranks lexical and vector matches", () => {
    expect(lexicalScore("project alpha", "Project Alpha project plan")).toBeGreaterThan(lexicalScore("project alpha", "unrelated cooking note"));
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("creates strict local archive names", () => {
    const localDate = new Date(2026, 6, 18, 15, 30, 12);
    expect(formatArchiveTimestamp(localDate)).toBe("2026-07-18_15-30");
    expect(`${sanitizeTopic("Obsidian plugin architecture!")}@${formatArchiveTimestamp(localDate)}.md`)
      .toBe("ObsidianPluginArchitecture@2026-07-18_15-30.md");
  });
});
