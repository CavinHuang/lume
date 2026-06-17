# 数据管理 设置页 设计

- **日期**：2026-06-15
- **状态**：已通过 brainstorming，待实现规划
- **范围**：在 Lume 设置中新增「数据管理」tab，提供存储概览、统一清理、数据导出三类能力

## 1. 背景与动机

Lume 是本地优先的 AI 工作台，所有数据存在本地 `~/.lume/` 下（记忆、会话、工作区、向量索引、缓存、日志、读书/自动化等业务数据）。核心理念之一是「数据属于你、没有黑箱」。

当前与数据相关的能力**散落**在多处，且有明显缺口：

- 已有但分散：线程回收站（`归档` tab）、日志清理（`clear-cache`，仅 logs 单一类型）、记忆条目删除、文件删除。
- **完全缺失**：按类别的存储用量统计、统一清理入口、全量数据导出。

本设计新增「数据管理」设置页，把这些能力收敛为一个入口，并补齐体积统计与导出。

## 2. 范围

### 本期包含

- **存储概览**：按 4 大类展示 `~/.lume/` 体积占用。
- **统一清理**：聚合可重建数据（日志/向量索引/插件缓存）+ 回收站清空。
- **数据导出**：将 `~/.lume/` 打包为 zip，凭证默认脱敏。

### 非目标（YAGNI，明确不做）

- 数据备份 / 恢复（zip 导出可兼作手动备份，但不做自动备份/恢复流程）。
- 一键重置（清空全部本地数据回到初始态）。
- 凭证加密存储（at-rest encryption）——工程量大，本期不做。
- 本页内提供「删除全部记忆 / 全部会话」等批量不可逆操作——这类按条目的操作留在各自的深度页（记忆 / 归档）。

## 3. 设计决策总表

| 维度 | 决定 |
|---|---|
| 范围 | 存储概览 + 统一清理 + 导出 |
| 与现有页关系 | 数据管理是**唯一清理入口**；`应用日志`（日志查看）、`归档`（按条目恢复/删除）作为深度 tab 保留 |
| 概览粒度 | 4 大类聚合：核心数据 / 派生数据 / 业务数据 / 配置 |
| 安全重点 | 导出剥离凭证 · 不可逆删除强确认 · 数据位置透明 |
| 导出形态 | 原样 zip 打包 `~/.lume/`，凭证默认剥离 |
| 布局 | 顺序卡片流（贴合现有设置页 pattern） |
| 存储扫描 | 落在 Rust（Tauri command），性能远优于 Node fs |
| 清理实现 | 向量索引 / 插件缓存复用现有 `clearCache` 扩展；回收站清空新增 `empty-trash` |

## 4. 页面设计

### 4.1 导航入口

在 `apps/web/src/components/settings/settings-view-state.ts` 新增 tab：

- `id: 'data'`，`label: '数据管理'`，icon 用 `HardDrive`（与记忆项的 `Database` 区分）。
- 导航位置：插入到 `updates` 与 `logs` 之间，让三个数据相关 tab 相邻：
  ```
  …版本与更新(updates) → 数据管理(data) → 应用日志(logs) → 归档(archive)
  ```
- 同步更新 `SettingsViewTab` 类型、`SETTINGS_NAV_ITEMS`、`SETTINGS_PAGE_TITLES`、`SETTINGS_PAGE_SUBTITLES`，并在 `SettingsView.tsx` 增加 `{tab === 'data' && <DataManagementSettings />}` 分支。

### 4.2 布局：顺序卡片流

主组件 `DataManagementSettings.tsx` 自上而下渲染 4 张卡片。

---

**① 存储概览卡**

- 顶部：总计体积 + 横向占比条。
- 4 行分类，每行：`名称 · 体积 · 迷你进度条 · 副标题（含哪些数据 / 是否可重建）`。
- 右上角「刷新」按钮：递归扫描可能较慢，提供手动刷新；页面挂载时自动计算一次。
- **关键约束**：`agent-workspaces/{slug}/` 同时包含核心数据（threads/memory）和派生数据（memory/index），因此**按子路径求和**，不能按顶层目录整体归类。

分类 → 路径映射（以 `~/.lume/` 为根）：

