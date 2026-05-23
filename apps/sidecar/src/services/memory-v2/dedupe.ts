const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "for",
  "in",
  "is",
  "of",
  "on",
  "the",
  "to",
  "with"
]);

export function memoryTextFingerprint(value: string): string {
  return memoryTextTokens(value).join(" ");
}

export function areMemoryStatementsSimilar(left: string, right: string): boolean {
  const leftFingerprint = memoryTextFingerprint(left);
  const rightFingerprint = memoryTextFingerprint(right);
  if (!leftFingerprint || !rightFingerprint) return false;
  if (leftFingerprint === rightFingerprint) return true;
  return memoryStatementSimilarity(left, right) >= 0.82;
}

export function memoryStatementSimilarity(left: string, right: string): number {
  const leftTokens = new Set(memoryTextTokens(left));
  const rightTokens = new Set(memoryTextTokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

export function memoryTextTokens(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) return [];

  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token));

  const cjkChars = Array.from(normalized).filter((char) => /\p{Script=Han}/u.test(char));
  for (let index = 0; index < cjkChars.length - 1; index += 1) {
    tokens.push(`${cjkChars[index]}${cjkChars[index + 1]}`);
  }

  return [...new Set(tokens)].sort();
}
