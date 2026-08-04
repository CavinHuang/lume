import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeEntry } from "./markdown-store";
import {
  ensurePersona,
  parsePersonaProfile,
  readPersonaRaw,
  resetPersonaStoreForTest
} from "./persona";

// ===========================================================================
// 端到端集成测试：REAL persona 管道（仅 mock LLM provider）
//
// REAL：persona.ts（generate/ensure/parse/buildFromRules/storage）+ markdown-store
// （writeEntry/listEntries 真实落盘读取）。
// MOCK：仅 LLM provider —— 通过 ensurePersona 的 providerFactory 入参注入。
// 复用 persona.test.ts 的 tmpdir + LUME_CONFIG_DIR + resetPersonaStoreForTest 套路。
// ===========================================================================

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-persona-e2e-"));
  process.env.LUME_CONFIG_DIR = root;
  resetPersonaStoreForTest();
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

/** 写一条 global 偏好条目到真实 markdown-store。 */
function seedGlobalEntry(input: {
  statement: string;
  kind?: "preference" | "fact" | "decision";
  tags?: string[];
  claim?: { subject: string; predicate: string; object: string };
}): void {
  writeEntry({
    kind: input.kind ?? "preference",
    targetScope: "global",
    statement: input.statement,
    confidence: "high",
    tags: input.tags,
    claim: input.claim
  });
}

/** 一份固定 5 段 Markdown（标题关键词与 parsePersonaProfile 对齐）。 */
const FIVE_SECTION_MD = [
  "# 用户画像",
  "## 用户（称呼）",
  "Alice",
  "## 一句话定位",
  "独立 TS 开发者",
  "## 长期偏好",
  "- 用 TypeScript",
  "- 简洁代码",
  "## 交互协议",
  "- 不要用 var",
  "## 演进轨迹",
  "- 2026-08 偏好 TS"
].join("\n");

