import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// #527-4：候选列表顺序变化不应触发重建（签名比对按 id 走 Map）
test("顺序打乱 → 不再重嵌入（仅 embed query）", async () => {
  const pa = touchFile("a.md");
  const pb = touchFile("b.md");
  const a = makeCandidate("a", "architecture", pa);
  const b = makeCandidate("b", "preferences", pb);
  let candidateEmbeddedCount = 0;
  const embedTexts: MemoryV2EmbedTexts = async (texts) => {
    // query 只有一句 "q"；>1 即发生了 candidates 重嵌
    if (texts.length > 1 || texts[0] !== "q") candidateEmbeddedCount += texts.length;
    return texts.map(() => [1, 0, 0]);
  };
  await searchSemanticRecall({ query: "q", candidates: [a, b], embedTexts, modelKey: "m", maxResults: 5 });
  await searchSemanticRecall({ query: "q", candidates: [b, a], embedTexts, modelKey: "m", maxResults: 5 });
  expect(candidateEmbeddedCount).toBe(2); // 仅首轮全部嵌入
});

// #527-4：touch 单个文件只应重嵌该条，其余向量复用
test("touch 一个文件 → 只重嵌入该条", async () => {
  const pa = join(root, "a.md");
  writeFileSync(pa, "");
  const b = makeCandidate("b", "preferences", join(root, "b.md"));
  writeFileSync(join(root, "b.md"), "");
  let reembeddedStatements: string[] = [];
  const embedTexts: MemoryV2EmbedTexts = async (texts) =>
    texts.map((t) => {
      if (t !== "q") reembeddedStatements.push(t);
      return [1, 0, 0];
    });
  await searchSemanticRecall({
    query: "q",
    candidates: [makeCandidate("a", "architecture", pa), b],
    embedTexts,
    modelKey: "m",
    maxResults: 5
  });
  reembeddedStatements = [];
  // 强制 mtime 变化；Windows 上连续写同 mtime 精度有限，显式 futimes 加大步进
  const future = new Date(Date.now() + 50);
  utimesSync(pa, future, future);
  await searchSemanticRecall({
    query: "q",
    candidates: [makeCandidate("a", "architecture", pa), b],
    embedTexts,
    modelKey: "m",
    maxResults: 5
  });
  expect(reembeddedStatements).toEqual(["architecture"]);
});
