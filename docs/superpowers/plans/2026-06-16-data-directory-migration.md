# 数据目录迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「数据管理」设置页新增「迁移目录」能力——把 `~/.lume/` 复制到用户选择的新目录，写 launcher.json 记住新路径，重启后生效；旧目录可由用户选删除或保留。

**Architecture:** 新增持久化路径来源 `launcher.json`（OS 应用配置目录），desktop `main()` 最早读它并 `set_var("LUME_CONFIG_DIR")`，sidecar 靠 env 继承自动跟随。迁移用两段式 Rust 命令：`data_migrate_to_dir`（校验目标 → kill sidecar → walkdir 复制 → 校验字节数/文件数 → 报进度）与 `data_apply_migration`（写 launcher.json）。复制成功后 web 端弹「删旧/保留」对话框，选完调 apply 写 launcher.json 再 `relaunch()`；删旧动作在重启后的新会话执行。

**Tech Stack:** Rust / Tauri 2（`walkdir`、`dirs`、`serde`、`tauri-plugin-process`、既有 `lume-logger`）、React + jotai、TypeScript。

参考设计：`docs/superpowers/specs/2026-06-16-data-directory-migration-design.md`

---

## File Structure

**Shared（`packages/shared`）**
- Modify: `packages/shared/src/types/data-management.ts` — 加 `MigrationResult`、`MigrationApplyInput`。

**Rust（`apps/desktop/src-tauri/src/main.rs`）** — 沿用既有约定（`write_data_zip`/`resolve_settings_path` 等均在 main.rs），新增：
- launcher.json 类型 + 读写 + 优先级解析（`LauncherConfig`、`resolve_launcher_path`、`read_launcher_config_from`、`write_launcher_config`、`effective_config_dir_with`）。
- 迁移纯函数（`copy_dir_recursive`、`validate_migration_target`、`dir_stats`）。
- 两个 `#[tauri::command]`（`data_migrate_to_dir`、`data_apply_migration`）+ 注册进 `generate_handler!`。
- main() 早期注入（`apply_launcher_config_env`，置于 `ll::init` 之前）。

**Web（`apps/web`）**
- Modify: `apps/web/src/lib/desktop-api/data.ts` — `migrateToDir`、`applyMigration`。
- Modify: `apps/web/src/components/settings/DataManagementSettings.tsx` — 「迁移目录」按钮 + 迁移对话框 + 进度监听。

---

## Task 1: Shared 迁移类型

**Files:**
- Modify: `packages/shared/src/types/data-management.ts`

- [ ] **Step 1: 追加迁移相关类型**

在 `packages/shared/src/types/data-management.ts` 末尾追加：

```typescript
/** data_migrate_to_dir 命令返回 */
export interface MigrationResult {
  destPath: string;
  fileCount: number;
  bytesCopied: number;
  verified: boolean;
}

/** data_apply_migration 命令入参 */
export interface MigrationApplyInput {
  /** 迁移目标绝对路径（由 migrate 步骤返回） */
  destPath: string;
  /** true=重启后删除旧目录；false=保留旧目录作备份 */
  deleteOld: boolean;
}
```

- [ ] **Step 2: 验证 shared 类型检查**

Run: `cd packages/shared && bun run typecheck 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/data-management.ts
git commit -m "feat(shared): 新增数据目录迁移类型"
```

---

## Task 2: Rust launcher.json 助手与优先级解析（TDD）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: 写失败测试（追加到 main.rs 末尾的测试区）**

在 `apps/desktop/src-tauri/src/main.rs` 末尾追加类型、助手与测试。先加被测代码骨架 + 测试：

