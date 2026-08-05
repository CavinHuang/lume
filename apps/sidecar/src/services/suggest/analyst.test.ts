import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LLMProvider } from "@lume/agent-sdk";
import type { PersonaProfile } from "@lume/shared";
import { createMemoryV2Store, writeMarkdownDocument } from "../memory-v2/markdown-store";
import { DEFAULT_ACTIVATION } from "../memory-v2/types";
import {
  ALLOWED_KINDS,
  MAX_CANDIDATES,
  buildAnalysisInput,
  parseAnalystResponse,
  runAnalysis,
  validateAnalystCandidate,
  validateAnalystCandidates,
} from "./analyst";

// ===== buildAnalysisInput: persona 注入 mock（周期 3 Task 1） =====
// 通过 mock.module 替换 ../memory-v2/persona 的读取/解析，控制 readPersonaRaw/parsePersonaProfile 行为。
let personaRaw: string | null;
let personaProfile: PersonaProfile;
let personaReadThrows: boolean;

mock.module("../memory-v2/persona", () => ({
  readPersonaRaw: () => {
    if (personaReadThrows) throw new Error("persona read fail");
    return personaRaw;
  },
  parsePersonaProfile: () => personaProfile,
}));

let root: string;

beforeEach(() => {
  personaRaw = null;
  personaProfile = { preferences: [], interactionRules: [], evolution: [] };
  personaReadThrows = false;
  root = mkdtempSync(join(tmpdir(), "lume-suggest-analyst-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

// ===== Brief 契约：常量 =====

describe("brief 契约: 常量", () => {
  test("ALLOWED_KINDS 仅含 automation/skill/todo（不含 correction/followup）", () => {
    expect(ALLOWED_KINDS).toEqual(["automation", "skill", "todo"]);
  });

  test("MAX_CANDIDATES = 3", () => {
    expect(MAX_CANDIDATES).toBe(3);
  });
});

// ===== validateAnalystCandidate：schema 严格校验 =====

describe("validateAnalystCandidate: kind 校验", () => {
  test("越界 kind（correction）被拒 → null", () => {
    expect(
      validateAnalystCandidate({
        kind: "correction",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "memory_correction", raw: "r", rule: "r" },
      }),
    ).toBeNull();
  });

  test("越界 kind（followup）被拒 → null", () => {
    expect(
      validateAnalystCandidate({
        kind: "followup",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_automation_create", automationTitle: "t", suggestedPrompt: "p" },
      }),
    ).toBeNull();
  });

  test("未知 kind 被拒 → null", () => {
    expect(
      validateAnalystCandidate({
        kind: "unknown",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_memory_board" },
      }),
    ).toBeNull();
  });

  test("非对象输入被拒 → null", () => {
    expect(validateAnalystCandidate(null)).toBeNull();
    expect(validateAnalystCandidate(undefined)).toBeNull();
    expect(validateAnalystCandidate("automation" as never)).toBeNull();
  });
});

describe("validateAnalystCandidate: 字段非空校验", () => {
  test("任一必填字段空字符串被拒", () => {
    expect(
      validateAnalystCandidate({
        kind: "todo",
        title: "",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_memory_board" },
      }),
    ).toBeNull();
    expect(
      validateAnalystCandidate({
        kind: "todo",
        title: "t",
        reason: "",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_memory_board" },
      }),
    ).toBeNull();
    expect(
      validateAnalystCandidate({
        kind: "todo",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "",
        action: { type: "open_memory_board" },
      }),
    ).toBeNull();
  });

  test("缺少 action 被拒", () => {
    expect(
      validateAnalystCandidate({
        kind: "todo",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
      }),
    ).toBeNull();
  });
});

describe("validateAnalystCandidate: 长度截断（Lume 偏离 Proma：截断而非拒绝）", () => {
  test("title 超 40 字被截断后接受", () => {
    const longTitle = "x".repeat(50);
    const c = validateAnalystCandidate({
      kind: "automation",
      title: longTitle,
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_automation_create", automationTitle: "t", suggestedPrompt: "p" },
    });
    expect(c).not.toBeNull();
    expect(c!.title.length).toBeLessThanOrEqual(40);
    expect(c!.title).toBe("x".repeat(40));
  });

  test("reason 超 200 字被截断", () => {
    const longReason = "r".repeat(250);
    const c = validateAnalystCandidate({
      kind: "todo",
      title: "t",
      reason: longReason,
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_memory_board" },
    });
    expect(c).not.toBeNull();
    expect(c!.reason.length).toBe(200);
  });

  test("evidence 超 200 字被截断", () => {
    const longEvidence = "e".repeat(300);
    const c = validateAnalystCandidate({
      kind: "todo",
      title: "t",
      reason: "r",
      evidence: longEvidence,
      duplicateKey: "k",
      action: { type: "open_memory_board" },
    });
    expect(c).not.toBeNull();
    expect(c!.evidence.length).toBe(200);
  });

  test("duplicateKey 超 200 字被截断", () => {
    const longKey = "k".repeat(250);
    const c = validateAnalystCandidate({
      kind: "todo",
      title: "t",
      reason: "r",
      evidence: "e",
      duplicateKey: longKey,
      action: { type: "open_memory_board" },
    });
    expect(c).not.toBeNull();
    expect(c!.duplicateKey.length).toBe(200);
  });

  test("automation.automationTitle 超 100 字被截断", () => {
    const longTitle = "a".repeat(150);
    const c = validateAnalystCandidate({
      kind: "automation",
      title: "t",
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_automation_create", automationTitle: longTitle, suggestedPrompt: "p" },
    });
    expect(c).not.toBeNull();
    expect((c!.action as { automationTitle: string }).automationTitle.length).toBe(100);
  });

  test("automation.suggestedPrompt 超 1000 字被截断", () => {
    const longPrompt = "p".repeat(1200);
    const c = validateAnalystCandidate({
      kind: "automation",
      title: "t",
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_automation_create", automationTitle: "t", suggestedPrompt: longPrompt },
    });
    expect(c).not.toBeNull();
    expect((c!.action as { suggestedPrompt: string }).suggestedPrompt.length).toBe(1000);
  });

  test("skill.topic 超 100 字被截断", () => {
    const longTopic = "t".repeat(150);
    const c = validateAnalystCandidate({
      kind: "skill",
      title: "t",
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_skill_creator", topic: longTopic },
    });
    expect(c).not.toBeNull();
    expect((c!.action as { topic: string }).topic.length).toBe(100);
  });
});

describe("validateAnalystCandidate: kind-action 匹配", () => {
  test("automation 必须 open_automation_create（不匹配被拒）", () => {
    expect(
      validateAnalystCandidate({
        kind: "automation",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_memory_board" },
      }),
    ).toBeNull();
  });

  test("automation 缺 automationTitle 被拒", () => {
    expect(
      validateAnalystCandidate({
        kind: "automation",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_automation_create", suggestedPrompt: "p" },
      }),
    ).toBeNull();
  });

  test("automation 缺 suggestedPrompt 被拒", () => {
    expect(
      validateAnalystCandidate({
        kind: "automation",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_automation_create", automationTitle: "t" },
      }),
    ).toBeNull();
  });

  test("skill 必须 open_skill_creator（不匹配被拒）", () => {
    expect(
      validateAnalystCandidate({
        kind: "skill",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_memory_board" },
      }),
    ).toBeNull();
  });

  test("skill 缺 topic 被拒", () => {
    expect(
      validateAnalystCandidate({
        kind: "skill",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_skill_creator" },
      }),
    ).toBeNull();
  });

  test("todo 必须 open_memory_board（不匹配被拒）", () => {
    expect(
      validateAnalystCandidate({
        kind: "todo",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_automation_create", automationTitle: "t", suggestedPrompt: "p" },
      }),
    ).toBeNull();
  });
});

describe("validateAnalystCandidate: 默认 rawConfidence", () => {
  test("automation rawConfidence = 0.7", () => {
    const c = validateAnalystCandidate({
      kind: "automation",
      title: "t",
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_automation_create", automationTitle: "t", suggestedPrompt: "p" },
    });
    expect(c!.rawConfidence).toBe(0.7);
  });

  test("skill rawConfidence = 0.65", () => {
    const c = validateAnalystCandidate({
      kind: "skill",
      title: "t",
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_skill_creator", topic: "topic" },
    });
    expect(c!.rawConfidence).toBe(0.65);
  });

  test("todo rawConfidence = 0.6", () => {
    const c = validateAnalystCandidate({
      kind: "todo",
      title: "t",
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_memory_board" },
    });
    expect(c!.rawConfidence).toBe(0.6);
  });
});

describe("validateAnalystCandidate: 非字符串字段容错（safeStr）", () => {
  test("数组型 evidence 取首个字符串元素", () => {
    const c = validateAnalystCandidate({
      kind: "todo",
      title: "t",
      reason: "r",
      evidence: ["证据一", "证据二"],
      duplicateKey: "k",
      action: { type: "open_memory_board" },
    });
    expect(c!.evidence).toBe("证据一");
  });

  test("数字字段转字符串", () => {
    const c = validateAnalystCandidate({
      kind: "todo",
      title: 42,
      reason: "r",
      evidence: "e",
      duplicateKey: "k",
      action: { type: "open_memory_board" },
    });
    expect(c!.title).toBe("42");
  });
});

// ===== validateAnalystCandidates：去重 + slice =====

describe("validateAnalystCandidates", () => {
  test("按 duplicateKey 去重", () => {
    const raws = [
      {
        kind: "todo",
        title: "t1",
        reason: "r",
        evidence: "e",
        duplicateKey: "same-key",
        action: { type: "open_memory_board" },
      },
      {
        kind: "todo",
        title: "t2",
        reason: "r",
        evidence: "e",
        duplicateKey: "same-key",
        action: { type: "open_memory_board" },
      },
    ];
    const out = validateAnalystCandidates(raws);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("t1");
  });

  test("超过 MAX_CANDIDATES 截断为 3", () => {
    const raws = Array.from({ length: 6 }, (_, i) => ({
      kind: "todo",
      title: `t${i}`,
      reason: "r",
      evidence: "e",
      duplicateKey: `key-${i}`,
      action: { type: "open_memory_board" },
    }));
    const out = validateAnalystCandidates(raws);
    expect(out).toHaveLength(MAX_CANDIDATES);
  });

  test("非法候选被过滤", () => {
    const raws = [
      { kind: "correction", title: "x", action: { type: "memory_correction" } },
      {
        kind: "todo",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_memory_board" },
      },
    ];
    const out = validateAnalystCandidates(raws);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("todo");
  });

  test("空数组输入 → 空数组", () => {
    expect(validateAnalystCandidates([])).toEqual([]);
  });
});

// ===== parseAnalystResponse：LLM 输出解析 =====

describe("parseAnalystResponse", () => {
  test("裸 JSON 数组", () => {
    const raw = JSON.stringify([
      {
        kind: "todo",
        title: "t",
        reason: "r",
        evidence: "e",
        duplicateKey: "k",
        action: { type: "open_memory_board" },
      },
    ]);
    const out = parseAnalystResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("todo");
  });

  test("markdown 围栏 ```json 剥离", () => {
    const raw = '```json\n[{"kind":"todo","title":"t"}]\n```';
    const out = parseAnalystResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("todo");
  });

  test("围栏 ``` （无 json 标签）剥离", () => {
    const raw = '```\n[{"kind":"skill","title":"t"}]\n```';
    const out = parseAnalystResponse(raw);
    expect(out).toHaveLength(1);
  });

  test("前后带噪声文本，区间提取", () => {
    const raw = '好的，分析如下：\n[{"kind":"todo","title":"t"}]\n以上。';
    const out = parseAnalystResponse(raw);
    expect(out).toHaveLength(1);
  });

  test("空字符串 → []", () => {
    expect(parseAnalystResponse("")).toEqual([]);
    expect(parseAnalystResponse("   ")).toEqual([]);
  });

  test("无数组结构 → []", () => {
    expect(parseAnalystResponse('{"kind":"todo"}')).toEqual([]);
    expect(parseAnalystResponse("not json at all")).toEqual([]);
  });

  test("JSON 解析失败 → []", () => {
    expect(parseAnalystResponse("[{invalid}]")).toEqual([]);
  });

  test("解析结果非数组（对象）→ []", () => {
    expect(parseAnalystResponse('{"a":1}')).toEqual([]);
  });

  test("数组内非对象元素被过滤", () => {
    const raw = '["string", 42, {"kind":"todo","title":"t"}]';
    const out = parseAnalystResponse(raw);
    expect(out).toHaveLength(1);
  });
});

// ===== runAnalysis：LLM 编排（注入 provider，不打真实 API） =====

const fakeProvider = (responseText: string): LLMProvider => ({
  apiType: "openai-completions",
  async createMessage() {
    return {
      content: [{ type: "text", text: responseText }],
      stopReason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  },
});

describe("runAnalysis", () => {
  test("注入 provider：返回解析+校验后的候选", async () => {
    const canned = JSON.stringify([
      {
        kind: "automation",
        title: "每周发版检查",
        reason: "重复出现",
        evidence: "近期记忆",
        duplicateKey: "automation:每周发版检查",
        action: {
          type: "open_automation_create",
          automationTitle: "每周发版检查",
          suggestedPrompt: "执行发版检查",
        },
      },
      {
        kind: "todo",
        title: "汇总待办",
        reason: "未完成",
        evidence: "记忆",
        duplicateKey: "todo:汇总待办",
        action: { type: "open_memory_board" },
      },
    ]);
    const out = await runAnalysis({
      context: "近期记忆条目：\n- [fact] 每周发版",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => fakeProvider(canned),
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe("automation");
    expect(out[1]!.kind).toBe("todo");
  });

  test("LLM 返回非法 JSON → fail-open []", async () => {
    const out = await runAnalysis({
      context: "近期记忆",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => fakeProvider("not json"),
    });
    expect(out).toEqual([]);
  });

  test("provider 抛错 → fail-open []（不抛出）", async () => {
    const throwingProvider: LLMProvider = {
      apiType: "openai-completions",
      async createMessage() {
        throw new Error("network down");
      },
    };
    const out = await runAnalysis({
      context: "近期记忆",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => throwingProvider,
    });
    expect(out).toEqual([]);
  });

  test("空 context → 直接返回 []（不调用 LLM）", async () => {
    let called = false;
    const out = await runAnalysis({
      context: "",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => {
        called = true;
        return fakeProvider("[]");
      },
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("围码包裹的 LLM 输出也能正确解析", async () => {
    const canned = '```json\n[{"kind":"skill","title":"沉淀 Skill","reason":"r","evidence":"e","duplicateKey":"skill:x","action":{"type":"open_skill_creator","topic":"流程"}}]\n```';
    const out = await runAnalysis({
      context: "近期记忆",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => fakeProvider(canned),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("skill");
    expect(out[0]!.rawConfidence).toBe(0.65);
  });
});

// ===== buildAnalysisInput：persona 注入（周期 3 Task 1） =====

describe("buildAnalysisInput: persona 注入", () => {
  test("persona 存在 → 注入 summary + preferences", () => {
    personaRaw = "# 用户画像\n## 一句话定位\n独立开发者";
    personaProfile = {
      summary: "独立开发者，偏好 TypeScript",
      preferences: ["用 TypeScript", "简洁代码", "夜间工作"],
      interactionRules: [],
      evolution: [],
    };
    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).toContain("用户画像（persona）");
    expect(input).toContain("独立开发者，偏好 TypeScript");
    expect(input).toContain("用 TypeScript");
    expect(input).toContain("简洁代码");
  });

  test("persona preferences 超过 8 条 → 仅注入前 8 条", () => {
    personaRaw = "# 用户画像";
    personaProfile = {
      summary: "s",
      preferences: Array.from({ length: 12 }, (_, i) => `偏好项${i}`),
      interactionRules: [],
      evolution: [],
    };
    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).toContain("偏好项0");
    expect(input).toContain("偏好项7");
    expect(input).not.toContain("偏好项8");
    expect(input).not.toContain("偏好项11");
  });

  test("persona 不存在 → 跳过（无「用户画像（persona）」段，周期 1 行为）", () => {
    personaRaw = null;
    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).not.toContain("用户画像（persona）");
  });

  test("persona 读取抛错 → fail-open（无 persona 段，不中断）", () => {
    personaReadThrows = true;
    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).not.toContain("用户画像（persona）");
  });

  test("persona 存在但 summary 与 preferences 均空 → 跳过该段", () => {
    personaRaw = "# 用户画像";
    personaProfile = { preferences: [], interactionRules: [], evolution: [] };
    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).not.toContain("用户画像（persona）");
  });
});

// ===== buildAnalysisInput: activation.analyst 过滤（Task 3） =====

describe("buildAnalysisInput: activation.analyst 过滤", () => {
  test("activation.analyst=false 的条目不进分析输入", () => {
    const store = createMemoryV2Store();
    const visible = store.writeEntry({
      kind: "fact",
      targetScope: "global",
      statement: "analyst-visible 每周发版前手动跑检查",
      confidence: "high",
    });
    const suppressed = store.writeEntry({
      kind: "fact",
      targetScope: "global",
      statement: "analyst-suppressed 每周发版前手动跑检查",
      confidence: "high",
    });
    writeMarkdownDocument(suppressed.path, {
      ...suppressed.frontmatter,
      activation: { ...DEFAULT_ACTIVATION, analyst: false },
    }, suppressed.statement);

    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).toContain("analyst-visible");
    expect(input).not.toContain("analyst-suppressed");
  });

  test("activation.analyst=false 的 correction 条目不进已生效行为规则段", () => {
    const store = createMemoryV2Store();
    const visible = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "correction-visible 不要用 var",
      confidence: "high",
      tags: ["correction"],
    });
    const suppressed = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "correction-suppressed 不要用 let",
      confidence: "high",
      tags: ["correction"],
    });
    writeMarkdownDocument(suppressed.path, {
      ...suppressed.frontmatter,
      activation: { ...DEFAULT_ACTIVATION, analyst: false },
    }, suppressed.statement);

    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).toContain("correction-visible");
    expect(input).not.toContain("correction-suppressed");
  });

  test("旧条目（无 activation 字段）不受影响（fail-open）", () => {
    const store = createMemoryV2Store();
    const entry = store.writeEntry({
      kind: "fact",
      targetScope: "global",
      statement: "legacy-analyst 工作流",
      confidence: "high",
    });
    const legacyFrontmatter: Omit<typeof entry.frontmatter, "activation"> = {
      ...entry.frontmatter,
    };
    delete (legacyFrontmatter as { activation?: unknown }).activation;
    writeMarkdownDocument(entry.path, legacyFrontmatter, entry.statement);

    const input = buildAnalysisInput({ workspaceSlug: undefined });
    expect(input).toContain("legacy-analyst");
  });
});
