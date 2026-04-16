import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectMarkdownFiles, isMemoryPath } from "./memory-path-utils";

describe("memory-path-utils", () => {
  test("isMemoryPath 应仅接受 MEMORY.md / memory/YYYY-MM-DD.md", () => {
    expect(isMemoryPath("MEMORY.md")).toBeTrue();
    expect(isMemoryPath("memory/2026-02-15.md")).toBeTrue();
    expect(isMemoryPath("memory/daily/2026-02-15.md")).toBeFalse();
    expect(isMemoryPath("memory.md")).toBeFalse();
    expect(isMemoryPath("notes.md")).toBeFalse();
  });

  test("collectMarkdownFiles 应跳过 symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-paths-"));
    const sub = join(root, "memory");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "a.md"), "ok", "utf-8");

    const linked = join(root, "linked-memory");
    symlinkSync(sub, linked);

    const files = collectMarkdownFiles(root).map((v) => v.replace(/\\/g, "/"));
    expect(files.some((v) => v.endsWith("/memory/a.md"))).toBeTrue();
    expect(files.some((v) => v.includes("linked-memory"))).toBeFalse();

    rmSync(root, { recursive: true, force: true });
  });
});
