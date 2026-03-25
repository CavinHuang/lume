import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getConfigDir } from "./config-paths";

describe("config-paths", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;
  const created: string[] = [];

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getConfigDir 应优先使用 LUME_CONFIG_DIR（绝对路径）", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-config-paths-"));
    created.push(dir);
    process.env.LUME_CONFIG_DIR = dir;

    expect(getConfigDir()).toBe(dir);
  });

  test("getConfigDir 应支持 LUME_CONFIG_DIR 相对路径并解析为绝对路径", () => {
    const rel = `.tmp-lume-config-${Date.now()}`;
    process.env.LUME_CONFIG_DIR = rel;

    const resolved = getConfigDir();
    expect(isAbsolute(resolved)).toBeTrue();
    expect(resolved.endsWith(rel)).toBeTrue();
    created.push(resolved);
  });
});
