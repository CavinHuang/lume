import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deletePersona,
  getPersonaPath,
  parsePersonaProfile,
  readPersonaRaw,
  resetPersonaStoreForTest,
  writePersona
} from "./persona";

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
