export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function chunkMarkdown(content: string, size: number, overlap: number, maximum: number): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.length <= size) return [trimmed];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length && chunks.length < maximum) {
    let end = Math.min(trimmed.length, cursor + size);
    if (end < trimmed.length) {
      const window = trimmed.slice(cursor, end);
      const headingBreak = window.lastIndexOf("\n#");
      const paragraphBreak = window.lastIndexOf("\n\n");
      const lineBreak = window.lastIndexOf("\n");
      const preferred = Math.max(headingBreak, paragraphBreak, lineBreak);
      if (preferred >= Math.floor(size * 0.55)) end = cursor + preferred;
    }

    const chunk = trimmed.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= trimmed.length) break;
    const next = Math.max(cursor + 1, end - overlap);
    cursor = next;
  }
  return chunks;
}

export function tokenize(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token.length > 1);
}

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

export function lexicalScore(query: string, text: string): number {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return 0;
  const terms = tokenize(text);
  if (terms.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  let score = 0;
  for (const term of queryTerms) {
    const frequency = counts.get(term) ?? 0;
    if (frequency > 0) score += 1 + Math.log(frequency);
  }
  const phraseBonus = text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? 1.5 : 0;
  return Math.min(1, (score + phraseBonus) / Math.max(2, queryTerms.length * 1.75));
}

export function excerpt(text: string, query: string, length = 420): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= length) return normalized;
  const queryTerm = tokenize(query)[0];
  const match = queryTerm ? normalized.toLocaleLowerCase().indexOf(queryTerm) : -1;
  const start = Math.max(0, Math.min(normalized.length - length, match < 0 ? 0 : match - Math.floor(length / 3)));
  return `${start > 0 ? "…" : ""}${normalized.slice(start, start + length)}${start + length < normalized.length ? "…" : ""}`;
}

export function formatArchiveTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

export function sanitizeTopic(value: string): string {
  const words = value
    .replace(/[`*_#>\[\]{}()]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6);
  const topic = words.map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`).join("");
  return topic.slice(0, 80) || "Conversation";
}
