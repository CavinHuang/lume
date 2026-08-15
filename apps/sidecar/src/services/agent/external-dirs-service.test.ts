import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AttachmentScope } from "./agent-attachment-meta-service";
import {
  listExternalDirEntries,
  listExternalDirs,
  removeExternalDir,
  upsertExternalDir
} from "./external-dirs-service";

const createdDirs: string[] = [];
const originalConfigDir = process.env.LUME_CONFIG_DIR;

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lume-external-dirs-"));
  createdDirs.push(dir);
  process.env.LUME_CONFIG_DIR = dir;
  return dir;
}

function createTempSourceDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.LUME_CONFIG_DIR = originalConfigDir;
});

describe("external-dirs-service", () => {
  test("upsert/list/remove 双作用域读写与去重", () => {
    const configDir = createTempConfigDir();
    const sourceRoot = createTempSourceDir("lume-external-source-");
    const threadScope: AttachmentScope = { kind: "thread", workspaceSlug: "ws", threadId: "thread-a" };
    const workspaceScope: AttachmentScope = { kind: "workspace", workspaceSlug: "ws" };
    const docsDir = join(sourceRoot, "docs");
    const assetsDir = join(sourceRoot, "assets");
    mkdirSync(docsDir);
    mkdirSync(assetsDir);

    upsertExternalDir(threadScope, docsDir);
    upsertExternalDir(workspaceScope, assetsDir);

    const threadDirs = listExternalDirs(threadScope);
    expect(threadDirs).toHaveLength(1);
    expect(threadDirs[0]).toMatchObject({ absolutePath: docsDir, available: true });
    expect(threadDirs[0]!.attachedAt).toBeString();
    expect(listExternalDirs(workspaceScope).map((entry) => entry.absolutePath)).toEqual([assetsDir]);

    // 同 path 二次 upsert 只留一条，attachedAt 刷新
    const metadataPath = join(configDir, "agent-workspaces", "ws", "threads", "thread-a", ".context", "external-dirs.json");
    const stale = JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<string, { attachedAt: string }>;
    for (const value of Object.values(stale)) {
      value.attachedAt = "2000-01-01T00:00:00.000Z";
    }
    writeFileSync(metadataPath, JSON.stringify(stale), "utf-8");
    upsertExternalDir(threadScope, join(docsDir));
    const afterReupsert = listExternalDirs(threadScope);
    expect(afterReupsert).toHaveLength(1);
    expect(afterReupsert[0]!.attachedAt).not.toBe("2000-01-01T00:00:00.000Z");

    // 物理目录消失后 available 翻转为 false
    const goneDir = join(sourceRoot, "gone");
    mkdirSync(goneDir);
    upsertExternalDir(threadScope, goneDir);
    rmSync(goneDir, { recursive: true });
    expect(listExternalDirs(threadScope).find((entry) => entry.absolutePath === goneDir)?.available).toBeFalse();
  });

  test("upsert 拒绝非目录与不存在路径", () => {
    createTempConfigDir();
    const sourceRoot = createTempSourceDir("lume-external-source-");
    const scope: AttachmentScope = { kind: "workspace", workspaceSlug: "ws" };
    writeFileSync(join(sourceRoot, "file.txt"), "hello", "utf-8");
    const targetDir = join(sourceRoot, "target");
    mkdirSync(targetDir);
    symlinkSync(targetDir, join(sourceRoot, "link"), "junction");

    expect(() => upsertExternalDir(scope, join(sourceRoot, "file.txt"))).toThrow("只能附加目录");
    expect(() => upsertExternalDir(scope, join(sourceRoot, "missing"))).toThrow("不存在");
    expect(() => upsertExternalDir(scope, join(sourceRoot, "link"))).toThrow("符号链接");
    expect(listExternalDirs(scope)).toEqual([]);
  });

  test("remove 不动物理目录", () => {
    createTempConfigDir();
    const sourceRoot = createTempSourceDir("lume-external-source-");
    const scope: AttachmentScope = { kind: "thread", workspaceSlug: "ws", threadId: "thread-b" };
    const docsDir = join(sourceRoot, "docs");
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, "note.txt"), "note", "utf-8");

    upsertExternalDir(scope, docsDir);
    removeExternalDir(scope, docsDir);

    expect(listExternalDirs(scope)).toEqual([]);
    expect(existsSync(docsDir)).toBeTrue();
    expect(existsSync(join(docsDir, "note.txt"))).toBeTrue();
  });

  test("listExternalDirEntries 单层只读", () => {
    createTempConfigDir();
    const sourceRoot = createTempSourceDir("lume-external-source-");
    const root = join(sourceRoot, "root");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "hello", "utf-8");
    writeFileSync(join(root, "sub", "inner.txt"), "inner", "utf-8");
    symlinkSync(join(root, "sub"), join(root, "link"), "junction");

    const entries = listExternalDirEntries(root);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("sub");
    expect(names).not.toContain("link");
    expect(names).not.toContain("inner.txt");
    expect(entries.find((entry) => entry.name === "a.txt")).toMatchObject({
      isDirectory: false,
      size: 5
    });
    expect(entries.find((entry) => entry.name === "a.txt")?.modifiedAt).toBeString();
    expect(entries.find((entry) => entry.name === "sub")?.isDirectory).toBeTrue();

    expect(() => listExternalDirEntries(join(root, "link"))).toThrow("符号链接");
    expect(() => listExternalDirEntries(join(root, "missing"))).toThrow("不存在");
  });
});
