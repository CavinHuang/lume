# 数据管理 设置页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lume 设置中新增「数据管理」tab，提供按类别的存储用量概览、统一清理（聚合现有 + 向量索引/插件缓存/清空回收站）、以及凭证默认脱敏的全量 zip 导出。

**Architecture:** 三层。Shared 定义数据类别扫描规范与类型；Sidecar 扩展现有 `clearCache` 机制（向量索引/插件缓存）并新增 `emptyTrash`；Rust 新增两个 Tauri 命令 `data_get_storage_stats`（递归求体积）与 `data_export_zip`（流式打 zip + JSON 脱敏，复用 `lume-logger` 的 `redact` 模块）。Web 新增 `DataManagementSettings` 页面（4 张卡片）并收敛清理入口（移除 `GeneralSettings` 的清理弹窗，改为跳转）。

**Tech Stack:** TypeScript（bun:test）、Tauri 2 / Rust（`zip`、`walkdir`、`serde_json`、`lume-logger`）、React + jotai + lucide、base-ui。

参考设计文档：`docs/superpowers/specs/2026-06-15-data-management-settings-design.md`

---

## File Structure

**Shared（`packages/shared`）**
- Create: `packages/shared/src/types/data-management.ts` — 数据类别元信息、扫描规范、清理键扩展、结果类型。
- Modify: `packages/shared/src/types/index.ts` — 导出新模块。
- Modify: `packages/shared/src/types/general-settings.ts` — 扩展 `clearCacheInputSchema` 相关（见 Task 3，实际 schema 在 sidecar `schemas.ts`）。

**Sidecar（`apps/sidecar`）**
- Modify: `apps/sidecar/src/services/infra/config-paths.ts` — 新增插件/向量索引路径函数。
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts` — 扩展 `clearGeneralSettingsCaches` 支持向量索引/插件缓存。
- Modify: `apps/sidecar/src/rpc/schemas.ts` — 扩展 `clearCacheInputSchema`。
- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts` — 新增 `emptyTrash`。
- Modify: `packages/shared/src/types/agent.ts` — 新增 `EMPTY_TRASH` 通道。
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts` — 新增 `EMPTY_TRASH` handler。
- Create: `apps/sidecar/src/services/system/general-settings-service.test.ts` —（若不存在）清理逻辑测试。

**Rust（`apps/desktop/src-tauri` + `crates/lume-logger`）**
- Modify: `crates/lume-logger/src/config.rs` — 新增 `pub fn resolve_config_dir()`。
- Modify: `apps/desktop/src-tauri/Cargo.toml` — 加 `zip`、`walkdir`。
- Modify: `apps/desktop/src-tauri/src/main.rs` — 新增 `data_get_storage_stats`、`data_export_zip` 命令 + 注册。

**Web（`apps/web`）**
- Create: `apps/web/src/lib/desktop-api/data.ts` — RPC/Tauri 包装。
- Modify: `apps/web/src/lib/desktop-api/system.ts` — `clearCache` 透传新键。
- Modify: `apps/web/src/lib/desktop-api/index.ts` — 导出 `./data`。
- Create: `apps/web/src/components/settings/data-management-state.ts` — 清理选项、默认选择、格式化。
- Create: `apps/web/src/components/settings/data-management-state.test.ts` — 状态测试。
- Create: `apps/web/src/components/settings/DataManagementSettings.tsx` — 4 卡片主组件。
- Modify: `apps/web/src/components/settings/settings-view-state.ts` — 新增 `data` tab。
- Modify: `apps/web/src/components/settings/SettingsView.tsx` — 渲染分支。
- Modify: `apps/web/src/components/settings/GeneralSettings.tsx` — 清理入口收敛为跳转。
- Delete: `apps/web/src/components/settings/ClearCacheDialog.tsx` — 不再使用。

---

## Task 1: Shared 类型与扫描规范

**Files:**
- Create: `packages/shared/src/types/data-management.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: 创建 `data-management.ts`**

```typescript
// packages/shared/src/types/data-management.ts

/** 数据类别 key（与概览 4 大类对应） */
export type DataCategoryKey = "core" | "derived" | "business" | "config";

/** 清理键：复用现有 frontendTemp/previewRender/logs，新增 vectorIndex/pluginsCache */
export type DataCleanupKey =
  | "frontendTemp"
  | "previewRender"
  | "logs"
  | "vectorIndex"
  | "pluginsCache";

/** 单个数据类别的展示元信息 */
export interface DataCategoryMeta {
  key: DataCategoryKey;
  label: string;
  subtitle: string;
  /** 是否可重建（决定清理是否需要强确认） */
  rebuildable: boolean;
  /** 是否含敏感凭证（影响导出提示） */
  sensitive: boolean;
}

/** 单个类别的扫描规范：相对 ~/.lume 的路径，可含 `*` 通配（workspace 展开） */
export interface DataCategoryScanSpec {
  key: DataCategoryKey;
  /** 要扫描的相对路径（目录或文件），支持 `agent-workspaces/*/...` 通配 */
  scanPaths: string[];
  /** 扫描时要排除的相对路径（避免核心/派生重复计数，如核心 memory 排除 memory/index） */
  skipSubdirs: string[];
}

/** 单个类别的体积统计结果 */
export interface DataCategoryStat {
  key: DataCategoryKey;
  bytes: number;
}

/** 存储统计命令返回 */
export interface StorageStats {
  total: number;
  /** 数据根目录绝对路径（~/.lume），供 UI 展示与「打开目录」使用 */
  configDir: string;
  categories: DataCategoryStat[];
}

/** 导出 zip 命令入参 */
export interface ExportZipInput {
  /** 用户通过 Tauri 存框选择的目标绝对路径 */
  destPath: string;
  /** 是否包含凭证；false 时对所有 .json 做脱敏 */
  includeCredentials: boolean;
}

/** 导出 zip 命令返回 */
export interface ExportZipResult {
  path: string;
  bytes: number;
  fileCount: number;
  credentialsStripped: boolean;
}

/** 清空回收站返回 */
export interface EmptyTrashResult {
  cleanedCount: number;
}

export const DATA_CATEGORY_META: DataCategoryMeta[] = [
  {
    key: "core",
    label: "核心数据",
    subtitle: "记忆 · 会话 · 工作区（不可重建）",
    rebuildable: false,
    sensitive: false,
  },
  {
    key: "derived",
    label: "派生数据",
    subtitle: "向量索引 · 缓存 · 日志（可重建）",
    rebuildable: true,
    sensitive: false,
  },
  {
    key: "business",
    label: "业务数据",
    subtitle: "读书 · 自动化 · 日程",
    rebuildable: false,
    sensitive: false,
  },
  {
    key: "config",
    label: "配置",
    subtitle: "settings · channels · im 等（含凭证）",
    rebuildable: false,
    sensitive: true,
  },
];

