# 数据目录迁移 设计

- **日期**：2026-06-16
- **状态**：已通过 brainstorming，待实现规划
- **范围**：在「数据管理」设置页的数据位置卡新增「迁移目录」能力——把 `~/.lume/` 数据迁移到用户选择的新目录，重启后生效。

## 1. 背景与动机

数据管理设置页（已实现）的「数据位置」卡当前只有「打开目录」。用户需要把整个 `~/.lume/` 迁移到新位置（例如换到更大/独立的磁盘、整理目录、多配置隔离）。

**核心障碍（经探索确认）：** 当前 `~/.lume` 的位置**完全由运行时环境变量 `LUME_CONFIG_DIR` 决定**（否则 fallback `~/.lume`），且**没有任何持久化机制记住用户的选择**——重启即丢失。Rust（`crates/lume-logger/src/config.rs` 的 `resolve_config_dir`）与 TS（`apps/sidecar/src/services/infra/config-paths.ts` 的 `getConfigDir`）两侧解析链一致。因此迁移必须新增一个**跨重启仍生效的路径来源**。

已具备的能力（探索确认）：
- `relaunch`：`tauri-plugin-process` 已注册（`main.rs:1720`）、能力已放行（`capabilities/default.json` 的 `process:default`）、web 端封装已存在（`apps/web/src/lib/desktop-api/native.ts`）。
- sidecar 的 env 继承：desktop spawn sidecar 时 `LUME_CONFIG_DIR` 靠进程 env 自动继承（spawn 代码无需改动即可跟随）。
- 目录遍历模式：`write_data_zip`（`main.rs`）已示范 `walkdir` 遍历 config dir。
- 安全校验范式：`assertSafeCacheTarget`（sidecar `general-settings-service.ts`）。
- sidecar 子进程句柄：desktop 在 `tauri::State` 中持有，可 kill。

## 2. 范围

### 本期包含

- 新增持久化路径来源 `launcher.json`（OS 标准应用配置目录）。
- desktop `main()` 早期读取并 `set_var("LUME_CONFIG_DIR")` 注入。
- 新增 Rust 命令 `data_migrate_to_dir`（复制+校验）与 `data_apply_migration`（写 launcher.json + relaunch）。
- 数据位置卡新增「迁移目录」按钮 + 迁移对话框（选目标→确认→进度→成功后选删旧/保留→自动重启）。
- 迁移后旧目录的处理：复制成功后由用户选「删除」或「保留作备份」。

### 非目标（YAGNI）

- 实时/在线迁移（不停 sidecar 热切换路径）——复杂度过高，本期靠「停 sidecar → 复制 → 重启」。
- 选择性迁移（只搬部分子目录）——一律整目录迁移。
- 多 profile / 多配置目录切换管理 UI——本期只做一次性「迁移到新目录」。
- 符号链接方案（`~/.lume` → 新路径）——Windows 软链需管理员权限、跨平台脆弱，已否决。

## 3. 设计决策总表

| 维度 | 决定 |
|---|---|
| 路径持久化机制 | `launcher.json`（OS 标准应用配置目录）+ `main()` 早期 `set_var` |
| 优先级链 | 外部 `LUME_CONFIG_DIR` env > launcher.json > 默认 `~/.lume` |
| 数据语义 | 复制（非移动）；成功后由用户选删旧/保留 |
| 重启 | 复制+校验成功后自动 relaunch |
| 删旧时机 | 重启后的新会话执行（避免删掉当前运行实例正用的目录） |
| 停止写入 | 迁移前 kill sidecar 子进程（关闭 SQLite 等打开句柄） |
| 跨卷 | 用 `fs::copy`（非 `rename`），跨卷安全 |
| 失败恢复 | 任何 pre-finalize 失败 → relaunch 回旧目录恢复 |

## 4. 持久化与启动注入（launcher.json）

### 4.1 落点

