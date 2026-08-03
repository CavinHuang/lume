import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SUGGEST_OPTIONS,
  defaultTypeWeights,
  evaluateSuggestions,
} from "./engine";
import type { SuggestionTypeWeights } from "@lume/shared";

const um = (content: string) => [{ role: "user", content }] as const;

const fullWeights: SuggestionTypeWeights = {
  correction: 1,
  followup: 1,
  automation: 1,
  skill: 0.8,
  todo: 0.9,
};

describe("evaluateSuggestions — 误报控制", () => {
  test("明确拒绝门：最后一条含 NEGATIVE → 整轮空", () => {
    const out = evaluateSuggestions(
      [...um("以后注意代码风格"), ...um("不用了")],
      {
        maxPerSession: 2,
        seenKeys: new Set(),
        typeWeights: fullWeights,
      },
    );
    expect(out.candidates).toHaveLength(0);
    expect(out.suppressed).toHaveLength(0);
  });

  test("threshold 过滤：effective < 0.6 进 suppressed", () => {
    // todo rawConfidence 0.72 × weight 0.1 = 0.072 < 0.6 → suppressed
    const lowTodo: SuggestionTypeWeights = { ...fullWeights, todo: 0.1 };
    const out = evaluateSuggestions(um("还差一点没做完"), {
      maxPerSession: 2,
      seenKeys: new Set(),
      typeWeights: lowTodo,
    });
    expect(out.suppressed.length + out.candidates.length).toBeGreaterThan(0);
    expect(out.candidates.find((c) => c.kind === "todo")).toBeUndefined();
    const todoSuppressed = out.suppressed.find((s) => s.candidate.kind === "todo");
    expect(todoSuppressed).toBeDefined();
    expect(todoSuppressed?.reason).toContain("置信度不足");
  });

  test("maxPerEvaluation=1：多候选只取最高 effective 1 条", () => {
    const out = evaluateSuggestions(um("以后不要用 var，明天提醒我提交"), {
      maxPerSession: 2,
      seenKeys: new Set(),
      typeWeights: fullWeights,
    });
    expect(out.candidates.length).toBeLessThanOrEqual(1);
    // correction eff 0.95 > followup eff 0.8 → 取 correction
    expect(out.candidates[0]?.kind).toBe("correction");
  });

  test("默认 maxPerEvaluation=1 隐式截断", () => {
    // 不传 maxPerEvaluation，应使用默认 1
    const out = evaluateSuggestions(um("以后不要用 var，明天提醒我提交"), {
      seenKeys: new Set(),
      typeWeights: fullWeights,
    });
    expect(out.candidates).toHaveLength(1);
  });
});

describe("evaluateSuggestions — 去重四连", () => {
  test("seenKeys：同会话已建议过 → suppressed", () => {
    // 先拿到一个 correction 候选的 duplicateKey
    const probe = evaluateSuggestions(um("以后不要用 var"), {
      seenKeys: new Set(),
      typeWeights: fullWeights,
    });
    const key = probe.candidates[0]?.duplicateKey;
    expect(key).toBeDefined();

    const out = evaluateSuggestions(um("以后不要用 var"), {
      seenKeys: new Set([key!]),
      typeWeights: fullWeights,
    });
    expect(out.candidates).toHaveLength(0);
    expect(out.suppressed[0]?.reason).toContain("同会话已建议过");
  });

  test("neverKeys：用户永久屏蔽 → suppressed", () => {
    const probe = evaluateSuggestions(um("以后不要用 var"), {
      seenKeys: new Set(),
      typeWeights: fullWeights,
    });
    const key = probe.candidates[0]?.duplicateKey!;
    const out = evaluateSuggestions(um("以后不要用 var"), {
      seenKeys: new Set(),
      neverKeys: new Set([key]),
      typeWeights: fullWeights,
    });
    expect(out.candidates).toHaveLength(0);
    expect(out.suppressed[0]?.reason).toContain("不再建议");
  });

  test("silencedKinds：该类型已被用户静默 → suppressed", () => {
    const out = evaluateSuggestions(um("还差一点没做完"), {
      seenKeys: new Set(),
      silencedKinds: new Set(["todo"]),
      typeWeights: fullWeights,
    });
    expect(out.candidates.find((c) => c.kind === "todo")).toBeUndefined();
    expect(out.suppressed.find((s) => s.candidate.kind === "todo")?.reason).toContain("静默");
  });

  test("同次评估内重复候选 → suppressed", () => {
    // 两条消息各自触发 followup 信号，且 FOLLOWUP 匹配 raw 均为 "明天提醒我提交"
    // （贪婪 {0,30} 回溯到最长：明天 + 提醒我提 + 动词"提交"），slice(0,24) 后同
    // duplicateKey "followup:明天提醒我提交"，第二条被同次评估去重抑制。
    const out = evaluateSuggestions(
      [
        ...um("明天提醒我提交代码审查的最终版本"),
        ...um("明天提醒我提交代码审查的另一部分"),
      ],
      {
        seenKeys: new Set(),
        typeWeights: fullWeights,
      },
    );
    // 候选中至多 1 条 followup（重复的被去重）
    const followupCandidates = out.candidates.filter((c) => c.kind === "followup");
    expect(followupCandidates.length).toBeLessThanOrEqual(1);
    // 第二条 followup 必须以 "重复候选" 原因被同次评估去重抑制
    const dedupSuppressed = out.suppressed.find((s) => s.reason.includes("重复候选"));
    expect(dedupSuppressed).toBeDefined();
    expect(dedupSuppressed?.candidate.kind).toBe("followup");
    expect(dedupSuppressed?.candidate.duplicateKey).toBe("followup:明天提醒我提交");
  });
});