/**
 * 扫描规范：顺序即展示顺序。路径相对 ~/.lume。
 * 核心与派生在 memory 上有重叠，故核心 memory 扫描时 skip 掉 memory/index；
 * workspace 同理。`*` 由 Rust 扫描时展开为 agent-workspaces 下的每个子目录。
 */
export const DATA_CATEGORY_SCAN_SPEC: DataCategoryScanSpec[] = [
  {
    key: "core",
    scanPaths: [
      "memory",
      "MEMORY.md",
      ".meta/memory.sqlite",
      "agent/sessions",
      "agent/runtime-core",
      "agent-workspaces/*/threads",
      "agent-workspaces/*/resources",
      "agent-workspaces/*/memory",
      "agent-workspaces/*/MEMORY.md",
      "agent-workspaces/*/.meta/memory.sqlite",
    ],
    skipSubdirs: ["memory/index", "agent-workspaces/*/memory/index"],
  },
  {
    key: "derived",
    scanPaths: [
      "memory/index",
      "agent-workspaces/*/memory/index",
      "plugins/cache",
      "plugins/data",
      "logs",
      "cache",
    ],
    skipSubdirs: [],
  },
  {
    key: "business",
    scanPaths: ["reading", "routine", "automation"],
    skipSubdirs: [],
  },
  {
    key: "config",
    scanPaths: [
      "settings.json",
      "channels.json",
      "im.json",
      "im-thread-bindings.json",
      "lume.yaml",
      "lume.json",
      "user-profile.json",
      "agent-sessions.json",
      "agent-workspaces.json",
      "session-states.json",
      "skills",
      "default-skills",
    ],
    skipSubdirs: [],
  },
];
```

- [ ] **Step 2: 在 `types/index.ts` 末尾追加导出**

在 `packages/shared/src/types/index.ts` 末尾（`export * from "./info-extract";` 之后）追加：

```typescript
export * from "./data-management";
```

- [ ] **Step 3: 验证 shared 构建通过**

Run: `cd packages/shared && bun run typecheck 2>&1 || bunx tsc --noEmit -p . 2>&1 | head -20`
Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/data-management.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): 新增数据管理类型、扫描规范与 IPC 通道"
```

---

## Task 2: config-paths 新增插件/向量索引路径函数

**Files:**
- Modify: `apps/sidecar/src/services/infra/config-paths.ts`

- [ ] **Step 1: 在 `getRoutineRunsPath()` 之后追加路径函数**

在 `apps/sidecar/src/services/infra/config-paths.ts` 文件末尾追加：

```typescript
export function getPluginsCacheDir(): string {
  return ensureDir(join(getConfigDir(), "plugins", "cache"), "插件缓存目录");
}

export function getPluginsDataDir(): string {
  return ensureDir(join(getConfigDir(), "plugins", "data"), "插件数据目录");
}

/** 全局向量索引目录（~/.lume/memory/index） */
export function getGlobalVectorIndexDir(): string {
  return ensureDir(join(getStructuredMemoryDir(), "index"), "全局向量索引目录");
}

/** 工作区向量索引目录（agent-workspaces/<slug>/memory/index） */
export function getWorkspaceVectorIndexDir(workspaceSlug: string): string {
  return ensureDir(join(getWorkspaceMemoryDir(workspaceSlug), "index"), "工作区向量索引目录");
}
```

- [ ] **Step 2: 验证 sidecar 类型检查**

Run: `cd apps/sidecar && bun run typecheck 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/services/infra/config-paths.ts
git commit -m "feat(sidecar): config-paths 新增插件缓存/向量索引路径函数"
```

---

## Task 3: 扩展 clearCache 支持向量索引与插件缓存

**Files:**
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`
- Create: `apps/sidecar/src/services/system/general-settings-service.test.ts`

- [ ] **Step 1: 写失败测试 `general-settings-service.test.ts`**

```typescript
// apps/sidecar/src/services/system/general-settings-service.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CONFIG_DIR = process.env.LUME_CONFIG_DIR;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "lume-clearcache-"));
  process.env.LUME_CONFIG_DIR = dir;
  // 复制结构：memory/index、plugins/cache、plugins/data、logs
  mkdirSync(join(dir, "memory", "index"), { recursive: true });
  writeFileSync(join(dir, "memory", "index", "vector-index.json"), "{}");
  mkdirSync(join(dir, "plugins", "cache"), { recursive: true });
  writeFileSync(join(dir, "plugins", "cache", "p.json"), "{}");
  mkdirSync(join(dir, "plugins", "data"), { recursive: true });
  writeFileSync(join(dir, "plugins", "data", "p.json"), "{}");
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "logs", "lume.ndjson"), "{}\n");
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) {
    delete process.env.LUME_CONFIG_DIR;
  } else {
    process.env.LUME_CONFIG_DIR = ORIG_CONFIG_DIR;
  }
});

