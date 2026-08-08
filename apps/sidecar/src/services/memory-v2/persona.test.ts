import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildPersonaFromRules,
  deletePersona,
  ensurePersona,
  generatePersona,
  getPersonaPath,
  parsePersonaProfile,
  readPersonaRaw,
  resetPersonaStoreForTest,
  writePersona
} from "./persona";
import { createMemoryV2Store, writeMarkdownDocument } from "./markdown-store";
import { DEFAULT_ACTIVATION, type MemoryV2Entry } from "./types";

const mkEntry = (
  over: Partial<MemoryV2Entry["frontmatter"]> & { statement: string }
): MemoryV2Entry =>
  ({
    frontmatter: {
      id: "e1",
      kind: "preference",
      scope: "global",
      status: "active",
      created: "t",
      updated: "t",
      source: { type: "manual" },
      confidence: "high",
      pinned: false,
      tags: [],
      entities: [],
      related: [],
      supersedes: [],
      superseded_by: null,
      applies_when: {},
      valid_from: null,
      valid_to: null,
      ...over
    } as MemoryV2Entry["frontmatter"],
    statement: over.statement,
    path: "p"
  }) as MemoryV2Entry;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-persona-"));
  process.env.LUME_CONFIG_DIR = root;
  resetPersonaStoreForTest();
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("persona store", () => {
  test("writePersona + readPersonaRaw 往返", () => {
    writePersona("global", undefined, "# 用户画像\n## 一句话定位\n开发者");
    expect(readPersonaRaw("global")).toBe("# 用户画像\n## 一句话定位\n开发者");
  });

  test("readPersonaRaw 不存在返回 null", () => {
    expect(readPersonaRaw("global")).toBeNull();
  });

  test("deletePersona 幂等", () => {
    writePersona("global", undefined, "x");
    deletePersona("global");
    expect(readPersonaRaw("global")).toBeNull();
    expect(() => deletePersona("global")).not.toThrow();
  });

  test("workspace scope 独立于 global", () => {
    writePersona("global", undefined, "G");
    writePersona("workspace", "my-team", "W");
    expect(readPersonaRaw("global")).toBe("G");
    expect(readPersonaRaw("workspace", "my-team")).toBe("W");
    expect(getPersonaPath("global")).not.toBe(getPersonaPath("workspace", "my-team"));
  });

  test("writePersona 覆盖既有内容", () => {
    writePersona("global", undefined, "old");
    writePersona("global", undefined, "new");
    expect(readPersonaRaw("global")).toBe("new");
  });
});

describe("parsePersonaProfile", () => {
  test("解析 5 段", () => {
    const md = `# 用户画像
## 用户（称呼）
Alice
## 一句话定位
独立开发者
## 长期偏好
- 用 TypeScript
- 简洁代码
## 交互协议
- 不要用 var
## 演进轨迹
- 2026-08 偏好 TS`;
    const p = parsePersonaProfile(md);
    expect(p.name).toBe("Alice");
    expect(p.summary).toBe("独立开发者");
    expect(p.preferences).toEqual(["用 TypeScript", "简洁代码"]);
    expect(p.interactionRules).toEqual(["不要用 var"]);
    expect(p.evolution.length).toBeGreaterThan(0);
  });

  test("缺段返回空数组", () => {
    const p = parsePersonaProfile("# 用户画像\n## 一句话定位\nx");
    expect(p.preferences).toEqual([]);
    expect(p.interactionRules).toEqual([]);
    expect(p.evolution).toEqual([]);
    expect(p.summary).toBe("x");
    expect(p.name).toBeUndefined();
  });

  test("空字符串所有字段空", () => {
    const p = parsePersonaProfile("");
    expect(p.preferences).toEqual([]);
    expect(p.interactionRules).toEqual([]);
    expect(p.evolution).toEqual([]);
  });
});

