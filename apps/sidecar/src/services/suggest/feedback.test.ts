import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getTypeWeights,
  listSuggestions,
  persistSuggestion,
  resetSuggestionStoreForTest,
} from "./store";
import {
  SILENCE_AFTER_IGNORES,
  getNeverKeys,
  isTypeSilenced,
  recordFeedback,
} from "./feedback";
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

describe("suggestion feedback — 频率学习", () => {
  test("accepted ×1.2 单调上升直到上限 2.0", () => {
    // correction 默认 1.0
    const r1 = persistSuggestion(candidate({ duplicateKey: "k1" }));
    recordFeedback(r1.id, "accepted");
    expect(getTypeWeights().correction).toBeCloseTo(1.2, 6);

    const r2 = persistSuggestion(candidate({ duplicateKey: "k2" }));
    recordFeedback(r2.id, "accepted");
    expect(getTypeWeights().correction).toBeCloseTo(1.44, 6);

    // 连续 accept 直到封顶 2.0
    let sim = 1.44;
    for (let i = 3; i <= 10; i++) {
      const r = persistSuggestion(candidate({ duplicateKey: `k${i}` }));
      recordFeedback(r.id, "accepted");
      sim = Math.min(2.0, sim * 1.2);
    }
    expect(getTypeWeights().correction).toBe(2.0);
  });

  test("ignored ×0.8 单调下降直到下限 0.2", () => {
    // correction 默认 1.0；连续 ignored 收敛到 0.2
    let sim = 1.0;
    for (let i = 0; i < 10; i++) {
      const r = persistSuggestion(candidate({ duplicateKey: `ig-${i}` }));
      recordFeedback(r.id, "ignored");
      sim = Math.max(0.2, sim * 0.8);
    }
    expect(getTypeWeights().correction).toBeCloseTo(sim, 6);
    expect(getTypeWeights().correction).toBe(0.2);
  });

  test("never ×0.5（下限 0.2）+ duplicateKey 永久屏蔽 + status 落盘", () => {
    const r = persistSuggestion(
      candidate({
        duplicateKey: "never-1",
        kind: "automation",
        action: {
          type: "open_automation_create",
          automationTitle: "t",
          suggestedPrompt: "p",
        },
      }),
    );
    recordFeedback(r.id, "never");
    // 1.0 × 0.5 = 0.5，未触底
    expect(getTypeWeights().automation).toBeCloseTo(0.5, 6);
    // duplicateKey 进入 neverKeys
    expect(getNeverKeys().has("never-1")).toBe(true);
    // record status 持久化为 never
    const rec = listSuggestions().find((x) => x.id === r.id);
    expect(rec?.status).toBe("never");
    expect(typeof rec?.feedbackAt).toBe("number");
  });

  test("never 权重下限 0.2：连续 never 收敛到 0.2", () => {
    // automation 默认 1.0 → 0.5 → 0.25 → 0.125→触底 0.2
    const mkAuto = (key: string): SuggestionCandidate =>
      candidate({
        duplicateKey: key,
        kind: "automation",
        action: {
          type: "open_automation_create",
          automationTitle: "t",
          suggestedPrompt: "p",
        },
      });
    const r1 = persistSuggestion(mkAuto("n1"));
    recordFeedback(r1.id, "never");
    expect(getTypeWeights().automation).toBeCloseTo(0.5, 6);
    const r2 = persistSuggestion(mkAuto("n2"));
    recordFeedback(r2.id, "never");
    expect(getTypeWeights().automation).toBeCloseTo(0.25, 6);
    const r3 = persistSuggestion(mkAuto("n3"));
    recordFeedback(r3.id, "never");
    expect(getTypeWeights().automation).toBe(0.2);
  });

  test("权重学习是按 kind 独立调节（互不干扰）", () => {
    // accepted correction 不影响 todo 权重
    const r1 = persistSuggestion(candidate({ duplicateKey: "c1", kind: "correction" }));
    recordFeedback(r1.id, "accepted");
    expect(getTypeWeights().correction).toBeCloseTo(1.2, 6);
    expect(getTypeWeights().todo).toBe(0.9); // 默认未变
  });
});

