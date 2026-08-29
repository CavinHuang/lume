/**
 * Obsidian Vault 注册表发现（移植自 Proma vault-service）：
 * Obsidian 的全局注册表是候选来源；发现即授权，全部候选都是 agent 的
 * 环境目录权限。注册表条目过期只作建议，绝不阻塞调用方。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import type { ObsidianVaultCandidate, ObsidianVaultConfig } from "@lume/shared";
import { getEffectiveLumeConfig } from "../system/lume-config-service";

export function defaultObsidianRegistryPaths(): string[] {
  if (platform() === "darwin") {
    return [join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json")];
  }
  if (platform() === "win32") {
    return [join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json")];
  }
  return [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian", "obsidian.json")];
}

export function assertVaultRoot(rootPath: string): string {
  const resolved = realpathSync(rootPath);
  if (!statSync(resolved).isDirectory()) {
    throw new Error("Vault 根路径不是目录");
  }
  return resolved;
}

function comparablePath(root: string): string {
  const resolved = realpathSync(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 读取 Obsidian 注册表产出候选；装了 Obsidian 才有 isObsidianVault=true 的条目。 */
export function discoverObsidianVaultCandidates(registryPaths: string[] = defaultObsidianRegistryPaths()): ObsidianVaultCandidate[] {
  const candidates = new Map<string, ObsidianVaultCandidate>();
  for (const configPath of registryPaths) {
    let raw: { vaults?: Record<string, { path?: unknown }> };
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8")) as { vaults?: Record<string, { path?: unknown }> };
    } catch {
      // Obsidian 可选；注册表缺失/损坏只意味着零候选。
      continue;
    }
    for (const vault of Object.values(raw.vaults ?? {})) {
      if (typeof vault.path !== "string" || !vault.path) continue;
      try {
        const root = assertVaultRoot(vault.path);
        candidates.set(comparablePath(root), {
          path: root,
          displayName: basename(root) || "Vault",
          isObsidianVault: existsSync(join(root, ".obsidian")),
        });
      } catch {
        // 过期注册表条目只作建议。
      }
    }
  }
  return [...candidates.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/** 发现候选 + extraVaults 的合并视图（enabled=false 时也返回，UI 需要展示全貌）。 */
export function getObsidianVaultConfig(registryPaths: string[] = defaultObsidianRegistryPaths()): ObsidianVaultConfig {
  const section = getEffectiveLumeConfig().obsidian;
  const extra = new Set(
    (section?.extraVaults ?? []).map((path) => {
      try {
        return comparablePath(path);
      } catch {
        return null;
      }
    }),
  );
  const candidates: ObsidianVaultCandidate[] = [];
  for (const candidate of discoverObsidianVaultCandidates(registryPaths)) {
    extra.delete(comparablePath(candidate.path));
    candidates.push(candidate);
  }
  for (const path of section?.extraVaults ?? []) {
    try {
      const root = assertVaultRoot(path);
      const key = comparablePath(root);
      if (!extra.has(key)) continue;
      extra.delete(key);
      candidates.push({ path: root, displayName: basename(root) || "Vault", isObsidianVault: existsSync(join(root, ".obsidian")), isManual: true });
    } catch {
      // 手动添加的目录已失效：保留占位会让 agent 拿到坏根，直接跳过。
    }
  }
  return { enabled: section?.enabled !== false, candidates };
}

/**
 * enabled 时全部候选根都是 agent 的环境目录权限（additionalDirectories）。
 * Windows 路径大小写不敏感去重；坏根静默剔除，绝不阻塞一次 agent 运行。
 */
export function resolveObsidianVaultDirectories(registryPaths: string[] = defaultObsidianRegistryPaths()): string[] {
  const config = getObsidianVaultConfig(registryPaths);
  if (!config.enabled) return [];
  const roots = new Map<string, string>();
  for (const candidate of config.candidates) {
    try {
      roots.set(comparablePath(candidate.path), candidate.path);
    } catch {
      // 候选在发现与消费之间消失：跳过。
    }
  }
  return [...roots.values()];
}

/** renderer 传入的 vaultPath 必须命中当前候选集；根路径从不信任渲染层。 */
export function resolveAuthorizedVaultRoot(vaultPath: string, registryPaths: string[] = defaultObsidianRegistryPaths()): string {
  const root = assertVaultRoot(vaultPath);
  const key = comparablePath(root);
  const config = getObsidianVaultConfig(registryPaths);
  if (!config.enabled) {
    throw new Error("Obsidian Vault 集成已关闭");
  }
  for (const candidate of config.candidates) {
    if (comparablePath(candidate.path) === key) return root;
  }
  throw new Error("Vault 未在授权列表中");
}
