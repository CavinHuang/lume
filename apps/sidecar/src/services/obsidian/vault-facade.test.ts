import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVaultFileSystem } from "./vault-facade";

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("vault-facade", () => {
  function makeVault(): string {
    const root = mkdtempSync(join(tmpdir(), "lume-vault-facade-"));
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "a.md"), "# A\n\n[[b]]", "utf-8");
    writeFileSync(join(root, "notes", "b.md"), "# B", "utf-8");
    writeFileSync(join(root, "root-note.md"), "# Root", "utf-8");
    writeFileSync(join(root, "ignored.txt"), "not markdown", "utf-8");
    return root;
  }

  test("listFiles 只列 Markdown、跳过隐藏目录并按路径排序", () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const list = fs.listFiles();
      expect(list.map((entry) => entry.relativePath)).toEqual([
        "notes/a.md",
        "notes/b.md",
        "root-note.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readFile 返回内容与 sha256；writeFile 按预期版本写入", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const read = fs.readFile("notes/a.md");
      expect(read.content).toBe("# A\n\n[[b]]");
      expect(read.sha256).toHaveLength(64);

      const written = await fs.writeFile({ relativePath: "notes/a.md", content: "# A2", expectedSha256: read.sha256 });
      expect(written.ok).toBe(true);
      expect(fs.readFile("notes/a.md").content).toBe("# A2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeFile 版本冲突返回 conflict 而不落盘", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const result = await fs.writeFile({ relativePath: "notes/a.md", content: "stale", expectedSha256: "deadbeef" });
      expect(result).toEqual({
        ok: false,
        reason: "conflict",
        currentSha256: fs.readFile("notes/a.md").sha256,
        currentModifiedAt: fs.readFile("notes/a.md").modifiedAt,
      });
      expect(fs.readFile("notes/a.md").content).toBe("# A\n\n[[b]]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("拒绝绝对路径、上级目录、隐藏目录与非 Markdown 目标", () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      expect(() => fs.readFile("../outside.md")).toThrow();
      expect(() => fs.readFile("C:/evil.md")).toThrow();
      expect(() => fs.readFile("notes/../notes/a.md")).toThrow();
      expect(() => fs.readFile(".obsidian/app.json")).toThrow();
      expect(() => fs.readFile("notes/recipe.txt")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("拒绝经由软链接的访问（平台不允许建链时跳过）", () => {
    const root = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "lume-vault-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "secret", "utf-8");
      let linked = true;
      try {
        symlinkSync(join(outside, "secret.md"), join(root, "leak.md"));
      } catch {
        // Windows 无开发者模式/管理员权限时 symlinkSync 报 EPERM：语义已由
        // 路径检查覆盖，此处仅跳过建链断言。
        linked = false;
      }
      const fs = createVaultFileSystem(root);
      if (linked) {
        expect(() => fs.readFile("leak.md")).toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("对不存在的文件携带 expectedSha256 写入直接拒绝", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      expect(fs.listFiles().some((entry) => entry.relativePath === "ghost.md")).toBe(false);
      await expect(fs.writeFile({ relativePath: "ghost.md", content: "x", expectedSha256: "deadbeef" })).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createUntitledNote 独占创建、同名自动递增", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const now = new Date(2026, 7, 29);
      const first = await fs.createUntitledNote("notes", "hello", now);
      expect(first.ok && first.relativePath).toBe(`notes/Untitled ${formatLocalDate(now)}.md`);
      const second = await fs.createUntitledNote("notes", "hello", now);
      expect(second.ok && second.relativePath).toBe(`notes/Untitled ${formatLocalDate(now)} 2.md`);
      expect(readFileSync(join(root, "notes", `Untitled ${formatLocalDate(now)}.md`), "utf-8")).toBe("hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createFolder 要求父目录存在且拒绝重复创建", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      expect(() => fs.createFolder("missing/child")).toThrow();
      fs.createFolder("notes/sub");
      expect(() => fs.createFolder("notes/sub")).toThrow();
      expect((await fs.createUntitledNote("notes/sub")).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renameFile 同目录重命名、自动补 .md、拒绝同名冲突", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const renamed = fs.renameFile({ relativePath: "notes/a.md", name: "renamed" });
      expect(renamed.relativePath).toBe("notes/renamed.md");
      expect(() => fs.renameFile({ relativePath: "notes/b.md", name: "renamed" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renameFile 外部修改后拒绝重命名", () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      expect(() => fs.renameFile({ relativePath: "notes/a.md", name: "x", expectedSha256: "deadbeef" })).toThrow("外部修改");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleteFile 校验 sha256 后删除", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const read = fs.readFile("notes/b.md");
      expect(() => fs.deleteFile({ relativePath: "notes/b.md", expectedSha256: "deadbeef" })).toThrow("外部修改");
      fs.deleteFile({ relativePath: "notes/b.md", expectedSha256: read.sha256 });
      expect(fs.listFiles().some((entry) => entry.relativePath === "notes/b.md")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("超过 2MB 的写入被拒绝", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const huge = "x".repeat(2 * 1024 * 1024 + 1);
      await expect(fs.writeFile({ relativePath: "huge.md", content: huge })).rejects.toThrow("2 MB");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
