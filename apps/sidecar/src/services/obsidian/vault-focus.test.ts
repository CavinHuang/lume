import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { getLumeConfigYamlPath } from "../infra/config-paths";
import { clearObsidianVaultFocus, getObsidianVaultFocus, setObsidianVaultFocus } from "./vault-focus";

describe("vault-focus", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";
  let vault = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-vault-focus-config-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    vault = mkdtempSync(join(tmpdir(), "lume-vault-focus-vault-"));
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(join(vault, "notes", "a.md"), "# A", "utf-8");
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({ version: 2, obsidian: { enabled: true, extraVaults: [vault] } }), "utf-8");
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  });

  test("设置后可读回，文件路径规范化", () => {
    setObsidianVaultFocus("t1", vault, { kind: "file", relativePath: "notes/a.md", sequence: 3 });
    const snapshot = getObsidianVaultFocus("t1");
    expect(snapshot?.focus).toEqual({ kind: "file", relativePath: "notes/a.md", sequence: 3 });
    expect(snapshot?.vaultPath).toBe(vault);
    expect(snapshot?.displayName).toBeTruthy();
  });

  test("更低序列号视为过期 IPC 被丢弃", () => {
    setObsidianVaultFocus("t2", vault, { kind: "file", relativePath: "notes/a.md", sequence: 5 });
    setObsidianVaultFocus("t2", vault, { kind: "file", relativePath: "notes/a.md", sequence: 4 });
    expect(getObsidianVaultFocus("t2")?.focus.sequence).toBe(5);
    setObsidianVaultFocus("t2", vault, { kind: "folder", relativePath: "notes", sequence: 6 });
    expect(getObsidianVaultFocus("t2")?.focus).toEqual({ kind: "folder", relativePath: "notes", sequence: 6 });
  });

  test("目标不存在时拒绝写入", () => {
    expect(() => setObsidianVaultFocus("t3", vault, { kind: "file", relativePath: "notes/ghost.md", sequence: 1 })).toThrow();
  });

  test("vault 失去授权后 focus 自动失效并清理", () => {
    setObsidianVaultFocus("t4", vault, { kind: "file", relativePath: "notes/a.md", sequence: 1 });
    expect(getObsidianVaultFocus("t4")).not.toBeNull();
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({ version: 2, obsidian: { enabled: false, extraVaults: [vault] } }), "utf-8");
    expect(getObsidianVaultFocus("t4")).toBeNull();
    // 再设置同样被拒绝：集成关闭期间不允许新 focus。
    expect(() => setObsidianVaultFocus("t4", vault, { kind: "file", relativePath: "notes/a.md", sequence: 2 })).toThrow();
  });

  test("clearObsidianVaultFocus 清理会话状态", () => {
    setObsidianVaultFocus("t5", vault, { kind: "file", relativePath: "notes/a.md", sequence: 1 });
    clearObsidianVaultFocus("t5");
    expect(getObsidianVaultFocus("t5")).toBeNull();
    // 清理后允许重新从任意序列号开始（新会话复用 id 的场景）。
    expect(() => setObsidianVaultFocus("t5", vault, { kind: "file", relativePath: "notes/a.md", sequence: 0 })).not.toThrow();
  });
});
