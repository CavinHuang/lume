import { describe, expect, test } from "bun:test";
import {
  applyRules,
  automationTitleFromRaw,
  buildSkillCandidate,
  loadDedupContext,
  REPEAT_THRESHOLD,
  SOP_CANDIDATE_THRESHOLD,
} from "./rules";
import type {
  AutomationSignal,
  CorrectionSignal,
  FollowupSignal,
  NegativeSignal,
  RepeatSignal,
  Signal,
  TodoSignal,
} from "./signals";

const correction = (raw: string, confidence = 0.95): CorrectionSignal => ({
  kind: "correction",
  raw,
  rule: raw,
  messageIndex: 0,
  confidence,
});

const followup = (raw: string): FollowupSignal => ({
  kind: "followup",
  raw,
  messageIndex: 0,
  confidence: 0.8,
});

const automation = (raw: string): AutomationSignal => ({
  kind: "automation",
  raw,
  messageIndex: 0,
  confidence: 0.85,
});

const repeat = (intent: string, count: number): RepeatSignal => ({
  kind: "repeat",
  intent,
  raw: intent,
  count,
  messageIndexes: [],
  confidence: 0.7,
});

const todo = (raw: string): TodoSignal => ({
  kind: "todo",
  raw,
  messageIndex: 0,
  confidence: 0.72,
});

const negative = (raw: string): NegativeSignal => ({
  kind: "negative",
  raw,
  messageIndex: 0,
  confidence: 0.9,
});

const ctx = (overrides: Partial<{
  signals: Signal[];
  automationTitles: string[];
  correctionRules: string[];
  sopCandidateCount: number;
}> = {}) => ({
  signals: [],
  automationTitles: [],
  correctionRules: [],
  sopCandidateCount: 0,
  ...overrides,
});

// ===== Brief 契约测试 =====

