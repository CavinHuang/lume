import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { getLumeConfigYamlPath } from "../infra/config-paths";
import { discoverObsidianVaultCandidates, getObsidianVaultConfig, resolveAuthorizedVaultRoot, resolveObsidianVaultDirectories } from "./vault-registry";

function makeVaultDir(withObsidianDir: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "lume-vault-registry-"));
  if (withObsidianDir) mkdirSync(join(root, ".obsidian"), { recursive: true });
  return root;
}

function writeRegistry(path: string, vaultPaths: string[]): void {
  writeFileSync(path, JSON.stringify({ vaults: Object.fromEntries(vaultPaths.map((vaultPath, index) => [`hash-${index}`, { path: vaultPath, ts: index }])) }), "utf-8");
}

describe("vault-registry", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";
  let created: string[] = [];

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-vault-registry-config-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
    for (const path of created) rmSync(path, { recursive: true, force: true });
    created = [];
  });

  function trackVault(withObsidianDir: boolean): string {
    const path = makeVaultDir(withObsidianDir);
    created.push(path);
    return path;
  }

  test("注册表解析：有效条目入选、过期条目剔除、.obsidian 标记真实 vault", () => {
    const real = trackVault(true);
    const plain = trackVault(false);
    const registry = join(tempConfigDir, "obsidian.json");
    writeRegistry(registry, [real, plain, join(tempConfigDir, "gone")]);

    const candidates = discoverObsidianVaultCandidates([registry]);
    expect(candidates.map((candidate) => candidate.path).sort()).toEqual([plain, real].sort());
    expect(candidates.find((candidate) => candidate.path === real)?.isObsidianVault).toBe(true);
    expect(candidates.find((candidate) => candidate.path === plain)?.isObsidianVault).toBe(false);
  });

  test("注册表缺失或损坏时返回零候选而不抛错", () => {
    expect(discoverObsidianVaultCandidates([join(tempConfigDir, "missing.json")])).toEqual([]);
    const broken = join(tempConfigDir, "broken.json");
    writeFileSync(broken, "{not json", "utf-8");
    expect(discoverObsidianVaultCandidates([broken])).toEqual([]);
  });

  test("getObsidianVaultConfig 合并托管/发现/手动三层、enabled 门控 agent 目录", () => {
    const discovered = trackVault(true);
    const manual = trackVault(false);
    const registry = join(tempConfigDir, "obsidian.json");
    writeRegistry(registry, [discovered]);
    const yamlPath = getLumeConfigYamlPath();
    writeFileSync(yamlPath, YAML.stringify({ version: 2, obsidian: { enabled: true, extraVaults: [manual] } }), "utf-8");

    // 托管 Vault 目录存在即入列（isManaged 标记），与手动添加同路径时去重。
    const managed = join(tempConfigDir, "vaults", "default");
    mkdirSync(managed, { recursive: true });

    const merged = getObsidianVaultConfig([registry]);
    expect(merged.enabled).toBe(true);
    expect(merged.candidates.map((candidate) => candidate.path).sort()).toEqual([discovered, manual, managed].sort());
    expect(merged.candidates.find((candidate) => candidate.path === managed)?.isManaged).toBe(true);
    expect(merged.candidates.find((candidate) => candidate.path === manual)?.isManual).toBe(true);

    expect(resolveObsidianVaultDirectories([registry]).sort()).toEqual([discovered, manual, managed].sort());

    writeFileSync(yamlPath, YAML.stringify({ version: 2, obsidian: { enabled: false, extraVaults: [manual] } }), "utf-8");
    expect(resolveObsidianVaultDirectories([registry])).toEqual([]);
    expect(getObsidianVaultConfig([registry]).enabled).toBe(false);
  });

  test("resolveAuthorizedVaultRoot 拒绝未授权与集成关闭状态", () => {
    const manual = trackVault(false);
    const outsider = trackVault(false);
    const registry = join(tempConfigDir, "obsidian.json");
    const yamlPath = getLumeConfigYamlPath();
    writeFileSync(yamlPath, YAML.stringify({ version: 2, obsidian: { enabled: true, extraVaults: [manual] } }), "utf-8");
    expect(resolveAuthorizedVaultRoot(manual, [registry])).toBe(manual);
    expect(() => resolveAuthorizedVaultRoot(outsider, [registry])).toThrow("未在授权列表");

    writeFileSync(yamlPath, YAML.stringify({ version: 2, obsidian: { enabled: false, extraVaults: [manual] } }), "utf-8");
    expect(() => resolveAuthorizedVaultRoot(manual, [registry])).toThrow("已关闭");
  });
});