```rust
const LUME_APP_IDENTIFIER: &str = "com.lume.desktop";

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct LauncherConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    config_dir: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pending_delete_old: Option<PathBuf>,
}

/// launcher.json 的 OS 标准路径（<config_dir>/<identifier>/launcher.json）。
fn resolve_launcher_path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(LUME_APP_IDENTIFIER).join("launcher.json"))
}

fn read_launcher_config_from(path: &Path) -> Option<LauncherConfig> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<LauncherConfig>(&text).ok()
}

fn write_launcher_config_at(path: &Path, cfg: &LauncherConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 launcher 目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化 launcher.json 失败: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("写 launcher.json 失败: {e}"))
}

/// 计算生效的 config 目录，优先级：外部 env > launcher.json > 默认。
/// `launcher_path: None` 表示不读 launcher.json（测试用）。
fn effective_config_dir_with(launcher_path: Option<&Path>) -> PathBuf {
    if let Ok(v) = std::env::var("LUME_CONFIG_DIR") {
        let t = v.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    if let Some(path) = launcher_path {
        if let Some(cfg) = read_launcher_config_from(path) {
            if let Some(cd) = cfg.config_dir {
                return cd;
            }
        }
    }
    ll::config::resolve_config_dir()
}

#[cfg(test)]
mod migration_launcher_tests {
    use super::*;

    fn write_tmp_launcher(cfg: &LauncherConfig) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lume-launcher-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("launcher.json");
        write_launcher_config_at(&path, cfg).unwrap();
        path
    }

    #[test]
    fn env_takes_precedence_over_launcher() {
        let path = write_tmp_launcher(&LauncherConfig {
            config_dir: Some(PathBuf::from("/from/launcher")),
            pending_delete_old: None,
        });
        std::env::set_var("LUME_CONFIG_DIR", "/from/env");
        assert_eq!(effective_config_dir_with(Some(&path)), PathBuf::from("/from/env"));
        std::env::remove_var("LUME_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn launcher_used_when_env_absent() {
        std::env::remove_var("LUME_CONFIG_DIR");
        let path = write_tmp_launcher(&LauncherConfig {
            config_dir: Some(PathBuf::from("/from/launcher")),
            pending_delete_old: None,
        });
        assert_eq!(effective_config_dir_with(Some(&path)), PathBuf::from("/from/launcher"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn default_when_no_env_no_launcher() {
        std::env::remove_var("LUME_CONFIG_DIR");
        // launcher_path None + 无 env → 走 ll::config::resolve_config_dir（~/.lume）
        let dir = effective_config_dir_with(None);
        assert!(dir.ends_with(".lume"));
    }

    #[test]
    fn roundtrip_launcher_config() {
        let path = write_tmp_launcher(&LauncherConfig {
            config_dir: Some(PathBuf::from("/new/lume")),
            pending_delete_old: Some(PathBuf::from("/old/lume")),
        });
        let read = read_launcher_config_from(&path).unwrap();
        assert_eq!(read.config_dir.as_deref(), Some(std::path::Path::new("/new/lume")));
        assert_eq!(read.pending_delete_old.as_deref(), Some(std::path::Path::new("/old/lume")));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
```

- [ ] **Step 2: 运行测试，确认通过**

Run: `cd apps/desktop/src-tauri && cargo test migration_launcher_tests 2>&1 | tail -15`
Expected: 4 PASS。

> 注：`dirs`、`serde_json`、`PathBuf` 均已在 main.rs 作用域内（`use std::path::{Path, PathBuf};`、`dirs` 依赖、`serde_json` 全路径）。若 `dirs::config_dir` 未导入，用全路径 `dirs::config_dir()`。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): launcher.json 助手与 config 目录优先级解析"
```

---

## Task 3: Rust 迁移纯函数（copy / validate / stats，TDD）

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: 写失败测试 + 实现（追加到 main.rs 末尾）**

```rust
/// 校验迁移目标：绝对路径、不与 src 重叠、不存在或为空。
fn validate_migration_target(src: &Path, dest: &Path) -> Result<(), String> {
    if !dest.is_absolute() {
        return Err("目标必须是绝对路径".into());
    }
    if dest == src {
        return Err("目标不能与当前数据目录相同".into());
    }
    if dest.starts_with(src) {
        return Err("目标不能在当前数据目录内".into());
    }
    if src.starts_with(dest) {
        return Err("目标不能包含当前数据目录".into());
    }
    if dest.exists() {
        if !dest.is_dir() {
            return Err("目标已存在且不是目录".into());
        }
        let not_empty = std::fs::read_dir(dest)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false);
        if not_empty {
            return Err("目标目录必须为空".into());
        }
    }
    Ok(())
}

