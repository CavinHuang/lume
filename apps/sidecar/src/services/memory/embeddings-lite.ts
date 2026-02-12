import { createHash } from "node:crypto";

const DEFAULT_DIMS = 1536;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const lower = input.toLowerCase();

  const ascii = lower.match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...ascii);

  // 提供 CJK 粒度 token，补齐 FTS 英文 token 的盲区
  for (const char of lower) {
    if (/\p{Script=Han}/u.test(char)) {
      tokens.push(char);
    }
  }

  return tokens;
}

function stableHashToInt(token: string, salt: string): number {
  const digest = createHash("sha256").update(`${salt}:${token}`).digest();
  return digest.readUInt32BE(0);
}

export function createLiteEmbedding(text: string, dims = DEFAULT_DIMS): number[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return Array.from({ length: dims }, () => 0);

  const vec = Array.from({ length: dims }, () => 0);

  for (const token of tokens) {
    const idx = stableHashToInt(token, "idx") % dims;
    const sign = stableHashToInt(token, "sign") % 2 === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }

  // L2 normalize
  const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