describe("brief 契约: rules 核心行为", () => {
  test("correction 信号 → memory_correction 候选 + duplicateKey", () => {
    const out = applyRules(ctx({ signals: [correction("以后不要用 var")] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("correction");
    expect(out[0]!.action.type).toBe("memory_correction");
    // normalizeRule("以后不要用 var") = "不要用 var"；rule 部分截断 30 字
    expect(out[0]!.duplicateKey).toBe(`correction:${"不要用 var".slice(0, 30)}`);
  });

  test("automation 信号去重已有 automation 标题", () => {
    // automationTitleFromRaw("每天自动拉取数据") = "拉取数据"；已有 "每天拉取数据" 包含它 → 去重
    const out = applyRules(
      ctx({ signals: [automation("每天自动拉取数据")], automationTitles: ["每天拉取数据"] }),
    );
    expect(out).toHaveLength(0);
  });

  test("skill 候选仅当 sop ≥ SOP_CANDIDATE_THRESHOLD", () => {
    expect(buildSkillCandidate(SOP_CANDIDATE_THRESHOLD - 1)).toBeUndefined();
    expect(buildSkillCandidate(SOP_CANDIDATE_THRESHOLD)?.kind).toBe("skill");
  });
});

// ===== 5 类规则逐项验证 =====

describe("applyRules: 5 类规则", () => {
  test("correction: 已有相同 correction 规则 → 去重", () => {
    const out = applyRules(
      ctx({ signals: [correction("以后不要用 var")], correctionRules: ["不要用 var"] }),
    );
    expect(out).toHaveLength(0);
  });

  test("correction: 无意义规则（『这样』）不产生候选", () => {
    // normalizeRule("以后这样") = "这样" → isMeaningfulRule=false
    const out = applyRules(ctx({ signals: [correction("以后这样")] }));
    expect(out).toHaveLength(0);
  });

  test("followup → open_automation_create 候选", () => {
    const out = applyRules(ctx({ signals: [followup("明天继续处理")] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("followup");
    expect(out[0]!.action.type).toBe("open_automation_create");
    expect(out[0]!.duplicateKey).toBe(`followup:${"明天继续处理".slice(0, 24)}`);
  });

  test("automation → 候选 + 标题来自 automationTitleFromRaw", () => {
    const out = applyRules(ctx({ signals: [automation("每天自动拉取数据")] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("automation");
    expect(out[0]!.action.type).toBe("open_automation_create");
    // duplicateKey 用 automationTitleFromRaw 结果
    expect(out[0]!.duplicateKey).toBe(`automation:${automationTitleFromRaw("每天自动拉取数据")}`);
  });

  test(`repeat: count >= REPEAT_THRESHOLD(${REPEAT_THRESHOLD}) → "定期{intent}" 候选`, () => {
    const out = applyRules(ctx({ signals: [repeat("跑测试", 2)] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("automation");
    expect(out[0]!.duplicateKey).toBe("automation:定期跑测试");
  });

  test(`repeat: count < REPEAT_THRESHOLD → 不产生候选`, () => {
    const out = applyRules(ctx({ signals: [repeat("跑测试", 1)] }));
    expect(out).toHaveLength(0);
  });

  test("repeat: 已有包含 intent 的 automation 标题 → 去重", () => {
    const out = applyRules(
      ctx({ signals: [repeat("跑测试", 2)], automationTitles: ["定期跑测试"] }),
    );
    expect(out).toHaveLength(0);
  });

  test("todo → open_memory_board 候选", () => {
    const out = applyRules(ctx({ signals: [todo("还没完成报告")] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("todo");
    expect(out[0]!.action.type).toBe("open_memory_board");
    expect(out[0]!.duplicateKey).toBe(`todo:${"还没完成报告".slice(0, 20)}`);
  });

  test("negative 信号被忽略（engine 层处理拒绝）", () => {
    const out = applyRules(ctx({ signals: [negative("不用了")] }));
    expect(out).toHaveLength(0);
  });

  test("多信号混合 → 按序输出", () => {
    const out = applyRules(
      ctx({ signals: [correction("以后不要用 var"), followup("明天继续处理"), todo("还没完成报告")] }),
    );
    expect(out.map((c) => c.kind)).toEqual(["correction", "followup", "todo"]);
  });
});

// ===== 辅助函数 =====

describe("automationTitleFromRaw", () => {
  test("剥离句首周期词 + 帮我/请 + 盯/关注 + 尾标点", () => {
    expect(automationTitleFromRaw("每天自动拉取数据")).toBe("拉取数据");
    expect(automationTitleFromRaw("每天都要检查状态")).toBe("状态");
    expect(automationTitleFromRaw("帮我跟进进展")).toBe("进展");
    expect(automationTitleFromRaw("定期监控日志，")).toBe("日志");
  });

  test("≤24 字（超长截断）", () => {
    const long = "每天自动执行一个非常有意义的超长任务名称需要被截断处理才行";
    expect(automationTitleFromRaw(long).length).toBe(24);
  });

  test("全被剥光时回退到原文前 20 字", () => {
    // "帮我盯一下" 全部被剥光 → 回退 raw.slice(0,20)
    expect(automationTitleFromRaw("帮我盯一下")).toBe("帮我盯一下".slice(0, 20));
  });
});

// ===== loadDedupContext（Lume 适配桥接层） =====

describe("loadDedupContext", () => {
  test("返回结构正确（fail-open：空存储 → 空数组 + 0）", () => {
    const out = loadDedupContext({});
    expect(Array.isArray(out.automationTitles)).toBe(true);
    expect(Array.isArray(out.correctionRules)).toBe(true);
    expect(typeof out.sopCandidateCount).toBe("number");
  });

  test("任意 workspace 都不抛错（fail-open：底层异常被吞，返回有效 shape）", () => {
    // 不存在的 workspace 不应让函数抛出；automation 为全局列表（可能非空），
    // memory-v2 含 global 范围（可能非空）。关键是稳定不抛错 + 结构正确。
    const out = loadDedupContext({ workspaceSlug: "__nonexistent__" });
    expect(Array.isArray(out.automationTitles)).toBe(true);
    expect(Array.isArray(out.correctionRules)).toBe(true);
    expect(typeof out.sopCandidateCount).toBe("number");
  });
});
