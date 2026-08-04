import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildPersonaFromRules,
  deletePersona,
  getPersonaPath,
  parsePersonaProfile,
  readPersonaRaw,
  resetPersonaStoreForTest,
  writePersona
} from "./persona";
import type { MemoryV2Entry } from "./types";

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