/// 递归统计目录的文件数与总字节数（不含目录本身与符号链接）。
fn dir_stats(path: &Path) -> (u64, u64) {
    let mut files: u64 = 0;
    let mut bytes: u64 = 0;
    for entry in walkdir::WalkDir::new(path).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() {
            files += 1;
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    (files, bytes)
}

/// 递归复制 src 到 dest，逐文件通过 app.emit 报进度。返回（文件数, 字节数）。
fn copy_dir_recursive(src: &Path, dest: &Path, app: &tauri::AppHandle) -> Result<(u64, u64), String> {
    let entries: Vec<walkdir::DirEntry> = walkdir::WalkDir::new(src)
        .into_iter()
        .collect::<Result<_, _>>()
        .map_err(|e| format!("遍历源目录失败: {e}"))?;
    let total = entries.iter().filter(|e| e.file_type().is_file()).count() as u64;
    let mut done: u64 = 0;
    let mut bytes: u64 = 0;
    for entry in &entries {
        let path = entry.path();
        let rel = path.strip_prefix(src).map_err(|e| e.to_string())?;
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("创建目录 {} 失败: {e}", target.display()))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(path, &target)
                .map_err(|e| format!("复制 {} 失败: {e}", path.display()))?;
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            done += 1;
            let _ = app.emit("data:migrate-progress", serde_json::json!({ "done": done, "total": total }));
        }
    }
    Ok((done, bytes))
}

#[cfg(test)]
mod migration_copy_tests {
    use super::*;
    use std::fs::{create_dir_all, write};

    fn make_src(root: &Path) {
        create_dir_all(root.join("a/b")).unwrap();
        write(root.join("a/b/x.txt"), "hello").unwrap(); // 5
        write(root.join("a/y.json"), "{}").unwrap(); // 2
        create_dir_all(root.join("empty")).unwrap();
    }

    #[test]
    fn validate_rejects_overlap_and_nonempty() {
        let src = Path::new("/tmp/lume/src");
        assert!(validate_migration_target(src, Path::new("rel")).is_err()); // 相对
        assert!(validate_migration_target(src, src).is_err()); // 相同
        assert!(validate_migration_target(src, Path::new("/tmp/lume/src/sub")).is_err()); // dest 在 src 内
        assert!(validate_migration_target(src, Path::new("/tmp/lume")).is_err()); // src 在 dest 内
    }

