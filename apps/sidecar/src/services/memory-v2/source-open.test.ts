import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryV2Store } from "./markdown-store";
import { openMemoryV2Source } from "./source-open";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-open-"));
  outside = mkdtempSync(join(tmpdir(), "lume-memory-v2-outside-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("memory-v2 source open", () => {
  test("rejects missing memory source paths", () => {
    expect(() => openMemoryV2Source({
      workspaceSlug: "demo",
      path: join(root, "missing.md")
    })).toThrow("记忆来源不存在");
  });

  test("rejects paths outside Memory V2 roots", () => {
    createMemoryV2Store().ensureMemoryFile("workspace", "demo");
    const outsideFile = join(outside, "note.md");
    writeFileSync(outsideFile, "outside", "utf-8");

    expect(() => openMemoryV2Source({
      workspaceSlug: "demo",
      path: outsideFile
    })).toThrow("记忆来源路径超出 Memory V2 目录");
  });
});