describe("evaluateSuggestions — 边界", () => {
  test("空 user 消息 → 空", () => {
    const out = evaluateSuggestions(
      [{ role: "user", content: "   " }],
      { seenKeys: new Set(), typeWeights: fullWeights },
    );
    expect(out.candidates).toHaveLength(0);
    expect(out.suppressed).toHaveLength(0);
  });

  test("无 user 消息 → 空", () => {
    const out = evaluateSuggestions([], { seenKeys: new Set(), typeWeights: fullWeights });
    expect(out.candidates).toHaveLength(0);
  });

  test("无强信号 → 0 候选（不触发建议）", () => {
    const out = evaluateSuggestions(um("随便聊聊"), {
      seenKeys: new Set(),
      typeWeights: fullWeights,
    });
    expect(out.candidates).toHaveLength(0);
  });

  test("skill 候选受 sopCandidateCount 驱动（sop≥3 触发，<3 不触发）", () => {
    // 用非触发消息让 skill 成为唯一候选（避免被 correction 等高分候选挤出预算）
    const trigger = evaluateSuggestions(um("随便聊聊"), {
      seenKeys: new Set(),
      typeWeights: fullWeights,
      dedupContext: {
        automationTitles: [],
        correctionRules: [],
        sopCandidateCount: 5, // >= SOP_CANDIDATE_THRESHOLD(3) → 触发 skill
      },
    });
    expect(trigger.candidates.find((c) => c.kind === "skill")).toBeDefined();

    const noTrigger = evaluateSuggestions(um("随便聊聊"), {
      seenKeys: new Set(),
      typeWeights: fullWeights,
      dedupContext: {
        automationTitles: [],
        correctionRules: [],
        sopCandidateCount: 1, // < 阈值 → 不触发 skill
      },
    });
    expect(noTrigger.candidates.find((c) => c.kind === "skill")).toBeUndefined();
  });
});

describe("默认参数", () => {
  test("DEFAULT_SUGGEST_OPTIONS 常量精确", () => {
    expect(DEFAULT_SUGGEST_OPTIONS.threshold).toBe(0.6);
    expect(DEFAULT_SUGGEST_OPTIONS.maxPerEvaluation).toBe(1);
    expect(DEFAULT_SUGGEST_OPTIONS.maxPerSession).toBe(2);
  });

  test("defaultTypeWeights 初始权重", () => {
    const w = defaultTypeWeights();
    expect(w.correction).toBe(1.0);
    expect(w.followup).toBe(1.0);
    expect(w.automation).toBe(1.0);
    expect(w.skill).toBe(0.8);
    expect(w.todo).toBe(0.9);
  });

  test("todo 默认权重不会死锁（0.72 × 0.9 = 0.648 > 0.6）", () => {
    const out = evaluateSuggestions(um("还差一点没做完"), {
      seenKeys: new Set(),
      typeWeights: defaultTypeWeights(),
    });
    expect(out.candidates.find((c) => c.kind === "todo")).toBeDefined();
  });
});