OS 标准应用配置目录下的 `launcher.json`：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/com.lume.desktop/launcher.json` |
| Windows | `%APPDATA%\com.lume.desktop\launcher.json` |
| Linux | `~/.config/com.lume.desktop/launcher.json` |

用 `dirs::config_dir().join("<identifier>").join("launcher.json")` 计算（`dirs` 已是依赖）。`<identifier>` 须与 `tauri.conf.json` 的 `bundle.identifier` 一致（当前为 `com.lume.desktop`，实现时核对）。

**故意不用 Tauri `app_config_dir`**：它需要 app handle（在 `setup` 才有），而注入必须在 `main()` 最早期、`ll::init`（写日志）之前完成。`dirs::config_dir()` handle-free，可在那时取路径，保证新会话的日志也写到新目录。

### 4.2 内容

```json
{
  "configDir": "/abs/path/to/new/.lume",
  "pendingDeleteOld": "/abs/path/to/old/.lume"
}
```

`pendingDeleteOld` 仅在用户选「删旧」时存在，新会话完成删除后清除。

### 4.3 启动注入（main 最早期，ll::init 之前）

```
1. 若外部已设 LUME_CONFIG_DIR（dev/CLI）→ 用它，跳过 launcher.json（保留现有覆盖语义）
2. 否则读 launcher.json → 若有 configDir → set_var("LUME_CONFIG_DIR", configDir)
3. 否则不动（resolve_config_dir 自然 fallback ~/.lume）
4. 之后才 ll::init、Builder、spawn sidecar（sidecar 靠 env 继承自动跟随，spawn 代码零改动）
5. 若 launcher.json 有 pendingDeleteOld 且 ≠ 当前 configDir → rm_rf 旧目录 → 清除该字段
```

**优先级链：外部 env > launcher.json > 默认 `~/.lume`。** 现有 dev/CLI 的 `LUME_CONFIG_DIR` 覆盖语义完整保留。

## 5. 迁移命令与安全

新增两个 Tauri 命令（desktop 进程，不依赖 sidecar）。

### 5.1 `data_migrate_to_dir(dest: String)` → 复制+校验

```
1. 校验目标 dest（在 kill sidecar 之前）：
   - 绝对路径
   - 可写
   - 不能等于当前 config dir、不能在其内、当前 config dir 也不能在其内（防重叠）
   - 必须不存在 或 为空目录（防覆盖他人数据）
   任一不满足 → 返回 Err（清晰中文原因），不动 sidecar。
2. kill sidecar：通过 tauri::State<SidecarProcess> 取子进程句柄并 kill（关闭 SQLite 等打开句柄）。
3. 复制：walkdir 遍历当前 config dir，逐文件 create_dir_all(dest 父) + std::fs::copy。
   期间 app.emit("data:migrate-progress", { done, total }) 报进度。
4. 校验：比对 src 与 dest 的文件数 + 总字节数一致；不一致 → 失败。
5. 返回 { destPath, fileCount, bytesCopied, verified }。
```

不写 launcher.json、不 relaunch。安全范式参考 `assertSafeCacheTarget`（白名单 + realpath 防符号链接逃逸的思想）；复制模式参考 `write_data_zip` 的 walkdir 用法。

### 5.2 `data_apply_migration({ destPath: String, deleteOld: boolean })` → 切换+重启

```
1. 写 launcher.json = { configDir: destPath, ...(deleteOld ? { pendingDeleteOld: <旧 configDir> } : {}) }。
   （旧 configDir = resolve_config_dir() 当前值。）