    #[test]
    fn validate_accepts_empty_or_missing() {
        let src = Path::new("/tmp/lume/src");
        assert!(validate_migration_target(src, Path::new("/tmp/lume/dest-missing")).is_ok()); // 不存在
        let empty = std::env::temp_dir().join("lume-empty-target");
        let _ = std::fs::remove_dir_all(&empty);
        create_dir_all(&empty).unwrap();
        assert!(validate_migration_target(src, &empty).is_ok()); // 空目录
        write(empty.join("z"), "x").unwrap();
        assert!(validate_migration_target(src, &empty).is_err()); // 非空
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn dir_stats_counts_files_and_bytes() {
        let src = std::env::temp_dir().join("lume-stats-src");
        let _ = std::fs::remove_dir_all(&src);
        make_src(&src);
        let (files, bytes) = dir_stats(&src);
        assert_eq!(files, 2);
        assert_eq!(bytes, 7);
        let _ = std::fs::remove_dir_all(&src);
    }
}
```

> 注：`copy_dir_recursive` 的进度事件依赖 `tauri::AppHandle` + `app.emit`，难以纯单元测试；其复制正确性由 Task 5 的集成冒烟覆盖。`validate_migration_target` 与 `dir_stats` 是纯函数，此处单测。

- [ ] **Step 2: 运行测试**

Run: `cd apps/desktop/src-tauri && cargo test migration_copy_tests 2>&1 | tail -15`
Expected: 3 PASS。

- [ ] **Step 3: 全量编译验证**

Run: `cd apps/desktop/src-tauri && cargo build 2>&1 | tail -8`
Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): 迁移纯函数 validate/dir_stats/copy_dir_recursive"
```

---

## Task 4: main() 早期注入 launcher 配置

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: 实现 `apply_launcher_config_env` 并在 main() 最早期调用**

在 `apps/desktop/src-tauri/src/main.rs` 中，先加注入函数（放在 Task 2 的 launcher 助手附近）：

```rust
/// main() 最早期调用：按优先级把 config 目录写入 LUME_CONFIG_DIR（若外部未设），
/// 并清理 launcher.json 中的 pendingDeleteOld（删除旧目录）。
fn apply_launcher_config_env() {
    // 外部 env 已设 → 不覆盖（保留 dev/CLI 覆盖语义）
    if let Ok(v) = std::env::var("LUME_CONFIG_DIR") {
        if !v.trim().is_empty() {
            return;
        }
    }
    let Some(path) = resolve_launcher_path() else { return };
    let Some(cfg) = read_launcher_config_from(&path) else { return };

    if let Some(cd) = cfg.config_dir.clone() {
        let _ = std::env::set_var("LUME_CONFIG_DIR", &cd);
    }

    // 清理 pendingDeleteOld：仅当存在且不等于生效目录时删除旧目录，然后清除该字段
    if cfg.pending_delete_old.is_some() {
        let effective = effective_config_dir_with(Some(&path));
        if let Some(old) = cfg.pending_delete_old.as_ref() {
            if old != &effective && old.exists() {
                let _ = std::fs::remove_dir_all(old);
            }
        }
        let cleared = LauncherConfig {
            config_dir: cfg.config_dir,
            pending_delete_old: None,
        };
        let _ = write_launcher_config_at(&path, &cleared);
    }
}
```

然后在 `main()` 的**第一行**（在 `ll::init(...)` 之前）插入调用。当前 `main()` 起始为：

```rust
fn main() {
    // 初始化统一日志系统
    ll::init(ll::LumeLoggerConfig {
```

改为：

```rust
fn main() {
    // 最早期：按 launcher.json 注入 LUME_CONFIG_DIR（必须在 ll::init 写日志之前）
    apply_launcher_config_env();

    // 初始化统一日志系统
    ll::init(ll::LumeLoggerConfig {
```

- [ ] **Step 2: 核对 identifier**

确认 `tauri.conf.json` 的 `bundle.identifier`（或产品 identifier）== `com.lume.desktop`（与 `LUME_APP_IDENTIFIER` 常量一致）。若不同，把常量改为实际值。

Run: `grep -n "identifier" apps/desktop/src-tauri/tauri.conf.json`
Expected: 看到 `"identifier": "com.lume.desktop"`（或记下实际值并更新常量）。

- [ ] **Step 3: 编译 + 全量测试**

Run: `cd apps/desktop/src-tauri && cargo build 2>&1 | tail -8`
Expected: 编译通过。

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | tail -8`
Expected: 所有测试通过（含 Task 2/3 的新测试 + 既有）。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): main 早期注入 launcher 配置，支持 config 目录迁移与删旧清理"
```

---

## Task 5: 迁移命令 data_migrate_to_dir / data_apply_migration

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: 加两个命令**

在 `apps/desktop/src-tauri/src/main.rs` 中（Task 3 的 `copy_dir_recursive` 附近）追加：

```rust
#[tauri::command]
fn data_migrate_to_dir(
    dest: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarProcess>,
) -> Result<serde_json::Value, String> {
    let src = ll::config::resolve_config_dir();
    let dest_path = PathBuf::from(&dest);

    // 1. 校验目标（在 kill sidecar 之前）
    validate_migration_target(&src, &dest_path)?;

    // 2. kill sidecar（关闭 SQLite 等打开句柄）
    if let Ok(mut slot) = state.child.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // 3. 复制 + 进度
    let src_stats = dir_stats(&src);
    let (copied_files, copied_bytes) = copy_dir_recursive(&src, &dest_path, &app)?;

    // 4. 校验：dest 统计须与 src 一致
    let dest_stats = dir_stats(&dest_path);
    if dest_stats != src_stats {
        // 校验失败 → 清理 dest 半成品
        let _ = std::fs::remove_dir_all(&dest_path);
        return Err(format!(
            "校验失败：源 {} 文件/{} 字节 vs 目标 {} 文件/{} 字节",
            src_stats.0, src_stats.1, dest_stats.0, dest_stats.1
        ));
    }

    Ok(serde_json::json!({
        "destPath": dest,
        "fileCount": copied_files,
        "bytesCopied": copied_bytes,
        "verified": true
    }))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyMigrationInput {
    dest_path: String,
    delete_old: bool,
}

#[tauri::command]
fn data_apply_migration(input: ApplyMigrationInput) -> Result<serde_json::Value, String> {
    let old = ll::config::resolve_config_dir();
    let new = PathBuf::from(&input.dest_path);
    let cfg = LauncherConfig {
        config_dir: Some(new),
        pending_delete_old: if input.delete_old { Some(old) } else { None },
    };
    let path = resolve_launcher_path()
        .ok_or_else(|| "无法解析 launcher.json 路径".to_string())?;
    write_launcher_config_at(&path, &cfg)?;
    info!("[desktop] data_apply_migration: launcher.json 已写，等待前端 relaunch");
    Ok(serde_json::json!({ "ok": true }))
}
```

> relaunch 由前端在 `applyMigration` 里调（复用既有 `@tauri-apps/plugin-process` 的 `relaunch`），命令只负责写 launcher.json。

- [ ] **Step 2: 注册命令到 generate_handler!**

在 `apps/desktop/src-tauri/src/main.rs` 的 `tauri::generate_handler![ ... ]` 块（约 1780 行附近，`data_export_zip` 之后）追加：

```rust
            data_export_zip,
            data_migrate_to_dir,
            data_apply_migration
        ])
```

- [ ] **Step 3: 编译 + 全量测试**

Run: `cd apps/desktop/src-tauri && cargo build 2>&1 | tail -8`
Expected: 编译通过。

Run: `cd apps/desktop/src-tauri && cargo test 2>&1 | tail -8`
Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): 新增 data_migrate_to_dir / data_apply_migration 命令"
```

---

## Task 6: Web desktop-api 迁移包装

**Files:**
- Modify: `apps/web/src/lib/desktop-api/data.ts`

- [ ] **Step 1: 加迁移包装**

在 `apps/web/src/lib/desktop-api/data.ts` 中追加 import 与两个导出。当前文件顶部已 import 了若干 `@lume/shared` 类型；把 `MigrationApplyInput`、`MigrationResult` 加进 type import，然后追加：

```typescript
export const migrateToDir = (dest: string) =>
  invoke<MigrationResult>('data_migrate_to_dir', { dest })

