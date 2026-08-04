import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deletePersona,
  getPersonaPath,
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