| 类别 | 包含路径 | 可重建 |
|---|---|---|
| **核心数据** | `memory/`（排除 `index/`）、`MEMORY.md`、`.meta/memory.sqlite`、`agent/sessions/`、`agent/runtime-core/`、各 workspace 的 `threads/`·`resources/`·`memory/`（排除 index）·`MEMORY.md`·`.meta/memory.sqlite` | 否 |
| **派生数据** | `memory/index/`（全局 + 各 workspace）、`plugins/cache`、`plugins/data`、`logs/`、`cache/` | 是 |
| **业务数据** | `reading/`、`routine/`、`automation/` | 否（业务功能数据） |
| **配置** | 顶层 `settings.json`·`channels.json`·`im.json`·`im-thread-bindings.json`·`lume.yaml`·`lume.json`·`user-profile.json`·`agent-sessions.json`·`agent-workspaces.json`·`session-states.json`、`skills/`·`default-skills/` | 否（**含凭证**） |

> 路径模式在 `packages/shared` 定义为 `DataCategorySpec`，最终实现以 `apps/sidecar/src/services/infra/config-paths.ts` 为准。

---

**② 清理卡**（统一入口，复用现有安全白名单范式 `assertSafeCacheTarget`）

| 清理项 | 可重建 | 后端 |
|---|---|---|
| ☐ 前端临时缓存 | 是 | 现有 `clear-cache(frontendTemp)` |
| ☐ 预览/渲染缓存 | 是 | 现有 `clear-cache(previewRender)` |
| ☐ 日志缓存 | 是 | 现有 `clear-cache(logs)` |
| ☐ 向量索引 | 是 | **新增**（扩展 `clearCache` 增加 `vectorIndex` 键，删 `memory/index/`，下次召回自动重嵌入） |
| ☐ 插件缓存 | 是 | **新增**（扩展 `clearCache` 增加 `pluginsCache` 键，删 `plugins/cache`·`plugins/data`） |
| ☐ 清空回收站 | 否（不可恢复） | 现有 `agent:cleanup-expired-trash` + **新增 `agent:empty-trash`**（清空全部） |

底部 `[执行清理]`。可重建项一键执行；「清空回收站」走强确认（见 §6）。

> **设计原则**：清理菜单只含「可重建」+「回收站清空」两类，不提供任何批量删除核心数据的入口，保证数据管理的清理默认安全。
>
> **清理入口收敛**：本卡取代 `通用设置(GeneralSettings)` 中原有的「清理缓存」入口——`ClearCacheDialog` 的 `frontendTemp`/`previewRender`/`logs` 迁移至此，`GeneralSettings` 的清理按钮移除或改为跳转到数据管理，确保清理唯一入口。

---

**③ 导出卡**

- 说明文字：「将 `~/.lume/` 打包为 zip」。
- ☐ `包含凭证（API Key / Token / IM 凭证）` ⚠️ —— 默认**关**；勾选时弹二次确认（见 §6）。
- `[选择位置并导出]` → Tauri 原生存框 → 后端流式打 zip。

---

**④ 数据位置与构成卡**（落实「数据位置透明」安全点）

- 显示数据根目录 `~/.lume/` + `[打开目录]`（复用 `reveal_path_in_system`）。
- 简短说明各类数据是什么、存哪、是否含敏感信息。

## 5. 后端能力

### 5.1 Rust 端（`apps/desktop/src-tauri/src/main.rs`，文件系统重活）

- **`data_get_storage_stats(categorySpec)`**：接收前端传入的「类别 → 路径模式」清单，递归求和，返回每类 bytes。Rust 只做扫描，**路径知识留在 TS**（复用 `config-paths.ts`，避免漂移）。`agent-workspaces/*` 等通配由 Rust 在扫描时展开。
- **`data_export_zip({ destPath, includeCredentials })`**：流式将 `~/.lume/` 打成 zip。`includeCredentials=false` 时对 `settings.json`/`channels.json`/`im.json`/`im-thread-bindings.json` 等做脱敏（密钥字段替换为占位，保留 JSON 结构）。脱敏键参考 `crates/lume-logger` 的 sensitive-keys，在 `packages/shared` 定义一份共享脱敏键清单，两边对齐单一来源。

> 选 Rust 而非 sidecar Node fs：递归扫描与流式打包 GB 级数据时，Node fs 会明显卡顿。

### 5.2 Sidecar 端（复用现有范式，最小新增）