export const applyMigration = (input: MigrationApplyInput) =>
  invoke<{ ok: boolean }>('data_apply_migration', input)
```

并把顶部 type import 块更新为包含新类型，例如：

```typescript
import type {
  EmptyTrashResult,
  ExportZipInput,
  ExportZipResult,
  MigrationApplyInput,
  MigrationResult,
  StorageStats,
} from '@lume/shared'
```

- [ ] **Step 2: 验证类型检查**

Run: `cd apps/web && bun run typecheck 2>&1 | grep -E "desktop-api/data" || echo "no errors in data.ts"`
Expected: "no errors in data.ts"。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/desktop-api/data.ts
git commit -m "feat(web): desktop-api 新增 migrateToDir / applyMigration 包装"
```

---

## Task 7: 迁移目录按钮 + 迁移对话框

**Files:**
- Modify: `apps/web/src/components/settings/DataManagementSettings.tsx`

- [ ] **Step 1: 加状态、迁移流程与 UI**

在 `apps/web/src/components/settings/DataManagementSettings.tsx` 中：

1a. 顶部 import 块加入：
```typescript
import { listen } from '@tauri-apps/api/event'
import { relaunch } from '@tauri-apps/plugin-process'
import { openFolderDialog, migrateToDir, applyMigration } from '@/lib/desktop-api'
```
（`FolderOpen` icon 已 import；新增一个 `HardDrive` 或 `FolderInput` 图标给迁移按钮——加到 lucide import：`FolderInput`。）

1b. 在组件内（与其它 useState 同区）加迁移状态：
```typescript
const [migrateOpen, setMigrateOpen] = React.useState(false)
const [migrateDest, setMigrateDest] = React.useState<string | null>(null)
const [migrating, setMigrating] = React.useState(false)
const [migrateProgress, setMigrateProgress] = React.useState<{ done: number; total: number } | null>(null)
const [migrateResult, setMigrateResult] = React.useState<{ destPath: string } | null>(null)
const [migrateError, setMigrateError] = React.useState<string | null>(null)
```