describe("buildPersonaFromRules", () => {
  test("兜底画像：name + preference + correction", () => {
    const entries = [
      mkEntry({
        statement: "用 TypeScript",
        tags: ["preferred-name"],
        kind: "preference",
        claim: { subject: "user/self", predicate: "preferred_name", object: "Alice" }
      }),
      mkEntry({ statement: "简洁代码", kind: "preference" }),
      mkEntry({ statement: "不要用 var", tags: ["correction"], kind: "fact" })
    ];
    const md = buildPersonaFromRules(entries);
    expect(md).toContain("Alice"); // name from preferred_name claim object
    expect(md).toContain("简洁代码"); // preference
    expect(md).toContain("不要用 var"); // correction → 交互协议
    // 不含 LLM-only 段
    expect(md).not.toMatch(/演进|evolution/);
    expect(md).not.toMatch(/定位|summary/);
  });

  test("无 preferred_name 仍产出（仅偏好段）", () => {
    const md = buildPersonaFromRules([
      mkEntry({ statement: "偏好 X", kind: "preference" })
    ]);
    expect(md).toContain("偏好 X");
    expect(md).toContain("长期偏好");
    expect(md).toContain("用户画像"); // 顶层标题
  });

  test("空 entries → 占位 Markdown（含顶层标题）", () => {
    const md = buildPersonaFromRules([]);
    expect(md).toContain("# 用户画像");
    // 仍可被 parsePersonaProfile 解析
    const parsed = parsePersonaProfile(md);
    expect(parsed.preferences).toEqual([]);
    expect(parsed.interactionRules).toEqual([]);
  });

  test("preferences 上限 5 / correction 上限 3", () => {
    const entries: MemoryV2Entry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push(mkEntry({ statement: `pref-${i}`, kind: "preference" }));
    }
    for (let i = 0; i < 5; i++) {
      entries.push(
        mkEntry({ statement: `rule-${i}`, tags: ["correction"], kind: "fact" })
      );
    }
    const md = buildPersonaFromRules(entries);
    const parsed = parsePersonaProfile(md);
    expect(parsed.preferences).toHaveLength(5);
    expect(parsed.interactionRules).toHaveLength(3);
  });

  test("round-trip：规则输出可被 parsePersonaProfile 解析", () => {
    const entries = [
      mkEntry({
        statement: "用户希望被称呼为 Alice",
        kind: "preference",
        claim: { subject: "user/self", predicate: "preferred_name", object: "Alice" }
      }),
      mkEntry({ statement: "简洁代码", kind: "preference" }),
      mkEntry({ statement: "不要用 var", tags: ["correction"], kind: "fact" })
    ];
    const md = buildPersonaFromRules(entries);
    const parsed = parsePersonaProfile(md);
    expect(parsed.name).toBe("Alice");
    expect(parsed.interactionRules).toEqual(["不要用 var"]);
  });
});

