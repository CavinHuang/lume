import { describe, expect, test } from "bun:test";
import {
  AUTOMATION_PATTERNS,
  CORRECTION_PATTERNS,
  extractSignals,
  FOLLOWUP_PATTERNS,
  hasStrongSignal,
  isMeaningfulRule,
  NEGATIVE_PATTERNS,
  normalizeRule,
  POSTPONE_PHRASES,
  TODO_PATTERNS,
  WEAK_INTENT_KEYS,
} from "./signals";

const um = (content: string) => [{ role: "user", content }] as const;

// ===== Brief 契约测试（Task 3 行为合约） =====

describe("brief 契约: signals 核心行为", () => {
  test("correction 模式命中 + confidence 0.95", () => {
    const s = extractSignals(um("以后不要用 var 声明变量"));
    expect(s.some((x) => x.kind === "correction")).toBe(true);
    expect(s.find((x) => x.kind === "correction")!.confidence).toBe(0.95);
  });

  test("normalizeRule 剥离引导词但保留否定词", () => {
    expect(normalizeRule("以后不要用 var")).toBe("不要用 var");
    expect(normalizeRule("请记住别再用 any")).toBe("别再用 any");
  });

  test("NEGATIVE 整条短消息被标记拒绝（供 engine 用）", () => {
    // extractSignals 不直接拒绝，但暴露 negative 标志
    const s = extractSignals(um("不用了"));
    expect(s.some((x) => x.kind === "negative")).toBe(true);
  });

  test("POSTPONE 过滤掉 correction 尾巴", () => {
    const s = extractSignals(um("以后注意代码风格，再聊"));
    expect(s.some((x) => x.kind === "correction")).toBe(false);
  });

  test("repeat 跨 2 条消息同意图触发", () => {
    const s = extractSignals([
      { role: "user", content: "帮我跑测试" },
      { role: "user", content: "帮我跑一下测试" },
    ]);
    expect(s.some((x) => x.kind === "repeat")).toBe(true);
  });

  test("hasStrongSignal 快速路径", () => {
    expect(hasStrongSignal("明天提醒我提交")).toBe(true);
    expect(hasStrongSignal("你好")).toBe(false);
  });
});

// ===== 1:1 移植 Proma 的回归测试（验证 verbatim 移植） =====

describe("suggest/signals: 纠正信号", () => {
  test("识别明确纠正 '以后不要 X'", () => {
    const signals = extractSignals(um("以后不要用 setTimeout 写定时器"));
    const correction = signals.find((s) => s.kind === "correction");
    expect(correction).toBeDefined();
    if (correction && correction.kind === "correction") {
      expect(correction.confidence).toBeGreaterThan(0.9);
    }
  });

  test("识别 '下次记得 X'", () => {
    const signals = extractSignals(um("下次记得先查文档"));
    expect(signals.some((s) => s.kind === "correction")).toBe(true);
  });

  test("识别 '我更喜欢 X'", () => {
    const signals = extractSignals(um("我更喜欢用 TypeScript 而不是 JavaScript"));
    expect(signals.some((s) => s.kind === "correction")).toBe(true);
  });

  test("过长文本不误报（纯描述无纠正词）", () => {
    const signals = extractSignals(um("帮我写一个排序算法，要求稳定排序"));
    expect(signals.some((s) => s.kind === "correction")).toBe(false);
  });

  test("'以后' 太短不触发（断片防护, raw.length<6 丢弃）", () => {
    const signals = extractSignals(um("以后不要"));
    expect(signals.some((s) => s.kind === "correction")).toBe(false);
  });

  test("'不要这样' 无意义内容不触发", () => {
    const signals = extractSignals(um("不要这样"));
    expect(signals.some((s) => s.kind === "correction")).toBe(false);
  });

  test("每条消息最多 1 个 correction 信号", () => {
    // 单条消息同时命中多个 CORRECTION 正则，只产出 1 个 correction
    const signals = extractSignals(um("以后不要用 var，下次记住别再用 any"));
    const corrections = signals.filter((s) => s.kind === "correction");
    expect(corrections.length).toBe(1);
  });
});

describe("suggest/signals: 跟进/自动化/未完成", () => {
  test("识别 '明天继续'", () => {
    const signals = extractSignals(um("明天继续这个任务"));
    expect(signals.some((s) => s.kind === "followup")).toBe(true);
  });

  test("识别 '稍后提醒我'", () => {
    const signals = extractSignals(um("稍后提醒我提交代码"));
    expect(signals.some((s) => s.kind === "followup")).toBe(true);
  });

  test("识别周期性需求 '每天自动总结'（automation 0.85）", () => {
    const signals = extractSignals(um("每天自动帮我总结当天工作"));
    const auto = signals.find((s) => s.kind === "automation");
    expect(auto).toBeDefined();
    expect(auto!.confidence).toBe(0.85);
  });

  test("识别未完成信号 '这个功能还没做完'（todo 0.72）", () => {
    const signals = extractSignals(um("这个功能还没做完，回头再弄"));
    const todo = signals.find((s) => s.kind === "todo");
    expect(todo).toBeDefined();
    expect(todo!.confidence).toBe(0.72);
  });

  test("'明天再说吧' 不触发 followup（推迟讨论不是任务）", () => {
    const signals = extractSignals(um("明天再说吧"));
    expect(signals.some((s) => s.kind === "followup")).toBe(false);
  });

  test("'还没' 断片不触发 todo（raw.length<4 丢弃）", () => {
    const signals = extractSignals(um("还没"));
    expect(signals.some((s) => s.kind === "todo")).toBe(false);
  });
});