describe("suggestion feedback — 类型静默", () => {
  test("连续忽略 SILENCE_AFTER_IGNORES 次同 kind → 静默；其他 kind 不受影响", () => {
    expect(SILENCE_AFTER_IGNORES).toBe(3);
    for (let i = 0; i < 3; i++) {
      const r = persistSuggestion(
        candidate({
          duplicateKey: `todo-${i}`,
          kind: "todo",
          rawConfidence: 0.72,
          action: { type: "open_memory_board" },
        }),
      );
      recordFeedback(r.id, "ignored");
    }
    expect(isTypeSilenced("todo")).toBe(true);
    expect(isTypeSilenced("correction")).toBe(false);
  });

  test("静默只看最近 3 条同 kind：中间夹一条 accepted → 不静默", () => {
    // 写入顺序（数组 newest-first）：[t3, t2(accepted), t1, t0]
    const mkTodo = (key: string): SuggestionCandidate =>
      candidate({
        duplicateKey: key,
        kind: "todo",
        rawConfidence: 0.72,
        action: { type: "open_memory_board" },
      });
    const r0 = persistSuggestion(mkTodo("t0"));
    recordFeedback(r0.id, "ignored");
    const r1 = persistSuggestion(mkTodo("t1"));
    recordFeedback(r1.id, "ignored");
    const r2 = persistSuggestion(mkTodo("t2"));
    recordFeedback(r2.id, "accepted"); // 打断连续忽略
    const r3 = persistSuggestion(mkTodo("t3"));
    recordFeedback(r3.id, "ignored");
    // 最近 3 条（newest-first）：t3(ignored), t2(accepted), t1(ignored) → 不静默
    expect(isTypeSilenced("todo")).toBe(false);
    // 再补 3 条 ignored，使最近 3 条全 ignored
    for (let i = 4; i <= 6; i++) {
      const r = persistSuggestion(mkTodo(`t${i}`));
      recordFeedback(r.id, "ignored");
    }
    expect(isTypeSilenced("todo")).toBe(true);
  });

  test("不足 3 条同 kind → 不静默", () => {
    const r = persistSuggestion(
      candidate({
        duplicateKey: "solo",
        kind: "todo",
        rawConfidence: 0.72,
        action: { type: "open_memory_board" },
      }),
    );
    recordFeedback(r.id, "ignored");
    expect(isTypeSilenced("todo")).toBe(false);
  });
});

describe("suggestion feedback — never 永久屏蔽集合", () => {
  test("getNeverKeys 收集所有 status=never 的 duplicateKey（accepted 不入集）", () => {
    const r1 = persistSuggestion(candidate({ duplicateKey: "never-a", kind: "correction" }));
    recordFeedback(r1.id, "never");
    const r2 = persistSuggestion(
      candidate({
        duplicateKey: "never-b",
        kind: "automation",
        action: {
          type: "open_automation_create",
          automationTitle: "t",
          suggestedPrompt: "p",
        },
      }),
    );
    recordFeedback(r2.id, "never");
    const r3 = persistSuggestion(candidate({ duplicateKey: "acc-1", kind: "correction" }));
    recordFeedback(r3.id, "accepted");

    const keys = getNeverKeys();
    expect(keys.has("never-a")).toBe(true);
    expect(keys.has("never-b")).toBe(true);
    expect(keys.has("acc-1")).toBe(false);
    expect(keys.size).toBe(2);
  });
});

describe("suggestion feedback — 边界", () => {
  test("recordFeedback 未知 id → 安全无操作（不抛错、不改权重）", () => {
    recordFeedback(99999, "accepted");
    expect(getTypeWeights().correction).toBe(1.0);
    expect(getTypeWeights().automation).toBe(1.0);
  });

  test("recordFeedback 后落盘：resetSuggestionStoreForTest 后权重/状态仍读回", () => {
    const r = persistSuggestion(candidate({ duplicateKey: "p1", kind: "correction" }));
    recordFeedback(r.id, "accepted");
    expect(getTypeWeights().correction).toBeCloseTo(1.2, 6);
    // 清缓存从磁盘读回
    resetSuggestionStoreForTest();
    expect(getTypeWeights().correction).toBeCloseTo(1.2, 6);
    const rec = listSuggestions().find((x) => x.id === r.id);
    expect(rec?.status).toBe("accepted");
  });
});