describe("persona 端到端集成（real pipeline + mocked LLM）", () => {
  test("Generate 全链路：entries → ensurePersona → write→read→parse 结构正确", async () => {
    // 真实落盘三条 entry（preferred_name claim + preference + correction）
    seedGlobalEntry({
      statement: "叫我 Alice",
      kind: "preference",
      claim: { subject: "user/self", predicate: "preferred_name", object: "Alice" }
    });
    seedGlobalEntry({ statement: "简洁代码", kind: "preference" });
    seedGlobalEntry({ statement: "不要用 var", kind: "fact", tags: ["correction"] });

    // fake provider：模拟 LLM 返回 5 段 Markdown
    const fakeProvider = async () => FIVE_SECTION_MD;

    await ensurePersona({ scope: "global", providerFactory: fakeProvider });

    // readPersonaRaw 读回（round-trip 经原子写入）
    const md = readPersonaRaw("global");
    expect(md).not.toBeNull();
    expect(md).toContain("# 用户画像");

    // parsePersonaProfile 结构正确
    const profile = parsePersonaProfile(md as string);
    expect(profile.name).toBe("Alice");
    expect(profile.summary).toBe("独立 TS 开发者");
    expect(profile.preferences).toEqual(["用 TypeScript", "简洁代码"]);
    expect(profile.interactionRules).toEqual(["不要用 var"]);
    expect(profile.evolution).toEqual(["2026-08 偏好 TS"]);
  });

  test("Fallback：LLM 抛错 → ensurePersona 规则兜底（persona.md 含 用户画像）", async () => {
    seedGlobalEntry({
      statement: "叫我 Alice",
      kind: "preference",
      claim: { subject: "user/self", predicate: "preferred_name", object: "Alice" }
    });
    seedGlobalEntry({ statement: "简洁代码", kind: "preference" });
    seedGlobalEntry({
      statement: "不要用 var",
      kind: "fact",
      tags: ["correction"]
    });

    const throwingProvider = async () => {
      throw new Error("llm unavailable");
    };

    // ensurePersona fail-open：捕获 LLM 错误，走 buildPersonaFromRules 兜底
    await ensurePersona({ scope: "global", providerFactory: throwingProvider });

    const md = readPersonaRaw("global");
    expect(md).not.toBeNull();
    expect(md).toContain("# 用户画像");
    expect(md).toContain("Alice"); // preferred_name claim → name
    expect(md).toContain("简洁代码"); // preference
    expect(md).toContain("不要用 var"); // correction → 交互协议
    // 兜底不输出 LLM-only 段
    expect(md).not.toMatch(/演进|evolution/);
    expect(md).not.toMatch(/定位|summary/);

    // round-trip：兜底产出仍可被 parsePersonaProfile 解析
    // 注意：buildPersonaFromRules 把所有 kind=preference 条目收入 preferences，
    // 故 "叫我 Alice"（带 preferred_name claim 的 preference 条目）也会出现。
    const parsed = parsePersonaProfile(md as string);
    expect(parsed.name).toBe("Alice");
    expect(parsed.preferences).toHaveLength(2);
    expect(parsed.preferences).toEqual(
      expect.arrayContaining(["叫我 Alice", "简洁代码"])
    );
    expect(parsed.interactionRules).toEqual(["不要用 var"]);
  });

  test("Incremental：既有 persona 注入 prompt（增量合并段）", async () => {
    // 先 seed 一条 entry + 写入既有 persona
    seedGlobalEntry({ statement: "用 TypeScript", kind: "preference" });
    const existing = "# 用户画像\n## 一句话定位\n旧画像内容";
    // 用 ensurePersona 自身写入既有 persona（避免直接耦合 writePersona）—— 这里直接走
    // ensurePersona 第一次生成，再验证第二次增量时 existing 被注入 prompt。
    const firstProvider = async () => existing;
    await ensurePersona({ scope: "global", providerFactory: firstProvider });
    expect(readPersonaRaw("global")).toContain("旧画像内容");

    // 第二次：provider 捕获 prompt，验证 existing 内容在其中
    let capturedPrompt = "";
    const secondProvider = async (prompt: string) => {
      capturedPrompt = prompt;
      return FIVE_SECTION_MD;
    };
    await ensurePersona({ scope: "global", providerFactory: secondProvider });

    expect(capturedPrompt).toContain("旧画像内容");
    expect(capturedPrompt).toContain("已有画像");
    // 读回的 persona 已更新为新输出
    expect(readPersonaRaw("global")).toContain("独立 TS 开发者");
  });

  test("correction 回流：correction entry 落盘后 ensurePersona 重生成 persona", async () => {
    // 模拟 service.ts handleSuggestionFeedback(accepted memory_correction) 的下游：
    // smartAddMemoryV2Candidate 写入 correction-tagged entry（用 writeEntry 直接模拟），
    // 随后 fire-and-forget 触发 ensurePersona({ workspaceSlug })。
    // 此处验证：correction entry 经真实 listEntries 被 ensurePersona 读到 → 进入 persona。
    seedGlobalEntry({
      statement: "以后代码注释统一用中文",
      kind: "preference",
      tags: ["correction", "suggestion-derived"]
    });

    // fake provider 捕获 prompt，确认 correction 出现在其中
    let capturedPrompt = "";
    const fakeProvider = async (prompt: string) => {
      capturedPrompt = prompt;
      return [
        "# 用户画像",
        "## 交互协议",
        "- 代码注释统一用中文"
      ].join("\n");
    };

    await ensurePersona({ scope: "global", providerFactory: fakeProvider });

    // listEntries 读到了 correction entry，并格式化进 prompt
    expect(capturedPrompt).toContain("代码注释统一用中文");
    expect(capturedPrompt).toContain("[preference]");
    // persona.md 落盘后含 correction 内容（交互协议段）
    const md = readPersonaRaw("global");
    expect(md).not.toBeNull();
    expect(md).toContain("代码注释统一用中文");
    const parsed = parsePersonaProfile(md as string);
    expect(parsed.interactionRules).toEqual(["代码注释统一用中文"]);
  });
});