1c. 加迁移执行函数（复制+校验，成功后停在「选删旧/保留」态）：
```typescript
const handleStartMigrate = async () => {
  setMigrating(true)
  setMigrateError(null)
  setMigrateProgress({ done: 0, total: 0 })
  const unlisten = await listen<{ done: number; total: number }>('data:migrate-progress', (e) => {
    setMigrateProgress(e.payload)
  })
  try {
    if (!migrateDest) return
    const result = await migrateToDir(migrateDest)
    setMigrateResult({ destPath: result.destPath })
  } catch (error) {
    console.error('[DataManagement] migrate FAILED:', error)
    setMigrateError(error instanceof Error ? error.message : String(error))
  } finally {
    unlisten()
    setMigrating(false)
  }
}

const handleApplyMigrate = async (deleteOld: boolean) => {
  if (!migrateResult) return
  try {
    await applyMigration({ destPath: migrateResult.destPath, deleteOld })
    await relaunch()
  } catch (error) {
    console.error('[DataManagement] applyMigration FAILED:', error)
    toast.error('应用迁移失败，请手动重启')
  }
}

const pickMigrateDest = async () => {
  const picked = await openFolderDialog()
  if (picked.path) setMigrateDest(picked.path)
}
```

1d. 在「数据位置」卡的按钮行，把单个「打开目录」按钮改为两个按钮：
```tsx
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[13px] text-[var(--text-2)]">
            根目录 <code className="break-all rounded bg-[var(--surface-2)] px-1">{stats?.configDir ?? '~/.lume/'}</code>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              disabled={!stats?.configDir}
              onClick={() => stats?.configDir && revealPathInSystem(stats.configDir).catch(() => toast.error('打开目录失败'))}
              className="h-8 gap-1.5 rounded-[8px] px-3 text-[12px]"
            >
              <FolderOpen size={13} />
              打开目录
            </Button>
            <Button
              variant="outline"
              onClick={() => { setMigrateOpen(true); setMigrateResult(null); setMigrateError(null); setMigrateDest(null); setMigrateProgress(null) }}
              className="h-8 gap-1.5 rounded-[8px] px-3 text-[12px]"
            >
              <FolderInput size={13} />
              迁移目录
            </Button>
          </div>
        </div>
```

1e. 在组件返回的 JSX 最末（清空回收站 section 之后）加迁移对话框：
```tsx
      {migrateOpen && (
        <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4">
          <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">迁移数据目录</h2>

          {!migrateResult && (
            <>
              <p className="mb-3 text-[12px] leading-5 text-[var(--text-3)]">
                将复制全部数据到新位置，完成后自动重启。旧目录可在完成后删除或保留。
              </p>
              <div className="mb-3 flex items-center gap-2">
                <Button variant="outline" onClick={pickMigrateDest} disabled={migrating} className="h-8 rounded-[8px] px-3 text-[12px]">
                  选择目标目录
                </Button>
                <code className="min-w-0 flex-1 truncate rounded bg-[var(--surface-2)] px-2 py-1 text-[11px] text-[var(--text-2)]">
                  {migrateDest ?? '未选择'}
                </code>
              </div>
              {migrateProgress && migrating && (
                <div className="mb-3 text-[11px] text-[var(--text-3)]">
                  正在复制 {migrateProgress.done}/{migrateProgress.total || '?'} …
                </div>
              )}
              {migrateError && (
                <div className="mb-3 rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-3 py-2 text-[12px] text-[#ff4d57]">
                  迁移失败：{migrateError}。可关闭后重启应用以恢复。
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setMigrateOpen(false)} disabled={migrating} className="h-8 rounded-[8px] px-3 text-[12px]">
                  取消
                </Button>
                <Button onClick={handleStartMigrate} disabled={!migrateDest || migrating} className="h-8 rounded-[8px] px-3 text-[12px]">
                  {migrating ? '复制中…' : '开始迁移'}
                </Button>
              </div>
            </>
          )}

          {migrateResult && (
            <>
              <p className="mb-3 text-[12px] leading-5 text-[var(--text-3)]">
                迁移完成。选择旧目录的处理方式后将自动重启。
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => void handleApplyMigrate(true)} className="h-8 rounded-[8px] border border-[#ff9fa8] bg-[#fff5f6] px-3 text-[12px] text-[#ff4d57] hover:bg-[#ffe9eb]">
                  删除旧目录
                </Button>
                <Button onClick={() => void handleApplyMigrate(false)} className="h-8 rounded-[8px] px-3 text-[12px]">
                  保留作备份
                </Button>
              </div>
            </>
          )}
        </section>
      )}
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && bun run typecheck 2>&1 | grep -E "DataManagementSettings" || echo "no errors in DataManagementSettings"`
Expected: "no errors in DataManagementSettings"。

