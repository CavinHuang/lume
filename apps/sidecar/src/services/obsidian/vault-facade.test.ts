import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createVaultFileSystem } from "./vault-facade";

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 结构合法的最小 PNG：签名 + 13 字节 IHDR chunk + 空 IEND chunk，共 45 字节。 */
function makePngBase64(): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, "ascii");
  return Buffer.concat([signature, ihdr, iend]).toString("base64");
}

/** 仅有前缀魔数、缺少 chunk 结构的 PNG 字节：深度校验必须拒绝。 */
const PNG_SIGNATURE_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]).toString("base64");

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

  test("createUntitledNote 自动补齐收件夹父目录（inbox 语义）", async () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const result = await fs.createUntitledNote("Lume Inbox");
      expect(result.ok).toBe(true);
      const filename = result.ok ? result.relativePath.split("/").pop()! : "";
      expect(readFileSync(join(root, "Lume Inbox", filename), "utf-8")).toBe("");
      // 对齐 Proma：深层路径要求目标文件夹已存在，拼错路径不静默建树。
      await expect(fs.createUntitledNote("missing/deep")).rejects.toThrow("目标 Vault 文件夹不存在");
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

  test("resolveMedia 解析根内图片路径并拒绝越界", () => {
    const root = makeVault();
    try {
      writeFileSync(join(root, "notes", "pic.png"), "png-bytes", "utf-8");
      const fs = createVaultFileSystem(root);
      expect(fs.resolveMedia("notes/a.md", "pic.png")).toBe(realpathSync(join(root, "notes", "pic.png")));
      expect(fs.resolveMedia("notes/a.md", "./pic.png?v=1#frag")).toBe(realpathSync(join(root, "notes", "pic.png")));
      expect(fs.resolveMedia("notes/a.md", "../root-note.md")).toBe(realpathSync(join(root, "root-note.md")));
      expect(fs.resolveMedia("notes/a.md", "missing.png")).toBeNull();
      expect(fs.resolveMedia("notes/a.md", "../../outside.png")).toBeNull();
      expect(fs.resolveMedia("notes/a.md", "")).toBeNull();
      // file: 绝对 URL 经 fileURLToPath 归一化后须在 Windows 同样可解析。
      expect(fs.resolveMedia("notes/a.md", `${pathToFileURL(join(root, "notes", "pic.png")).href}?v=1`)).toBe(realpathSync(join(root, "notes", "pic.png")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("savePastedImage 落盘笔记同目录 assets 并校验图片结构", () => {
    const root = makeVault();
    try {
      const fs = createVaultFileSystem(root);
      const pngBase64 = makePngBase64();
      const saved = fs.savePastedImage({ noteRelativePath: "notes/a.md", mimeType: "image/png", base64: pngBase64 });
      expect(saved.src?.startsWith("assets/pasted-image-") && saved.src.endsWith(".png")).toBe(true);
      expect(statSync(join(root, "notes", saved.src!)).size).toBe(45);

      // 声明 MIME 与图片结构不符时拒绝：仅前缀魔数、深度结构不完整、类型错标。
      expect(fs.savePastedImage({ noteRelativePath: "notes/a.md", mimeType: "image/png", base64: PNG_SIGNATURE_BASE64 })).toEqual({ src: null });
      expect(fs.savePastedImage({ noteRelativePath: "notes/a.md", mimeType: "image/gif", base64: pngBase64 })).toEqual({ src: null });
      expect(fs.savePastedImage({ noteRelativePath: "notes/a.md", mimeType: "image/png", base64: Buffer.from("not-an-image").toString("base64") })).toEqual({ src: null });

      const rootSaved = fs.savePastedImage({ noteRelativePath: "root-note.md", mimeType: "image/png", base64: pngBase64 });
      expect(rootSaved.src?.startsWith("assets/")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