2. relaunch()（tauri-plugin-process）。
```

### 5.3 为什么两段式

删除/保留的选择发生在复制成功之后（用户选「复制后让用户选」）。故 `migrate` 只复制+校验；用户在成功对话框选删旧/保留后，`apply` 才写 launcher.json（含可选 `pendingDeleteOld`）并重启。

## 6. relaunch 闭环与删旧时机

迁移复制+校验成功后（仍在旧会话）：
1. UI 成功对话框 → 用户选「删除旧目录」/「保留作备份」。
2. 调 `data_apply_migration({ destPath, deleteOld })` → 写 launcher.json → relaunch。
3. **新会话**：main 早期读 launcher.json → `set_var` 指向新目录 → sidecar 用新目录 → 若有 `pendingDeleteOld`，校验 ≠ 当前 configDir 后 `rm_rf` 旧目录 → 清除该字段。

**删旧 deliberately 放在重启后的新会话**：当前运行实例还指着旧目录（open 句柄），现在删会自爆；新会话切到新目录后再删旧，安全。

**回滚保证**：launcher.json 只在复制+校验双成功后写；relaunch 只在 launcher.json 写成功后调；唯一破坏性动作（删旧）发生在已切换到新目录的新会话。运行中的实例绝不会因自身删除动作而损坏。

## 7. UI 流程

### 7.1 数据位置卡

按钮行从单个「打开目录」变为 `打开目录 | 迁移目录`。点「迁移目录」打开迁移对话框。

### 7.2 迁移对话框（多步）

1. **选目标**：调既有 `open_folder_dialog`（返回路径）。显示所选路径 + 实时校验（须空/新建、在当前目录外）；不合法则禁用「下一步」并说明原因。
2. **确认**：警告文案「将复制全部数据到 `<dest>`，完成后自动重启；旧目录可在完成后删除或保留」。
3. **执行**：调 `migrateToDir(dest)`，监听 `data:migrate-progress` 事件显示进度条（`已复制 N/M`）。
4. **成功选择**：「迁移完成。旧目录如何处理？」→ `[删除旧目录]` / `[保留作备份]`（注：选择后将重启）→ 调 `applyMigration`。**此对话框不可取消**——此时 sidecar 已 kill、复制已完成，必须 relaunch 才能恢复正常；两个按钮都走 apply+relaunch，没有「放弃」出口。

### 7.3 新增 web 包装（`apps/web/src/lib/desktop-api/data.ts`）

- `migrateToDir(dest)` → `invoke('data_migrate_to_dir', { dest })`
- `applyMigration({ destPath, deleteOld })` → `invoke('data_apply_migration', { destPath, deleteOld })`
- 进度：监听 Tauri 事件 `data:migrate-progress`（`@tauri-apps/api/event` 的 `listen`）。

## 8. 错误处理与回滚

| 失败点 | 处理 |
|---|---|
| 目标校验失败（重叠/非空/不可写/相对路径） | 校验在 kill sidecar **之前** → 直接返回错误，不动 sidecar，应用正常 |
| 复制中失败（磁盘满/权限/IO） | 清理 dest 半成品 → 错误 toast + 「重启恢复」按钮（relaunch 回旧目录，因 launcher.json 未写 → sidecar 重启恢复） |
| 校验不一致（文件数/字节数） | 视为复制失败，同上 |
| launcher.json 写失败（apply 阶段） | copy 已成功但无法切换 → 错误 + relaunch 回旧目录恢复 |
| relaunch 本身失败 | 罕见；launcher.json 已写但没重启 → 提示用户手动重启，下次启动即生效 |

**失败时不尝试 mid-session 重启 sidecar**（复杂且易错），一律靠 relaunch 回旧目录恢复正常——简单、可靠、一致。

## 9. 测试策略

沿用现有 `cargo test`（desktop）+ `bun test`（web）。

- **Rust 单元（纯函数，cargo test）**：
  - `copy_dir_recursive(src, dest)`：复制临时树，断言逐文件字节 + 文件数一致。
  - `validate_migration_target(src, dest)`：接受空/新建目标；拒绝 `dest==src` / dest 在 src 内 / src 在 dest 内 / 非空已存在 / 相对路径。
  - launcher.json 读写与优先级：env 已设 → 用 env 忽略文件；env 未设 + 文件存在 → 用文件；都没有 → 默认；`pendingDeleteOld` 用后清除。
- **集成**：完整 migrate→apply→relaunch 闭环涉及 Tauri/sidecar，无集成测试脚手架，按 export 功能同款**手动冒烟**：迁移→重启→确认新目录生效（数据位置卡显示新路径、数据完整）→ 选删旧→重启→确认旧目录已删。
- **Web**：迁移对话框若有可抽取的纯状态/校验逻辑则配 bun:test；否则靠 typecheck + 手动。

## 10. 实现边界与风险

- **identifier 一致性**：launcher.json 路径用的 `com.lume.desktop` 必须与 `tauri.conf.json` 的 `bundle.identifier` 一致；实现时核对，建议提为共享常量。
- **main() 注入时机**：必须在 `ll::init` 之前 `set_var`，否则日志写到旧目录；用 `dirs::config_dir()`（handle-free）而非 Tauri `app_config_dir`。
- **sidecar kill 的副作用**：迁移期间 sidecar 不可用（RPC 失败）；迁移命令是纯 Rust 不受影响。失败后需 relaunch 恢复 sidecar。
- **TS `getConfigDir()` 的 mkdir 副作用**：sidecar 启动会 `mkdir -p` config dir。迁移前必须先 kill sidecar，避免它在新目录造出空骨架干扰复制。
- **跨卷**：用 `fs::copy` 不用 `fs::rename`（rename 跨卷失败）。
- **macOS .app 重启不保留 env**：这正是必须用「launcher.json 文件 + main 早期 set_var」而非「指望 env 跨重启存活」的原因。
