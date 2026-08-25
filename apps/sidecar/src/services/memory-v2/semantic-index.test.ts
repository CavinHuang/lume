import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { searchSemanticRecall } from "./semantic-index";
import type { MemoryV2EmbedTexts } from "./embedding";
import type { MemoryV2RecallItem } from "./types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-semantic-index-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

function makeCandidate(id: string, statement: string, path: string): MemoryV2RecallItem {
  return {
    id,
    kind: "fact",
    semanticRole: "fact",
    scope: "global",
    status: "active",
    statement,
    path,
    citation: "",
    reason: "test candidate",
    score: 0
  };
}

function touchFile(name: string): string {
  const path = join(root, name);
  writeFileSync(path, "");
  return path;
}

test("query 与某 candidate 向量相同 → score=1 排首位，正交 candidate 被滤", async () => {
  const candidates = [
    makeCandidate("a", "architecture", touchFile("a.md")),
    makeCandidate("b", "preferences", touchFile("b.md"))
  ];
  const embedTexts: MemoryV2EmbedTexts = async (texts) =>
    texts.map((t) => (t === "preferences" ? [0, 1, 0] : [1, 0, 0]));
  const results = await searchSemanticRecall({
    query: "architecture",
    candidates,
    embedTexts,
    modelKey: "test-model",
    maxResults: 5
  });
  expect(results.map((item) => item.id)).toEqual(["a"]);
});

test("score <= 0.25 的 candidate 被滤除", async () => {
  const candidates = [makeCandidate("c", "unrelated", touchFile("c.md"))];
  // query 向量 [1,0,0]，candidate 向量 [0,1,0] → dot=0 <= 0.25
  const embedTexts: MemoryV2EmbedTexts = async (texts) =>
    texts.map((t) => (t === "unrelated" ? [0, 1, 0] : [1, 0, 0]));
  const results = await searchSemanticRecall({
    query: "q",
    candidates,
    embedTexts,
    modelKey: "test-model",
    maxResults: 5
  });
  expect(results).toEqual([]);
});

test("相同 candidates 命中缓存 → 建索引不再 embedTexts（第二次仅 embed query）", async () => {
  const candidates = [makeCandidate("a", "architecture", touchFile("a.md"))];
  let embeddedCount = 0;
  const embedTexts: MemoryV2EmbedTexts = async (texts) => {
    embeddedCount += texts.length;
    return texts.map(() => [1, 0, 0]);
  };
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m", maxResults: 5 });
  const firstTotal = embeddedCount;
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m", maxResults: 5 });
  // 第二次：索引缓存命中，仅 embed query（1 条）。
  expect(embeddedCount - firstTotal).toBe(1);
});

test("modelKey 变化 → 索引重建（重新 embed candidates）", async () => {
  const candidates = [makeCandidate("a", "architecture", touchFile("a.md"))];
  let embeddedCount = 0;
  const embedTexts: MemoryV2EmbedTexts = async (texts) => {
    embeddedCount += texts.length;
    return texts.map(() => [1, 0, 0]);
  };
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m1", maxResults: 5 });
  const firstTotal = embeddedCount;
  await searchSemanticRecall({ query: "q", candidates, embedTexts, modelKey: "m2", maxResults: 5 });
  // modelKey 变 → 重建（embed 1 candidate）+ embed query（1 条）= 2。
  expect(embeddedCount - firstTotal).toBe(2);
});

test("空 candidates → 返回 []（不 embed query）", async () => {
  let embedded = false;
  const embedTexts: MemoryV2EmbedTexts = async () => {
    embedded = true;
    return [[1, 0, 0]];
  };
  const results = await searchSemanticRecall({
    query: "q",
    candidates: [],
    embedTexts,
    modelKey: "m",
    maxResults: 5
  });
  expect(results).toEqual([]);
  expect(embedded).toBe(false);
});