- **扩展 `clearCache`**：在 `apps/sidecar/src/services/system/general-settings-service.ts` 的 `SidecarCacheCleanupKey` 增加 `'vectorIndex'`、`'pluginsCache'`，扩展 `assertSafeCacheTarget` 白名单与清理实现。前端清理卡的可重建项直接复用现有 `clearCache(selection)`。
- **新增 `agent:empty-trash`**：在 `apps/sidecar/src/services/agent/agent-thread-manager.ts` 增加「永久删除全部已 trash 线程」（复用现有 `deleteAgentThread` 的清理逻辑：工作目录、runtime-core、session 数据三处）。

### 5.3 Shared（`packages/shared`）

新增类型（建议 `packages/shared/src/types/data-management.ts`，清理相关键并入 `general-settings.ts`）：

- `DataCategoryKey`、`DataCategorySpec`（类别 + 路径模式）、`StorageStats`、`StorageCategoryStat`。
- `ExportZipResult`（bytes、文件数、是否脱敏）。
- `EmptyTrashResult`（删除线程数、释放空间）。
- 扩展 `CacheCleanupKey`：增加 `'vectorIndex'`、`'pluginsCache'`。

### 5.4 前端新文件（贴合现有 pattern）

- `apps/web/src/components/settings/DataManagementSettings.tsx`：4 卡片主组件。
- `apps/web/src/components/settings/data-management-state.ts`：状态 / 类型 / 清理选项 / 类别标签，对齐 `general-settings-state.ts`。
- `apps/web/src/lib/desktop-api/data.ts`：RPC 包装（`getStorageStats`、复用 `clearCache`、`emptyTrash`、`exportZip`），对齐 `system.ts`/`agent.ts`。

## 6. 安全模型

| 安全点 | 落实方式 |
|---|---|
| 导出剥离凭证 | 默认脱敏；勾选「含凭证」→ 二次确认对话框，明示「将以明文导出 API Key/Token」；脱敏文件用占位值替换密钥字段，保留结构 |
| 不可逆删除强确认 | 仅「清空回收站」走强确认：危险样式（红）+ 列出将永久删除的线程数 + 「此操作不可撤销」+ 显式确认；可重建项一键即可 |
| 数据位置透明 | 概览本身即透明工具 + 数据位置卡明示根目录与各类构成 |
| 路径安全（加固） | 所有清理 / 导出的文件系统操作走白名单校验（扩展 `assertSafeCacheTarget`），杜绝越出 `~/.lume/` 的误删 |

## 7. 数据流

1. 页面挂载 → `getStorageStats()` → 渲染概览。
2. 清理卡：用户勾选 → 可重建项 `clearCache(selection)`；回收站 `emptyTrash()`（强确认）→ 成功后重新拉取 stats。
3. 导出卡：存框选路径 → `exportZip({ destPath, includeCredentials })` → 进度 → 完成 toast。
4. 所有调用经 `@/lib/desktop-api/data.ts`。

## 8. 测试策略（沿用现有每页一份 `*-state.test.ts` 约定）

- **单元**：
  - 类别 → 路径映射正确（核心/派生对 workspace 子路径的拆分）。
  - 凭证脱敏器：剥除已知密钥键、保留 JSON 结构与非敏感字段。
  - 路径白名单：拒绝 `~/.lume/` 外的路径。
- **状态**：`data-management-state.ts`（清理选项、类别标签、默认选择）。
- **集成**：
  - `clearCache` 新键确实释放对应空间。
  - `exportZip` 产出合法 zip（可解压、结构完整、脱敏文件无明文密钥）。
  - `emptyTrash` 清空全部已 trash 线程，且不影响归档/活跃线程。
- **错误处理**：扫描无权限目录 → 该类显示「未知」不崩页；导出磁盘满 / 路径不可写 → 明确 toast；被锁文件跳过并上报。

## 9. 实现边界与风险

- **workspace 子路径归类**是概览正确性的关键：`agent-workspaces/{slug}/` 内 threads/memory 属核心、memory/index 属派生，统计必须按子路径而非顶层目录，否则分类会错。
- **脱敏键清单**需与 `lume-logger` 的 sensitive-keys 对齐并保持单一来源，避免遗漏新增的凭证字段。
- **存储扫描性能**：大目录递归求和放在 Rust；UI 提供「刷新」并避免每次切 tab 都重算。