- [ ] **Step 3: 手动冒烟**

Run: `cd /Users/cavin/workspace/project/lume && bun run dev`，打开设置 → 数据管理 → 数据位置 → 迁移目录：
- 选一个空目录 → 开始迁移 → 进度推进 → 成功出现「删除旧目录 / 保留作备份」。
- 点「保留作备份」→ 应用重启 → 数据位置卡显示新路径，数据完整。
- （可选）再次迁移回原目录并选「删除旧目录」→ 重启后旧目录被删。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/DataManagementSettings.tsx
git commit -m "feat(web): 数据位置卡新增迁移目录按钮与迁移对话框"
```

---

## Self-Review（计划作者自检，已执行）

**1. Spec coverage：**
- launcher.json 持久化 + 优先级 → Task 2（助手+解析）+ Task 4（main 注入）。✓
- main 早期 set_var（ll::init 之前）→ Task 4 Step 1。✓
- 迁移命令（校验→kill sidecar→复制→校验→进度）→ Task 5（命令）+ Task 3（纯函数）。✓
- 两段式（migrate / apply）→ Task 5。✓
- 删旧在重启后新会话执行 → Task 4 的 `apply_launcher_config_env` pendingDeleteOld 清理。✓
- 回滚保证（launcher.json 仅复制+校验成功后写）→ Task 5（apply 在 migrate 成功后才被前端调用；失败时清理 dest）。✓
- UI（迁移目录按钮 + 对话框四步 + 不可取消的成功选择）→ Task 7。✓
- 错误矩阵 → Task 7（migrateError 展示 + 「重启恢复」语义）+ Task 5（校验失败清 dest）。✓
- 测试（launcher 优先级、copy/validate/stats）→ Task 2/3 cargo tests。✓
- identifier 一致性核对 → Task 4 Step 2。✓

**2. Placeholder scan：** 无 TBD/TODO；每步含完整代码。`copy_dir_recursive` 的进度事件部分由 Task 5 集成 + Task 7 冒烟覆盖（已注明非纯单测）。

**3. Type consistency：**
- `LauncherConfig` 字段 `config_dir`/`pending_delete_old`（snake）+ `#[serde(rename_all="camelCase")]` → JSON `configDir`/`pendingDeleteOld`，与 TS 无直接共享（Rust 内部），一致。
- `ApplyMigrationInput`（`dest_path`/`delete_old` + camelCase）← 前端 `MigrationApplyInput`（`destPath`/`deleteOld`）。✓
- `MigrationResult`（`destPath`/`fileCount`/`bytesCopied`/`verified`）← Rust 命令返回的 JSON 键一致。✓
- 命令名：前端 invoke `'data_migrate_to_dir'` / `'data_apply_migration'` 与 Rust `#[tauri::command]` 函数名（下划线）一致。✓
- 进度事件名 `data:migrate-progress`：Rust `app.emit("data:migrate-progress", ...)` 与前端 `listen('data:migrate-progress', ...)` 一致。✓
- `SidecarProcess.child: Mutex<Option<Child>>` kill 惯例（`slot.take()` → `child.kill()` + `child.wait()`）与既有 line 1855 一致。✓

**4. Ambiguity：** relaunch 由前端调（非命令内 `app.restart()`），已在 Task 5 注明，避免 API 不确定性；apply 命令只写 launcher.json。其余明确。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-16-data-directory-migration.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 Task 派全新 subagent + 两阶段 review，迭代快。

**2. Inline Execution** - 当前会话内按 executing-plans 批量执行，带 checkpoint。

选哪种？
