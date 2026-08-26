import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupCorruptFile } from "./corrupt-file-backup";

describe("backupCorruptFile", () => {
  test("改名保留现场并返回备份路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-corrupt-backup-"));
    try {
      const filePath = join(dir, "store.json");
      writeFileSync(filePath, "{broken", "utf-8");

      const backupPath = backupCorruptFile(filePath);

      expect(backupPath).toBeString();
      expect(existsSync(backupPath!)).toBeTrue();
      expect(readFileSync(backupPath!, "utf-8")).toBe("{broken");
      // 原位置已被改名移走（调用方随后重建空文件不覆盖备份）
      expect(existsSync(filePath)).toBeFalse();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("快速连续两代损坏各自获得独立备份，同毫秒不再互相覆盖(#686 同族)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-corrupt-backup-gen-"));
    try {
      const filePath = join(dir, "store.json");

      writeFileSync(filePath, "{gen-1", "utf-8");
      const first = backupCorruptFile(filePath);
      writeFileSync(filePath, "{gen-2", "utf-8");
      const second = backupCorruptFile(filePath);

      expect(first).toBeString();
      expect(second).toBeString();
      expect(first).not.toBe(second);
      const names = readdirSync(dir);
      expect(names).toHaveLength(2);
      // 两代内容都在：纯 Date.now() 命名下同毫秒第二次 rename 会覆盖第一次
      expect(names.filter((name) => name.includes("{gen-1") || readFileSync(join(dir, name), "utf-8") === "{gen-1").length).toBe(1);
      expect(names.map((name) => readFileSync(join(dir, name), "utf-8")).sort()).toEqual(["{gen-1", "{gen-2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件不存在返回 null 且不创建任何东西", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-corrupt-backup-miss-"));
    try {
      expect(backupCorruptFile(join(dir, "missing.json"))).toBeNull();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