describe("generatePersona", () => {
  test("用注入 provider 生成 Markdown（brief 契约）", async () => {
    const fake = async () => "# 用户画像\n## 一句话定位\n开发者";
    const md = await generatePersona({ entries: [], providerFactory: fake });
    expect(md).toContain("# 用户画像");
  });

  test("existing 注入 prompt（增量合并段）", async () => {
    let captured = "";
    const fake = async (prompt: string) => {
      captured = prompt;
      return "# x";
    };
    await generatePersona({
      entries: [],
      existing: "旧画像",
      providerFactory: fake
    });
    expect(captured).toContain("旧画像");
    expect(captured).toContain("已有画像");
  });

  test("entries 格式化为 [kind] statement 进入 prompt", async () => {
    let captured = "";
    const fake = async (prompt: string) => {
      captured = prompt;
      return "# x";
    };
    await generatePersona({
      entries: [
        mkEntry({ statement: "用 TypeScript", kind: "preference" }),
        mkEntry({ statement: "Lume 用 Markdown", kind: "fact" })
      ],
      providerFactory: fake
    });
    expect(captured).toContain("[preference]");
    expect(captured).toContain("用 TypeScript");
    expect(captured).toContain("[fact]");
    expect(captured).toContain("Lume 用 Markdown");
  });

  test("entry 含 claim 时附加到 prompt", async () => {
    let captured = "";
    const fake = async (prompt: string) => {
      captured = prompt;
      return "# x";
    };
    await generatePersona({
      entries: [
        mkEntry({
          statement: "叫我 Alice",
          kind: "preference",
          claim: { subject: "user/self", predicate: "preferred_name", object: "Alice" }
        })
      ],
      providerFactory: fake
    });
    expect(captured).toContain("preferred_name");
    expect(captured).toContain("Alice");
  });

  test("entries 截断为 40 条", async () => {
    let captured = "";
    const fake = async (prompt: string) => {
      captured = prompt;
      return "# x";
    };
    const entries: MemoryV2Entry[] = [];
    for (let i = 0; i < 60; i++) {
      entries.push(mkEntry({ statement: `pref-${i}`, kind: "preference" }));
    }
    await generatePersona({ entries, providerFactory: fake });
    expect(captured).toContain("pref-39");
    expect(captured).not.toContain("pref-40");
  });

  test("剥离 markdown 围栏 + 定位首个 #", async () => {
    const fake = async () =>
      "```markdown\n# 用户画像\n## 一句话定位\n开发者\n```";
    const md = await generatePersona({ entries: [], providerFactory: fake });
    expect(md).toContain("# 用户画像");
    expect(md).not.toContain("```");
  });

  test("LLM 前置噪声文本仍能定位首个 #", async () => {
    const fake = async () => "好的，这是画像：\n```md\n# 用户画像\n## 一句话定位\n开发者\n```";
    const md = await generatePersona({ entries: [], providerFactory: fake });
    expect(md.startsWith("# 用户画像")).toBe(true);
    expect(md).not.toContain("```");
  });

  test("provider 抛错 → 传播（caller 捕获）", async () => {
    const fake = async () => {
      throw new Error("network down");
    };
    await expect(
      generatePersona({ entries: [], providerFactory: fake })
    ).rejects.toThrow("network down");
  });
});

describe("ensurePersona", () => {
  test("无 persona + LLM 可用 → 生成（state 1）", async () => {
    const provider = async () => "# 用户画像\n## 一句话定位\n开发者";
    await ensurePersona({ scope: "global", providerFactory: provider });
    expect(readPersonaRaw("global")).toContain("一句话定位");
  });

  test("有 persona + LLM 可用 → 增量合并（existing 注入 prompt）（state 2）", async () => {
    writePersona("global", undefined, "旧画像内容");
    let capturedPrompt = "";
    const provider = async (p: string) => {
      capturedPrompt = p;
      return "# 用户画像\n## 一句话定位\n新";
    };
    await ensurePersona({ scope: "global", providerFactory: provider });
    expect(capturedPrompt).toContain("旧画像内容");
    expect(readPersonaRaw("global")).toContain("新");
  });

  test("LLM 失败 → 规则兜底（fail-open，不抛）（state 3）", async () => {
    const provider = async () => {
      throw new Error("no llm configured");
    };
    await ensurePersona({ scope: "global", providerFactory: provider });
    const md = readPersonaRaw("global");
    expect(md).toContain("用户画像"); // buildPersonaFromRules 兜底产出
  });

  test("scope 默认 global（未传 scope/workspaceSlug）", async () => {
    const provider = async () => "# 用户画像\n## 一句话定位\n默认";
    await ensurePersona({ providerFactory: provider });
    expect(readPersonaRaw("global")).toContain("默认");
  });

  test("activation.persona=false 的条目不进 persona 生成", async () => {
    const store = createMemoryV2Store();
    const visible = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "persona-visible prefers dark mode",
      confidence: "high"
    });
    const suppressed = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "persona-suppressed prefers light mode",
      confidence: "high"
    });
    writeMarkdownDocument(suppressed.path, {
      ...suppressed.frontmatter,
      activation: { ...DEFAULT_ACTIVATION, persona: false }
    }, suppressed.statement);

    let capturedPrompt = "";
    const provider = async (prompt: string) => {
      capturedPrompt = prompt;
      return "# 用户画像\n## 一句话定位\nx";
    };
    await ensurePersona({ scope: "global", providerFactory: provider });

    expect(capturedPrompt).toContain("persona-visible");
    expect(capturedPrompt).not.toContain("persona-suppressed");
  });
});
