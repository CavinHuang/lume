import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearSuggestions,
  deleteSuggestion,
  getEnabled,
  getTypeWeights,
  listSuggestions,
  persistSuggestion,
  resetSuggestionStoreForTest,
  setEnabled,
  suggestionStats,
} from "./store";
import type { SuggestionCandidate } from "@lume/shared";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-suggest-"));
  process.env.LUME_CONFIG_DIR = root;
  resetSuggestionStoreForTest();
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

const candidate = (overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate => ({
  duplicateKey: "correction:test",
  kind: "correction",
  title: "t",
  reason: "r",
  evidence: "e",
  rawConfidence: 0.9,
  action: { type: "memory_correction", raw: "以后不要用 var", rule: "不要用 var" },
  ...overrides,
});

describe("suggestion store", () => {
  test("persistSuggestion 写入并分配自增 id + status suggested", () => {
    const rec = persistSuggestion(candidate(), { threadId: "t1", workspaceSlug: "ws" });
    expect(rec.id).toBeGreaterThan(0);
    expect(rec.status).toBe("suggested");
    expect(listSuggestions()[0]?.threadId).toBe("t1");
  });

  test("listSuggestions(status) 按状态过滤", () => {
    persistSuggestion(candidate({ duplicateKey: "k1" }));
    // 默认 status=suggested；accepted/ignored/never 由 feedback 模块改写，这里只测过滤
    expect(listSuggestions("suggested")).toHaveLength(1);
    expect(listSuggestions("accepted")).toHaveLength(0);
  });

  test("enabled 默认 true，setEnabled 持久化", () => {
    expect(getEnabled()).toBe(true);
    setEnabled(false);
    expect(getEnabled()).toBe(false);
    // 重置缓存后仍应从磁盘读回 false
    resetSuggestionStoreForTest();
    expect(getEnabled()).toBe(false);
  });

  test("id 单调自增 + 新记录 unshift 到首位", () => {
    const a = persistSuggestion(candidate({ duplicateKey: "k1" }));
    const b = persistSuggestion(candidate({ duplicateKey: "k2" }));
    expect(b.id).toBeGreaterThan(a.id);
    const list = listSuggestions();
    expect(list[0]?.id).toBe(b.id);
    expect(list[1]?.id).toBe(a.id);
  });

  test("持久化落盘：resetSuggestionStoreForTest 后从磁盘读回", () => {
    persistSuggestion(candidate({ duplicateKey: "k1" }), { threadId: "t1" });
    resetSuggestionStoreForTest();
    const list = listSuggestions();
    expect(list).toHaveLength(1);
    expect(list[0]?.threadId).toBe("t1");
  });

  test("deleteSuggestion 按 id 移除", () => {
    const a = persistSuggestion(candidate({ duplicateKey: "k1" }));
    persistSuggestion(candidate({ duplicateKey: "k2" }));
    deleteSuggestion(a.id);
    const list = listSuggestions();
    expect(list).toHaveLength(1);
    expect(list.find((r) => r.id === a.id)).toBeUndefined();
  });

  test("clearSuggestions 清空记录但保留 typeWeights + enabled", () => {
    setEnabled(false);
    persistSuggestion(candidate({ duplicateKey: "k1" }));
    clearSuggestions();
    expect(listSuggestions()).toHaveLength(0);
    expect(getEnabled()).toBe(false);
    expect(getTypeWeights().correction).toBe(1.0);
  });

  test("getTypeWeights 返回默认权重", () => {
    const w = getTypeWeights();
    expect(w.correction).toBe(1.0);
    expect(w.skill).toBe(0.8);
    expect(w.todo).toBe(0.9);
  });

  test("suggestionStats 统计 suggested 数量", () => {
    persistSuggestion(candidate({ duplicateKey: "k1" }));
    persistSuggestion(candidate({ duplicateKey: "k2" }));
    const stats = suggestionStats();
    expect(stats.suggestedCount).toBe(2);
    expect(stats.todayAccepted).toBe(0);
    expect(stats.typeWeights.correction).toBe(1.0);
  });

  test("字段长度截断：title>200 / reason>500 / evidence>500 / duplicateKey>200", () => {
    const longTitle = "x".repeat(300);
    const longReason = "y".repeat(600);
    const longEvidence = "z".repeat(600);
    const longKey = "k".repeat(300);
    const rec = persistSuggestion(
      candidate({
        duplicateKey: longKey,
        title: longTitle,
        reason: longReason,
        evidence: longEvidence,
      }),
    );
    expect(rec.title).toHaveLength(200);
    expect(rec.reason).toHaveLength(500);
    expect(rec.evidence).toHaveLength(500);
    expect(rec.duplicateKey).toHaveLength(200);
    // 落盘后读回同样被截断
    resetSuggestionStoreForTest();
    const list = listSuggestions();
    expect(list[0]?.title).toHaveLength(200);
  });

  test("损坏的 suggestions.json 自动备份 + 重建空索引（不抛错）", () => {
    const indexPath = join(root, "suggestions", "suggestions.json");
    // 先写一条正常记录以保证文件存在
    persistSuggestion(candidate({ duplicateKey: "k1" }));
    expect(existsSync(indexPath)).toBe(true);
    // 用损坏内容覆盖
    writeFileSync(indexPath, "{ not valid json", "utf-8");
    resetSuggestionStoreForTest();
    // 读不应抛错
    const list = listSuggestions();
    expect(list).toHaveLength(0);
    // 原损坏文件应被备份（出现 .corrupt- 副本）
    const dir = join(root, "suggestions");
    const backups = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.includes(".corrupt-"))
      : [];
    expect(backups.length).toBe(1);
    // enabled 应回到默认 true
    expect(getEnabled()).toBe(true);
  });

  test("MAX_RECORDS=500：超出时裁剪最旧记录", () => {
    for (let i = 0; i < 502; i++) {
      persistSuggestion(candidate({ duplicateKey: `k${i}` }));
    }
    expect(listSuggestions()).toHaveLength(500);
  });
});