describe("suggest/signals: 重复意图", () => {
  test("同一意图出现 2 次识别为重复（count=2, confidence=0.6）", () => {
    const signals = extractSignals([
      { role: "user", content: "帮我总结一下今天的工作" },
      { role: "user", content: "帮我总结一下项目进展" },
    ]);
    const repeat = signals.find((s) => s.kind === "repeat");
    expect(repeat).toBeDefined();
    if (repeat && repeat.kind === "repeat") {
      expect(repeat.count).toBe(2);
      expect(repeat.confidence).toBe(0.6);
      expect(repeat.messageIndexes.length).toBe(2);
    }
  });

  test("不同意图不误判重复", () => {
    const signals = extractSignals([
      { role: "user", content: "帮我写个排序" },
      { role: "user", content: "帮我画个图" },
    ]);
    expect(signals.some((s) => s.kind === "repeat")).toBe(false);
  });

  test("弱意图 '帮我看看X'+'帮我看看Y' 不误判重复", () => {
    const signals = extractSignals([
      { role: "user", content: "帮我看看这个文件" },
      { role: "user", content: "帮我看看那个配置" },
    ]);
    expect(signals.some((s) => s.kind === "repeat")).toBe(false);
  });

  test("重复 3 次 confidence 升至 0.7（封顶 0.9）", () => {
    const signals = extractSignals([
      { role: "user", content: "帮我部署测试环境" },
      { role: "user", content: "帮我部署预发环境" },
      { role: "user", content: "帮我部署生产环境" },
    ]);
    const repeat = signals.find((s) => s.kind === "repeat");
    expect(repeat).toBeDefined();
    if (repeat && repeat.kind === "repeat") {
      expect(repeat.count).toBe(3);
      expect(repeat.confidence).toBe(0.7);
    }
  });

  test("单条消息内重复不触发（需跨 ≥2 条消息）", () => {
    const signals = extractSignals(um("帮我跑测试，帮我跑测试"));
    // 同一 messageIndex 不应触发 repeat
    const repeat = signals.find((s) => s.kind === "repeat");
    expect(repeat).toBeUndefined();
  });
});

describe("suggest/signals: NEGATIVE 拒绝信号", () => {
  test("'不用了' 短消息标记 negative", () => {
    const signals = extractSignals(um("不用了"));
    expect(signals.some((s) => s.kind === "negative")).toBe(true);
  });

  test("'算了' 标记 negative", () => {
    const signals = extractSignals(um("算了"));
    expect(signals.some((s) => s.kind === "negative")).toBe(true);
  });

  test("含拒绝词但主体是纠正的长消息仍提取纠正信号（不标记 negative）", () => {
    // 长度 > 12 → 不是纯拒绝短句
    const signals = extractSignals(um("不用管那个 bug，以后写代码注意点"));
    expect(signals.some((s) => s.kind === "negative")).toBe(false);
    expect(signals.some((s) => s.kind === "correction")).toBe(true);
  });
});

describe("suggest/signals: POSTPONE 延后结束语", () => {
  test("'以后再说吧' 不误判为纠正（延后≠纠正）", () => {
    const signals = extractSignals(um("这个问题以后再说吧"));
    expect(signals.some((s) => s.kind === "correction")).toBe(false);
  });
});

describe("suggest/signals: normalizeRule 否定词保留（P0 回归）", () => {
  test("保留否定词（'以后不要用 var' 不能变成 '用 var'）", () => {
    expect(normalizeRule("以后不要用 var 声明变量")).toBe("不要用 var 声明变量");
    expect(normalizeRule("下次别再用 var")).toBe("别再用 var");
    expect(normalizeRule("以后不要再写死路径")).toBe("不要再写死路径");
  });

  test("去除尾标点", () => {
    expect(normalizeRule("记住先查文档。")).toBe("先查文档");
  });

  test("多层引导词剥离（'请记住以后不要再...'）", () => {
    expect(normalizeRule("请记住以后不要用 any")).toBe("不要用 any");
  });

  test("全部为引导词时回退原文", () => {
    // 剥离后为空 → 回退 raw，避免返回空字符串
    expect(normalizeRule("以后")).toBe("以后");
  });
});

describe("suggest/signals: isMeaningfulRule", () => {
  test("长度 < 2 无效", () => {
    expect(isMeaningfulRule("a")).toBe(false);
    expect(isMeaningfulRule("")).toBe(false);
  });

  test("无意义残留词无效", () => {
    expect(isMeaningfulRule("这样")).toBe(false);
    expect(isMeaningfulRule("再说")).toBe(false);
    expect(isMeaningfulRule("一下")).toBe(false);
    expect(isMeaningfulRule("算了")).toBe(false);
  });

  test("有意义规则有效", () => {
    expect(isMeaningfulRule("不要用 var")).toBe(true);
    expect(isMeaningfulRule("先查文档")).toBe(true);
  });
});

describe("suggest/signals: 模式表完整性（1:1 移植校验）", () => {
  test("所有模式表非空且为正则", () => {
    expect(CORRECTION_PATTERNS.length).toBeGreaterThan(0);
    expect(FOLLOWUP_PATTERNS.length).toBeGreaterThan(0);
    expect(AUTOMATION_PATTERNS.length).toBeGreaterThan(0);
    expect(TODO_PATTERNS.length).toBeGreaterThan(0);
    expect(NEGATIVE_PATTERNS.length).toBeGreaterThan(0);
    expect(POSTPONE_PHRASES.length).toBeGreaterThan(0);
    expect(WEAK_INTENT_KEYS.length).toBeGreaterThan(0);
    for (const re of CORRECTION_PATTERNS) expect(re).toBeInstanceOf(RegExp);
    for (const re of FOLLOWUP_PATTERNS) expect(re).toBeInstanceOf(RegExp);
  });
});