describe("clearGeneralSettingsCaches", () => {
  test("vectorIndex 清理全局 memory/index", async () => {
    const { clearGeneralSettingsCaches } = await import("./general-settings-service");
    const result = clearGeneralSettingsCaches({ vectorIndex: true });
    expect(result.cleared).toContain("vectorIndex");
    expect(() => statSync(join(process.env.LUME_CONFIG_DIR!, "memory", "index", "vector-index.json"))).toThrow();
  });

  test("pluginsCache 清理 plugins/cache 与 plugins/data", async () => {
    const { clearGeneralSettingsCaches } = await import("./general-settings-service");
    const result = clearGeneralSettingsCaches({ pluginsCache: true });
    expect(result.cleared).toContain("pluginsCache");
    expect(() => statSync(join(process.env.LUME_CONFIG_DIR!, "plugins", "cache", "p.json"))).toThrow();
    expect(() => statSync(join(process.env.LUME_CONFIG_DIR!, "plugins", "data", "p.json"))).toThrow();
  });

  test("未选中的键不清理", async () => {
    const { clearGeneralSettingsCaches } = await import("./general-settings-service");
    const result = clearGeneralSettingsCaches({});
    expect(result.cleared).toEqual([]);
    expect(statSync(join(process.env.LUME_CONFIG_DIR!, "logs", "lume.ndjson")).size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/sidecar && bun test src/services/system/general-settings-service.test.ts 2>&1 | tail -15`
Expected: FAIL（vectorIndex/pluginsCache 键不存在，类型错误）。

- [ ] **Step 3: 扩展 `general-settings-service.ts`**

替换 `apps/sidecar/src/services/system/general-settings-service.ts` 中的类型与清理逻辑。

3a. 替换 import 块（第 16 行 `import { getConfigDir } from "../infra/config-paths";`）为：

```typescript
import {
  getConfigDir,
  getPluginsCacheDir,
  getPluginsDataDir,
  getGlobalVectorIndexDir,
  getAgentWorkspacesDir
} from "../infra/config-paths";
import { readdirSync } from "node:fs";
```

3b. 替换 `type SidecarCacheCleanupKey` 到 `const CACHE_KEYS` 这段（第 29–40 行）为：

```typescript
type SidecarCacheCleanupKey = "logs" | "vectorIndex" | "pluginsCache";

export interface SidecarClearCacheInput {
  logs?: boolean;
  vectorIndex?: boolean;
  pluginsCache?: boolean;
}

export interface SidecarClearCacheResult {
  cleared: SidecarCacheCleanupKey[];
  skipped: SidecarCacheCleanupKey[];
}

const CACHE_KEYS: SidecarCacheCleanupKey[] = ["logs", "vectorIndex", "pluginsCache"];
```

3c. 替换 `resolveCacheTargetPaths`（第 98–107 行）为（增加 vectorIndex/pluginsCache 分支，并返回工作区向量索引）：

```typescript
function resolveCacheTargetPaths(key: SidecarCacheCleanupKey): string[] {
  const configDir = getConfigDir();
  switch (key) {
    case "logs":
      return Array.from(new Set([
        join(configDir, "logs"),
        join(tmpdir(), "lume-logs")
      ]));
    case "vectorIndex": {
      const paths = [getGlobalVectorIndexDir()];
      try {
        const workspacesDir = getAgentWorkspacesDir();
        for (const slug of readdirSync(workspacesDir)) {
          paths.push(join(workspacesDir, slug, "memory", "index"));
        }
      } catch {
        // 工作区目录不存在时忽略
      }
      return paths;
    }
    case "pluginsCache":
      return [getPluginsCacheDir(), getPluginsDataDir()];
  }
}
```

3d. 扩展 `assertSafeCacheTarget` 的 `allowedRoots`（第 111–115 行），在数组中加入向量索引与插件根：

```typescript
  const allowedRoots = [
    join(configDir, "cache"),
    join(configDir, "logs"),
    join(configDir, "memory", "index"),
    join(configDir, "plugins", "cache"),
    join(configDir, "plugins", "data"),
    join(configDir, "agent-workspaces"),
    join(tmpdir(), "lume-logs")
  ].map((value) => resolve(value));
```

> 注：`agent-workspaces` 根被加入白名单，使工作区向量索引子路径通过校验；删除只针对 `…/memory/index`（由 `resolveCacheTargetPaths` 给出），不会误删工作区其他数据。

- [ ] **Step 4: 扩展 zod schema `clearCacheInputSchema`**

在 `apps/sidecar/src/rpc/schemas.ts` 中，替换：

```typescript
export const clearCacheInputSchema = z.object({
  logs: z.boolean().optional()
}).strict();
```

为：

```typescript
export const clearCacheInputSchema = z.object({
  logs: z.boolean().optional(),
  vectorIndex: z.boolean().optional(),
  pluginsCache: z.boolean().optional()
}).strict();
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/sidecar && bun test src/services/system/general-settings-service.test.ts 2>&1 | tail -15`
Expected: PASS（3 个测试全过）。

- [ ] **Step 6: 类型检查**

Run: `cd apps/sidecar && bun run typecheck 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/system/general-settings-service.ts apps/sidecar/src/services/system/general-settings-service.test.ts apps/sidecar/src/rpc/schemas.ts
git commit -m "feat(sidecar): clearCache 扩展支持向量索引与插件缓存清理"
```

---

## Task 4: 新增「清空回收站」能力（emptyTrash）

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`

- [ ] **Step 1: 在 `agent-thread-manager.ts` 新增 `emptyTrash`**

在 `apps/sidecar/src/services/agent/agent-thread-manager.ts` 的 `cleanupExpiredTrash` 函数（约第 586–602 行）之后追加：

```typescript
/** 清空回收站：永久删除所有 status === "trashed" 的线程（不限时间），返回清理数量 */
export function emptyTrash(): number {
  const index = readIndex();
  const toDelete = index.threads.filter((t) => t.status === "trashed");

  for (const thread of toDelete) {
    deleteAgentThread(thread.id);
  }

  if (toDelete.length > 0) {
    console.log(`[Agent 线程] 已清空回收站 ${toDelete.length} 个条目`);
  }
  return toDelete.length;
}
```

- [ ] **Step 2: 在 `agent.ts` 新增 `EMPTY_TRASH` 通道**

在 `packages/shared/src/types/agent.ts` 的 `AGENT_IPC_CHANNELS` 中，`CLEANUP_EXPIRED_TRASH` 条目（约第 1239 行）之后追加：

```typescript
  /** 清空回收站（永久删除全部已 trash 线程） */
  EMPTY_TRASH: "agent:empty-trash",
```

- [ ] **Step 3: 在 `agent-handlers.ts` 新增 handler**

3a. 在 `apps/sidecar/src/rpc/agent-handlers.ts` 的 import 块（约第 26–31 行，从 `../services/agent/agent-thread-manager` 导入处）追加 `emptyTrash`：

```typescript
  cleanupExpiredTrash,
  emptyTrash,
```

3b. 在 `CLEANUP_EXPIRED_TRASH` handler（约第 684–686 行）之后追加：

```typescript
    [AGENT_IPC_CHANNELS.EMPTY_TRASH]: async () => {
      const count = emptyTrash();
      log.info("[Agent 线程] 清空回收站", { count });
      return { cleanedCount: count };
    },
```

- [ ] **Step 4: 验证类型与构建**

Run: `cd apps/sidecar && bun run typecheck 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 5: 跑现有 agent 线程测试回归**

Run: `cd apps/sidecar && bun test src/services/agent 2>&1 | tail -10`
Expected: 现有测试仍通过（emptyTrash 未破坏既有逻辑）。

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/agent/agent-thread-manager.ts apps/sidecar/src/rpc/agent-handlers.ts packages/shared/src/types/agent.ts
git commit -m "feat(sidecar): 新增 emptyTrash 清空回收站能力"
```

---

## Task 5: Rust resolve_config_dir（lume-logger）

**Files:**
- Modify: `crates/lume-logger/src/config.rs`

- [ ] **Step 1: 在 `config.rs` 新增 `resolve_config_dir`**

在 `crates/lume-logger/src/config.rs` 的 `resolve_logs_dir`（约第 48–56 行）之前，新增：

```rust
/// Resolve the Lume config directory (`~/.lume`), honoring `LUME_CONFIG_DIR`.
/// Mirrors `resolve_logs_dir` minus the `logs` join.
pub fn resolve_config_dir() -> PathBuf {
    if let Some(config_dir) = current_config_dir_from_env() {
        return config_dir;
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".lume");
    }
    PathBuf::from(".lume")
}
```

> 如果 `current_config_dir_from_env` 当前是私有（非 `pub`）且与 `resolve_logs_dir` 同文件，可直接调用。若编译报未找到该函数，把它在同一文件内提到 `resolve_config_dir` 之前即可（它已存在于 `config.rs`）。

- [ ] **Step 2: 写/验证测试**

在 `crates/lume-logger/src/config.rs` 的 `#[cfg(test)] mod tests`（若没有则在文件末尾新建）追加：

```rust
#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn resolve_config_dir_uses_env() {
        std::env::set_var("LUME_CONFIG_DIR", "/tmp/lume-config-dir-test");
        let dir = resolve_config_dir();
        assert_eq!(dir, PathBuf::from("/tmp/lume-config-dir-test"));
        std::env::remove_var("LUME_CONFIG_DIR");
    }
}
```

- [ ] **Step 3: 运行测试**

Run: `cd crates/lume-logger && cargo test resolve_config_dir 2>&1 | tail -10`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add crates/lume-logger/src/config.rs
git commit -m "feat(lume-logger): 新增 resolve_config_dir 公共函数"
```

---

## Task 6: Rust 存储统计命令 data_get_storage_stats

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: 加依赖**

在 `apps/desktop/src-tauri/Cargo.toml` 的 `[dependencies]` 段（`lume-logger = …` 之前或之后）追加：

```toml
walkdir = "2"
zip = "2"
```

- [ ] **Step 2: 写失败测试（纯函数 compute_category_sizes）**

在 `apps/desktop/src-tauri/src/main.rs` 文件末尾追加测试模块与纯函数。先加被测函数：

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataCategoryInput {
    key: String,
    scan_paths: Vec<String>,
    skip_subdirs: Vec<String>,
}

#[derive(serde::Serialize)]
struct DataCategoryOutput {
    key: String,
    bytes: u64,
}

/// 把含 `*` 的相对路径展开为具体路径（只支持单段 `*`，用于 agent-workspaces/*）。
fn expand_scan_path(root: &Path, rel: &str) -> Vec<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    let star_idx = parts.iter().position(|p| *p == "*");
    match star_idx {
        None => vec![root.join(rel)],
        Some(idx) => {
            let parent = root.join(parts[..idx].join("/"));
            let suffix: PathBuf = parts[idx + 1..].iter().collect();
            let Ok(entries) = std::fs::read_dir(&parent) else {
                return vec![];
            };
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| {
                    let mut p = e.path();
                    if !suffix.as_os_str().is_empty() {
                        p.push(&suffix);
                    }
                    p
                })
                .collect()
        }
    }
}

/// 对单类别求体积：扫描 scan_paths，跳过 skip_subdirs（含 `*`）。
fn compute_category_bytes(root: &Path, input: &DataCategoryInput) -> u64 {
    // 解析 skip 为绝对前缀集合（对每个 workspace 都展开）
    let mut skip_prefixes: Vec<PathBuf> = Vec::new();
    for s in &input.skip_subdirs {
        for p in expand_scan_path(root, s) {
            skip_prefixes.push(p);
        }
    }

    let mut total: u64 = 0;
    for rel in &input.scan_paths {
        for target in expand_scan_path(root, rel) {
            for entry in walkdir::WalkDir::new(&target).into_iter().filter_map(Result::ok) {
                let path = entry.path();
                if skip_prefixes.iter().any(|sp| path.starts_with(sp)) {
                    continue;
                }
                if entry.file_type().is_file() {
                    if let Ok(meta) = entry.metadata() {
                        total += meta.len();
                    }
                }
            }
        }
    }
    total
}
```

再追加测试模块：

```rust
#[cfg(test)]
mod data_stats_tests {
    use super::*;
    use std::fs::{create_dir_all, write};

    fn make_tree(root: &Path) {
        create_dir_all(root.join("memory/index")).unwrap();
        create_dir_all(root.join("memory/entries")).unwrap();
        create_dir_all(root.join("logs")).unwrap();
        write(root.join("memory/index/vec.json"), "xxxxx").unwrap(); // 5
        write(root.join("memory/entries/e.md"), "yyy").unwrap(); // 3
        write(root.join("logs/l.ndjson"), "zz").unwrap(); // 2
    }

    #[test]
    fn core_excludes_index() {
        let tmp = std::env::temp_dir().join("lume-stats-test-core");
        let _ = std::fs::remove_dir_all(&tmp);
        make_tree(&tmp);

        let core = DataCategoryInput {
            key: "core".into(),
            scan_paths: vec!["memory".into()],
            skip_subdirs: vec!["memory/index".into()],
        };
        // memory = entries(3) + index(5)；skip index 后应只剩 3
        assert_eq!(compute_category_bytes(&tmp, &core), 3);
    }

    #[test]
    fn derived_counts_index() {
        let tmp = std::env::temp_dir().join("lume-stats-test-derived");
        let _ = std::fs::remove_dir_all(&tmp);
        make_tree(&tmp);

        let derived = DataCategoryInput {
            key: "derived".into(),
            scan_paths: vec!["memory/index".into(), "logs".into()],
            skip_subdirs: vec![],
        };
        // index(5) + logs(2) = 7
        assert_eq!(compute_category_bytes(&tmp, &derived), 7);
    }
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd apps/desktop/src-tauri && cargo test data_stats_tests 2>&1 | tail -15`
Expected: PASS（2 个测试）。

- [ ] **Step 4: 加 Tauri 命令 `data_get_storage_stats`**

在 `apps/desktop/src-tauri/src/main.rs` 中（`desktop_list_log_files` 附近，如第 600 行之后）追加命令：

```rust
#[tauri::command]
fn data_get_storage_stats(categories: Vec<DataCategoryInput>) -> Result<serde_json::Value, String> {
    let root = ll::config::resolve_config_dir();
    let mut outs = Vec::<DataCategoryOutput>::new();
    let mut total: u64 = 0;
    for cat in &categories {
        let bytes = compute_category_bytes(&root, cat);
        total += bytes;
        outs.push(DataCategoryOutput { key: cat.key.clone(), bytes });
    }
    Ok(serde_json::json!({
        "total": total,
        "configDir": root.to_string_lossy(),
        "categories": outs
    }))
}
```

- [ ] **Step 5: 注册命令**

在 `apps/desktop/src-tauri/src/main.rs` 第 1731–1753 的 `tauri::generate_handler![...]` 中，在 `copy_file` 之后、`]` 之前追加两行：

```rust
            copy_file,
            data_get_storage_stats,
            data_export_zip
        ])
```

> `data_export_zip` 在 Task 7 实现，此处先登记；Task 7 完成前 `cargo build` 会因 `data_export_zip` 未定义而失败——故 Task 6 与 Task 7 一起在 Task 7 Step 末尾统一编译验证。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): 新增 data_get_storage_stats 命令（注册 data_export_zip 占位）"
```

---

## Task 7: Rust 导出 zip 命令 data_export_zip

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: 写失败测试（脱敏 + 打包纯函数）**

在 `apps/desktop/src-tauri/src/main.rs` 末尾追加脱敏与打包的纯函数：

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportZipInput {
    dest_path: String,
    include_credentials: bool,
}

/// 对 JSON 字节做脱敏；非 JSON 原样返回。失败时返回原文（不阻断导出）。
fn redact_json_bytes(bytes: &[u8]) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return bytes.to_vec();
    };
    let patterns = ll::redact::default_patterns();
    ll::redact::redact_value(&mut value, &patterns);
    serde_json::to_vec_pretty(&value).unwrap_or_else(|_| bytes.to_vec())
}

/// 把 src 目录打成 zip 写入 dest。对所有 .json 做脱敏（当 strip=true）。
/// 返回 (字节数, 文件数)。
fn write_data_zip(src: &Path, dest: &Path, strip_credentials: bool) -> Result<(u64, u64), String> {
    let file = std::fs::File::create(dest).map_err(|e| format!("创建导出文件失败: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();

    let mut count: u64 = 0;
    for entry in walkdir::WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = path.strip_prefix(src).map_err(|e| e.to_string())?;
        let raw = std::fs::read(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
        let data = if strip_credentials && rel.extension().and_then(|e| e.to_str()) == Some("json") {
            redact_json_bytes(&raw)
        } else {
            raw
        };
        zip.start_file(rel.to_string_lossy(), opts)
            .map_err(|e| format!("写入 zip 条目失败: {e}"))?;
        use std::io::Write;
        zip.write_all(&data).map_err(|e| format!("写入 zip 内容失败: {e}"))?;
        count += 1;
    }
    zip.finish().map_err(|e| format!("完成 zip 失败: {e}"))?;
    let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok((bytes, count))
}
```

追加测试模块：

```rust
#[cfg(test)]
mod export_zip_tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::io::Read;

    #[test]
    fn redacts_json_credentials() {
        let raw = br#"{"apiKey":"sk-secret","name":"ok"}"#;
        let out = redact_json_bytes(raw);
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("[REDACTED]"));
        assert!(!s.contains("sk-secret"));
        assert!(s.contains("ok"));
    }

    #[test]
    fn zip_strips_credentials_when_requested() {
        let src = std::env::temp_dir().join("lume-export-src");
        let dest = std::env::temp_dir().join("lume-export-dest.zip");
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_file(&dest);
        create_dir_all(&src).unwrap();
        write(src.join("settings.json"), br#"{"apiKey":"sk-leak"}"#).unwrap();

        let (bytes, count) = write_data_zip(&src, &dest, true).unwrap();
        assert!(bytes > 0);
        assert_eq!(count, 1);

        // 解 zip 校验内容脱敏
        let f = std::fs::File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let mut s = String::new();
        archive.by_index(0).unwrap().read_to_string(&mut s).unwrap();
        assert!(s.contains("[REDACTED]"));
        assert!(!s.contains("sk-leak"));
    }
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd apps/desktop/src-tauri && cargo test export_zip_tests 2>&1 | tail -15`
Expected: PASS（2 个测试）。

- [ ] **Step 3: 加 Tauri 命令 `data_export_zip`**

在 `apps/desktop/src-tauri/src/main.rs` 的 `data_get_storage_stats` 命令之后追加：

```rust
#[tauri::command]
fn data_export_zip(input: ExportZipInput) -> Result<serde_json::Value, String> {
    let root = ll::config::resolve_config_dir();
    let dest = Path::new(&input.dest_path);
    let (bytes, file_count) = write_data_zip(&root, dest, !input.include_credentials)?;
    info!(
        "[desktop] data_export_zip -> {} ({} files, {} bytes, credentials_stripped={})",
        dest.display(),
        file_count,
        bytes,
        !input.include_credentials
    );
    Ok(serde_json::json!({
        "path": dest.to_string_lossy(),
        "bytes": bytes,
        "fileCount": file_count,
        "credentialsStripped": !input.include_credentials
    }))
}
```

- [ ] **Step 4: 编译验证（Task 6+7 一起）**

Run: `cd apps/desktop/src-tauri && cargo build 2>&1 | tail -15`
Expected: 编译通过（`data_get_storage_stats` 与 `data_export_zip` 均已定义并注册）。

- [ ] **Step 5: 全量 Rust 测试回归**

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | tail -15`
Expected: 所有测试通过（含 data_stats_tests、export_zip_tests 及既有测试）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): 新增 data_export_zip 命令（zip 打包 + JSON 凭证脱敏）"
```

---

## Task 8: Web desktop-api 包装

**Files:**
- Create: `apps/web/src/lib/desktop-api/data.ts`
- Modify: `apps/web/src/lib/desktop-api/system.ts`
- Modify: `apps/web/src/lib/desktop-api/index.ts`

- [ ] **Step 1: 创建 `data.ts`**

```typescript
// apps/web/src/lib/desktop-api/data.ts
import { invoke } from '@tauri-apps/api/core'
import { AGENT_IPC_CHANNELS, DATA_CATEGORY_SCAN_SPEC } from '@lume/shared'
import type {
  EmptyTrashResult,
  ExportZipInput,
  ExportZipResult,
  StorageStats,
} from '@lume/shared'
import { sidecarCall } from './system'

// Tauri 命令用下划线名（与 native.ts 既有 desktop_* 命令同风格，直接 invoke）
export const getStorageStats = () =>
  invoke<StorageStats>('data_get_storage_stats', { categories: DATA_CATEGORY_SCAN_SPEC })

export const exportZip = (input: ExportZipInput) =>
  invoke<ExportZipResult>('data_export_zip', input)

export const emptyTrash = () =>
  sidecarCall<EmptyTrashResult>(AGENT_IPC_CHANNELS.EMPTY_TRASH, {})
```

- [ ] **Step 2: 在 `system.ts` 让 `clearCache` 透传新键**

在 `apps/web/src/lib/desktop-api/system.ts` 中，替换 `ClearCacheInput`（第 26–30 行）为：

```typescript
export interface ClearCacheInput {
  frontendTemp?: boolean
  previewRender?: boolean
  logs?: boolean
  vectorIndex?: boolean
  pluginsCache?: boolean
}
```

并替换 `clearCache` 中对 sidecar 的调用（第 116–119 行）：

```typescript
  const sidecarResult = await sidecarCall<ClearCacheResult>(
    GENERAL_SETTINGS_IPC_CHANNELS.CLEAR_CACHE,
    { logs: input.logs, vectorIndex: input.vectorIndex, pluginsCache: input.pluginsCache }
  )
```

- [ ] **Step 3: 在 `index.ts` 导出 `./data`**

在 `apps/web/src/lib/desktop-api/index.ts` 末尾追加：

```typescript
export * from './data'
```

- [ ] **Step 4: 类型检查**

Run: `cd apps/web && bun run typecheck 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/desktop-api/data.ts apps/web/src/lib/desktop-api/system.ts apps/web/src/lib/desktop-api/index.ts
git commit -m "feat(web): desktop-api 新增 data 包装，clearCache 透传 vectorIndex/pluginsCache"
```

---

## Task 9: data-management-state 与测试

**Files:**
- Create: `apps/web/src/components/settings/data-management-state.ts`
- Create: `apps/web/src/components/settings/data-management-state.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/web/src/components/settings/data-management-state.test.ts
import { describe, expect, test } from 'bun:test'
import {
  CLEANUP_OPTIONS,
  createDefaultCleanupSelection,
  hasSelectedCleanup,
  type CleanupSelection,
  formatBytes,
} from './data-management-state'

describe('data-management-state', () => {
  test('CLEANUP_OPTIONS 含 5 项且 rebuildable 标注正确', () => {
    const keys = CLEANUP_OPTIONS.map((o) => o.key)
    expect(keys).toEqual(['frontendTemp', 'previewRender', 'logs', 'vectorIndex', 'pluginsCache'])
    const trashFree = CLEANUP_OPTIONS.filter((o) => !o.rebuildable)
    expect(trashFree).toEqual([])
  })

  test('默认全选可重建项', () => {
    const sel = createDefaultCleanupSelection()
    expect(sel.frontendTemp).toBe(true)
    expect(sel.vectorIndex).toBe(true)
    expect(sel.pluginsCache).toBe(true)
  })

  test('hasSelectedCleanup 反映选择', () => {
    expect(hasSelectedCleanup(createDefaultCleanupSelection())).toBe(true)
    const empty: CleanupSelection = {
      frontendTemp: false,
      previewRender: false,
      logs: false,
      vectorIndex: false,
      pluginsCache: false,
    }
    expect(hasSelectedCleanup(empty)).toBe(false)
  })

  test('formatBytes 人类可读', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MB')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && bun test src/components/settings/data-management-state.test.ts 2>&1 | tail -10`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `data-management-state.ts`**

```typescript
// apps/web/src/components/settings/data-management-state.ts
import type { DataCleanupKey } from '@lume/shared'

export type CleanupSelection = Record<DataCleanupKey, boolean>

export interface CleanupOption {
  key: DataCleanupKey
  label: string
  desc: string
  rebuildable: boolean
}

export const CLEANUP_OPTIONS: CleanupOption[] = [
  { key: 'frontendTemp', label: '前端临时缓存', desc: '界面临时文件与 sessionStorage', rebuildable: true },
  { key: 'previewRender', label: '预览/渲染缓存', desc: '预览图、渲染结果等可重建内容', rebuildable: true },
  { key: 'logs', label: '日志缓存', desc: '本地日志文件，不影响配置和会话', rebuildable: true },
  { key: 'vectorIndex', label: '向量索引', desc: '记忆向量索引，下次召回自动重建', rebuildable: true },
  { key: 'pluginsCache', label: '插件缓存', desc: 'plugins/cache 与 plugins/data', rebuildable: true },
]

export function createDefaultCleanupSelection(): CleanupSelection {
  return {
    frontendTemp: true,
    previewRender: true,
    logs: true,
    vectorIndex: true,
    pluginsCache: true,
  }
}

export function hasSelectedCleanup(selection: CleanupSelection): boolean {
  return Object.values(selection).some(Boolean)
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && bun test src/components/settings/data-management-state.test.ts 2>&1 | tail -10`
Expected: PASS（4 个测试）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/data-management-state.ts apps/web/src/components/settings/data-management-state.test.ts
git commit -m "feat(web): 新增 data-management-state 与测试"
```

---

## Task 10: DataManagementSettings 主组件

**Files:**
- Create: `apps/web/src/components/settings/DataManagementSettings.tsx`

- [ ] **Step 1: 实现组件**

```tsx
// apps/web/src/components/settings/DataManagementSettings.tsx
import * as React from 'react'
import {
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { DATA_CATEGORY_META } from '@lume/shared'
import type { StorageStats } from '@lume/shared'
import { Button } from '@/components/ui/button'
import {
  clearCache,
  emptyTrash,
  exportZip,
  getStorageStats,
  revealPathInSystem,
  saveFilePathDialog,
} from '@/lib/desktop-api'
import {
  CLEANUP_OPTIONS,
  createDefaultCleanupSelection,
  formatBytes,
  hasSelectedCleanup,
  type CleanupSelection,
} from './data-management-state'

export function DataManagementSettings() {
  const [stats, setStats] = React.useState<StorageStats | null>(null)
  const [loadingStats, setLoadingStats] = React.useState(true)
  const [selection, setSelection] = React.useState<CleanupSelection>(createDefaultCleanupSelection())
  const [clearing, setClearing] = React.useState(false)
  const [emptying, setEmptying] = React.useState(false)
  const [confirmEmptyOpen, setConfirmEmptyOpen] = React.useState(false)
  const [includeCreds, setIncludeCreds] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  const refreshStats = React.useCallback(async () => {
    setLoadingStats(true)
    try {
      setStats(await getStorageStats())
    } catch (error) {
      console.error('[DataManagement] load stats FAILED:', error)
      toast.error('加载存储用量失败')
    } finally {
      setLoadingStats(false)
    }
  }, [])

  React.useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  const handleClear = async () => {
    setClearing(true)
    try {
      await clearCache(selection)
      toast.success('清理完成')
      await refreshStats()
    } catch (error) {
      console.error('[DataManagement] clear FAILED:', error)
      toast.error('清理失败')
    } finally {
      setClearing(false)
    }
  }

  const handleEmptyTrash = async () => {
    setEmptying(true)
    try {
      const { cleanedCount } = await emptyTrash()
      toast.success(`已清空回收站 ${cleanedCount} 项`)
      await refreshStats()
    } catch (error) {
      console.error('[DataManagement] emptyTrash FAILED:', error)
      toast.error('清空回收站失败')
    } finally {
      setEmptying(false)
      setConfirmEmptyOpen(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const picked = await saveFilePathDialog('lume-data.zip', [{ name: 'zip', extensions: ['zip'] }])
      if (!picked.path) return
      const result = await exportZip({ destPath: picked.path, includeCredentials: includeCreds })
      toast.success(`已导出 ${formatBytes(result.bytes)}（${result.fileCount} 个文件）`)
    } catch (error) {
      console.error('[DataManagement] export FAILED:', error)
      toast.error('导出失败')
    } finally {
      setExporting(false)
    }
  }

  const totalBytes = stats?.total ?? 0

  return (
    <div className="space-y-3">
      {/* ① 存储概览 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">存储概览</h2>
          <Button variant="outline" onClick={() => void refreshStats()} disabled={loadingStats} className="h-8 gap-1.5 rounded-[8px] px-3 text-[12px]">
            {loadingStats ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            刷新
          </Button>
        </div>
        <div className="mb-3 text-[13px] text-[var(--text-2)]">
          总计 <span className="font-semibold text-[var(--text-1)]">{formatBytes(totalBytes)}</span>
        </div>
        <div className="space-y-2">
          {DATA_CATEGORY_META.map((meta) => {
            const bytes = stats?.categories.find((c) => c.key === meta.key)?.bytes ?? 0
            const pct = totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0
            return (
              <div key={meta.key} className="flex items-center gap-3">
                <div className="w-[72px] shrink-0 text-[13px] font-medium text-[var(--text-2)]">{meta.label}</div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${pct}%` }} />
                </div>
                <div className="w-[64px] shrink-0 text-right text-[12px] tabular-nums text-[var(--text-2)]">{formatBytes(bytes)}</div>
                <div className="w-[40px] shrink-0 text-right text-[11px] tabular-nums text-[var(--text-3)]">{pct}%</div>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-[var(--text-3)]">
          {DATA_CATEGORY_META.map((m) => `${m.label}：${m.subtitle}`).join('；')}
        </p>
      </section>

      {/* ② 清理 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">清理</h2>
        <div className="space-y-2">
          {CLEANUP_OPTIONS.map((option) => (
            <label key={option.key} className="flex items-center gap-3 rounded-[8px] border border-[var(--border)] px-3 py-2">
              <input
                type="checkbox"
                checked={selection[option.key]}
                onChange={(e) => setSelection((cur) => ({ ...cur, [option.key]: e.currentTarget.checked }))}
                disabled={clearing}
                className="size-4 accent-[var(--brand)]"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[var(--text-2)]">{option.label}</div>
                <div className="text-[11px] text-[var(--text-3)]">{option.desc}</div>
              </div>
              <span className="text-[11px] text-[var(--text-3)]">可重建</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-[var(--text-3)]">以上均为可重建数据，清理后不影响会话与记忆。</span>
          <Button onClick={handleClear} disabled={clearing || !hasSelectedCleanup(selection)} className="h-9 gap-1.5 rounded-[8px] px-4 text-[13px]">
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            执行清理
          </Button>
        </div>
      </section>

      {/* ③ 导出 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">导出</h2>
        <p className="mb-3 text-[12px] leading-5 text-[var(--text-3)]">
          将 <code className="rounded bg-[var(--surface-2)] px-1">~/.lume/</code> 打包为 zip。默认对所有配置 JSON 做凭证脱敏。
        </p>
        <label className="mb-3 flex items-center gap-2 rounded-[8px] border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <input
            type="checkbox"
            checked={includeCreds}
            onChange={(e) => setIncludeCreds(e.currentTarget.checked)}
            disabled={exporting}
            className="size-4 accent-amber-600"
          />
          <span className="flex items-center gap-1 text-[12px] text-amber-800 dark:text-amber-200">
            <TriangleAlert size={13} />
            包含凭证（API Key / Token / IM 凭证将以明文导出）
          </span>
        </label>
        <div className="flex justify-end">
          <Button onClick={handleExport} disabled={exporting} className="h-9 gap-1.5 rounded-[8px] px-4 text-[13px]">
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            选择位置并导出
          </Button>
        </div>
      </section>

      {/* ④ 数据位置 */}
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">数据位置</h2>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[13px] text-[var(--text-2)]">
            根目录 <code className="break-all rounded bg-[var(--surface-2)] px-1">{stats?.configDir ?? '~/.lume/'}</code>
          </div>
          <Button
            variant="outline"
            disabled={!stats?.configDir}
            onClick={() => stats?.configDir && revealPathInSystem(stats.configDir).catch(() => toast.error('打开目录失败'))}
            className="h-8 shrink-0 gap-1.5 rounded-[8px] px-3 text-[12px]"
          >
            <FolderOpen size={13} />
            打开目录
          </Button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-[var(--text-3)]">
          所有数据均为本地文件：记忆是 Markdown、会话是 jsonl、向量索引是 JSON 缓存。配置类文件含凭证，导出时默认脱敏。
        </p>
      </section>

      {/* 清空回收站（危险，独立折叠） */}
      <section className="rounded-[10px] border border-[#ff9fa8] bg-[var(--surface-1)] px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-[#ff4d57]">
              <Trash2 size={15} />
              清空回收站
            </h2>
            <p className="mt-1 text-[11px] text-[var(--text-3)]">永久删除所有已放入回收站的会话，不可恢复。</p>
          </div>
          <Button
            onClick={() => setConfirmEmptyOpen(true)}
            disabled={emptying}
            className="h-9 gap-1.5 rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-4 text-[13px] text-[#ff4d57] hover:bg-[#ffe9eb]"
          >
            清空回收站
          </Button>
        </div>

        {confirmEmptyOpen && (
          <div className="mt-3 rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-3 py-3">
            <p className="text-[12px] text-[#ff4d57]">确认永久删除回收站中的全部会话？此操作不可撤销。</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmEmptyOpen(false)} disabled={emptying} className="h-8 rounded-[8px] px-3 text-[12px]">取消</Button>
              <Button onClick={handleEmptyTrash} disabled={emptying} className="h-8 gap-1.5 rounded-[8px] bg-[#ff4d57] px-3 text-[12px] text-white hover:bg-[#e6454f]">
                {emptying ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                确认清空
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
```

> 说明：「打开目录」使用 `stats.configDir`（由 `data_get_storage_stats` 返回的真实根目录）调用既有 `revealPathInSystem`，无需新增命令，且顺带在 UI 展示真实路径（呼应数据位置透明）。`saveFilePathDialog` / `revealPathInSystem` 均为 `@/lib/desktop-api` 既有包装（源自 `native.ts`）。

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && bun run typecheck 2>&1 | tail -10`
Expected: 无错误（若有 `Database` 等未用 import 警告，移除未用的 import）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/DataManagementSettings.tsx
git commit -m "feat(web): 新增 DataManagementSettings 主组件（4 卡片 + 清空回收站）"
```

---

## Task 11: 接入导航并收敛 GeneralSettings 清理入口

**Files:**
- Modify: `apps/web/src/components/settings/settings-view-state.ts`
- Modify: `apps/web/src/components/settings/settings-view-state.test.ts`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`
- Modify: `apps/web/src/components/settings/GeneralSettings.tsx`
- Delete: `apps/web/src/components/settings/ClearCacheDialog.tsx`

- [ ] **Step 1: settings-view-state 新增 `data` tab**

1a. 在 import 中把 `Database`（用于 memory）保留，新增 `HardDrive`：

替换 `apps/web/src/components/settings/settings-view-state.ts` 第 1–18 行的 lucide import，加入 `HardDrive`：

```typescript
import {
  Archive,
  BookOpen,
  Box,
  Cog,
  Database,
  HardDrive,
  Bot,
  Keyboard,
  MessageCircle,
  Palette,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  ScrollText,
  Users,
  type LucideIcon,
} from 'lucide-react'
```

1b. 在 `SettingsViewTab` 类型（第 20 行）的联合中加入 `'data'`，例如在 `'updates'` 后：

```typescript
  | 'updates'
  | 'data'
  | 'logs'
  | 'archive'
```

1c. 在 `SETTINGS_NAV_ITEMS`（第 56–58 行）的 `updates` 与 `logs` 之间插入：

```typescript
  { id: 'updates', label: '版本与更新', icon: RefreshCw },
  { id: 'data', label: '数据管理', icon: HardDrive },
  { id: 'logs', label: '应用日志', icon: ScrollText },
```

1d. 在 `SETTINGS_PAGE_TITLES` 加入 `data: '数据管理'`；在 `SETTINGS_PAGE_SUBTITLES` 加入：

```typescript
  data: '查看存储用量、安全清理与全量数据导出',
```

- [ ] **Step 2: 更新 settings-view-state.test.ts**

打开 `apps/web/src/components/settings/settings-view-state.test.ts`，在断言 tab 集合或导航项数量的地方加入 `data`。若测试断言固定数量/列表，把预期更新为含 `data`。运行确认：

Run: `cd apps/web && bun test src/components/settings/settings-view-state.test.ts 2>&1 | tail -10`
Expected: PASS（如失败，按实际断言补 `data`）。

- [ ] **Step 3: SettingsView 渲染分支**

在 `apps/web/src/components/settings/SettingsView.tsx` 中：

3a. 顶部 import 区加入：

```typescript
import { DataManagementSettings } from './DataManagementSettings'
```

3b. 在 `{tab === 'updates' && <VersionUpdateSettings />}` 之后加入：

```typescript
          {tab === 'data' && <DataManagementSettings />}
```

- [ ] **Step 4: GeneralSettings 收敛清理入口**

4a. 在 `apps/web/src/components/settings/GeneralSettings.tsx`：
- 移除 import `import { ClearCacheDialog } from './ClearCacheDialog'`（第 30 行）。
- 移除 state `const [clearCacheOpen, setClearCacheOpen] = React.useState(false)`（第 59 行）。
- 移除末尾 `<ClearCacheDialog open={clearCacheOpen} onOpenChange={setClearCacheOpen} />`（第 331 行）与外层 `<>...</>` fragment（保留 `<div className="space-y-3">…</div>`，去掉 fragment）。
- 把「本地数据」卡片中的「清理缓存」QuickAction 改为跳转到数据管理。需要 `useSetAtom(settingsInitialTabAtom)`：

在 import 区加入：

```typescript
import { useSetAtom } from 'jotai'
import { settingsInitialTabAtom } from '@/atoms'
```

并在组件内加入：

```typescript
  const setSettingsTab = useSetAtom(settingsInitialTabAtom)
```

把「清理缓存」QuickAction（第 321–326 行）替换为：

```tsx
            <QuickAction
              icon={Trash2}
              label="数据管理"
              onClick={() => setSettingsTab('data')}
            />
```

> `tone="danger"` 移除（改为普通入口）。`Trash2` icon 可保留或换成 `HardDrive`；此处沿用已 import 的 `Trash2`。

4b. 删除不再使用的 `ClearCacheDialog.tsx`：

```bash
git rm apps/web/src/components/settings/ClearCacheDialog.tsx
```

- [ ] **Step 5: 类型检查 + 全量 web 测试**

Run: `cd apps/web && bun run typecheck 2>&1 | tail -10`
Expected: 无错误（确认 ClearCacheDialog 引用已清除）。

Run: `cd apps/web && bun test 2>&1 | tail -15`
Expected: 所有测试通过。

- [ ] **Step 6: 端到端冒烟（手动）**

Run: `cd /Users/cavin/workspace/project/lume && bun run dev`（启动 web+desktop），在设置中打开「数据管理」tab，验证：
- 存储概览显示 4 类体积与总计；
- 清理勾选后「执行清理」成功并刷新体积；
- 导出选择 zip 路径后生成文件，打开检查 `settings.json` 内 apiKey 为 `[REDACTED]`；
- 「打开目录」按钮若无效则记录为已知小问题（不阻断）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/settings-view-state.ts apps/web/src/components/settings/settings-view-state.test.ts apps/web/src/components/settings/SettingsView.tsx apps/web/src/components/settings/GeneralSettings.tsx
git commit -m "feat(web): 接入数据管理 tab，收敛 GeneralSettings 清理入口"
```

---

## Self-Review（计划作者自检，已执行）

**1. Spec coverage：**
- 存储概览（4 类）→ Task 1（spec）+ Task 6（扫描）+ Task 10（UI）。✓
- 统一清理（日志/向量索引/插件缓存）→ Task 3（sidecar 扩展）+ Task 8（透传）+ Task 10（UI）。✓
- 清空回收站 → Task 4。✓
- 导出 zip + 凭证脱敏 → Task 7（脱敏每 .json）+ Task 10（UI）。✓
- 数据位置透明 → Task 10 ④卡。✓
- 收敛清理入口（移除 GeneralSettings 弹窗）→ Task 11。✓
- 安全：强确认（清空回收站）→ Task 10 内联确认块；凭证脱敏默认 → Task 7 + Task 10 默认 `includeCreds=false`。✓
- 导航入口 → Task 11。✓

**2. Placeholder scan：** 无 TBD/TODO；Task 10「打开目录」按钮标了一个已知不确定性并给了降级方案（不阻断）。其余步骤均有完整代码。

**3. Type consistency：** TS→Rust 嵌套结构体的 camelCase（TS `scanPaths`/`skipSubdirs`/`destPath`/`includeCredentials`）↔ snake_case（Rust 字段）映射——Tauri 不会自动转换嵌套结构体。**已修正**：Task 6 的 `DataCategoryInput` 与 Task 7 的 `ExportZipInput` 均加 `#[serde(rename_all = "camelCase")]`。`StorageStats.configDir` 与 Rust 返回的 `"configDir"` 键一致。

**4. Ambiguity：** 「打开目录」原计划用空串调用 `reveal_path_in_system` 会失败（该命令校验路径存在性）。**已修正**：改为 `data_get_storage_stats` 返回真实 `configDir`，UI 用 `revealPathInSystem(stats.configDir)`；存框改用既有 `saveFilePathDialog(filename, filters)` 包装（参数为 `filename` 非 `defaultName`）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-data-management-settings.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 Task 派一个全新 subagent 实现，两阶段 review，迭代快、上下文干净。

**2. Inline Execution** - 在当前会话内按 executing-plans 批量执行，带 checkpoint review。

选哪种？
