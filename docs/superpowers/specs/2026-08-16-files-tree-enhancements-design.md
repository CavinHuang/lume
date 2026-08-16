# 文件树三增强设计（晋升到项目 / 来源消歧 / 附加目录迷你树）

> 2026-08-16 · 分支 `feat-files-tree-enhancements`（基于 main `a0aebd82`）· 状态：设计已确认
> 参考：Proma 文件树深挖调研（badge 混合场景标记 / 附加目录独立迷你树 / 移入项目晋升）
> 前置：PR#83 树常驻重设计（已合并——文件树/预览槽现行模型）

## 背景与目标

对照 Proma 调研提炼三个可借鉴点，结合 Lume 现状（四 source 单树+组头，强于 Proma 的互斥 tab）落地：

1. **晋升到项目**：session/memory/legacy 的产物当前困在各自 scope，无法进入项目目录供所有会话使用
2. **来源消歧**：搜索结果跨组混排时无来源标记（组头在搜索态失效）
3. **附加目录**：用户需引用项目外的外部目录（设计稿/共享资源），现状无入口；后端已有 `ExternalAttachmentMeta` 半成品基建（元数据+双作用域持久化，前端零消费）

## ①「晋升到项目」（复制式，三 source）

| 项 | 决策 |
|---|---|
| 源 | session / memory / legacy 条目（文件或目录；project 自身与 MCP 资源不参与） |
| 语义 | **复制**（源保留）；同名默认报错，可选 `conflict: 'rename'`（追加 ` (1)` 类后缀，复用 promote 通道的 rename 模式） |
| 目标 | project 根（v1 不选子目录） |
| 后端 | 新通道 `PROMOTE_FILE_REF_TO_PROJECT`（channel `agent:promote-file-ref-to-project`）：入参 `{ ref: FileRef, workspaceSlug }`（v1 固定 conflict:error，枚举留 v2）；实现=staging 临时目录 cpSync + rename 原子落盘（照抄 `exportLegacyResourceToProject` 的 `agent-files-service.ts:966-1006` 模式）；权限校验沿用 resolveFileRefRoot（三 source 均可读）+ project 根存在性检查；schema zod 强制 conflict 枚举 |
| 前端 | 行右键菜单（`UnifiedFileTree.tsx` TreeEntryRow）：`entry.ref.source` 为 session/memory/legacy 时显示「晋升到项目」（置于"导出到项目（不覆盖）"同区位，legacy 的旧菜单项**删除**由新项取代）；tooltip "复制到项目目录，所有会话可见"；成功后 `markSourceStale('project')` + toast（照抄 :436-437 刷新链路） |
| 交互细节 | 固定 `conflict: 'error'`（v1 不做 rename 子选项）；同名冲突 toast 报"项目目录已存在同名文件"，用户自行重命名源后重试——不弹对话框（保持轻量） |
| 不做 | 移动式晋升（memory/legacy 被记忆管线/旧数据引用，删除断链）；目标子目录选择；批量多选晋升 |

### 与既有通道的关系

- `EXPORT_LEGACY_RESOURCE_TO_PROJECT`（legacy→project，强制 conflict:error）：被本通道**取代**——前端菜单项统一走新通道；旧 channel 与 sidecar 实现保留不删（设置页/其他调用方零破坏，仅前端树不再调用）
- `PROMOTE_FILE_TO_WORKSPACE`（thread→workspace resources）与 `ATTACH_WORKSPACE_RESOURCE_TO_THREAD`（workspace→session）：语义不同（工作区资源层），不动

## ② 来源消歧（搜索态 badge + 组头计数补齐）

- **搜索结果行内 badge**：搜索态（`workspace.search.query` 非空）的扁平结果行，文件名右侧渲染 source 小 badge——文案映射复用 `GROUP_META.label` 首两字（`项目`/`会话`/`记忆`/`旧版`），样式 `text-[9px] rounded bg-foreground/6 px-1 text-foreground/45`（比 Proma 的「会话文件」更短）；project 条目也显示（搜索混排时四 source 平等消歧）
- **树内不加行内 badge**：组头已消歧（Lume 信息架构强项）
- **组头计数补齐**：project 组头也显示顶层数量（去掉 `root.source !== 'project'` 条件，`UnifiedFileTree.tsx:579`），四组统一
- 搜索结果的 badge 不进入非搜索态

## ③ 附加目录迷你树（引用式，双作用域）

```
┌ UnifiedFileTree ─────────────────────┐
│ 工具条: [搜索] [刷新] [折叠] [附加目录] │ ← 新按钮
│ ── 四 source 组照旧 ──                │
│ ── 附加目录（会话）小节标题 ──          │
│   ▾ 📁 D:\refs\design-specs       ✕  │ ← 迷你树根行(折叠+移除)
│       ├ spec-a.md                     │
│       └ imgs/                         │
│ ── 附加目录（工作区·共享）小节标题 ──    │
│   ▸ 📁 E:\shared\icons            ✕  │
└──────────────────────────────────────┘
```

- **入口**：①工具条「附加目录」按钮（`dialog.showOpenDialog` 选系统目录，desktop-only）②拖文件夹到树（drop 即附加）
- **作用域选择**：附加时问一次（轻量 DropdownMenu 二选一：本会话 / 此工作区共享）；或按住拖拽=会话、按钮=菜单选——v1 简化：按钮菜单二选一，拖拽默认会话级
- **语义**：**引用不复制**——新轻量元数据 `external-dirs.json`（`Record<absolutePath, { attachedAt: string }>`，双作用域：thread `.context/` / workspace `.meta/`，与既有 external-attachments.json 同目录并列）。注：既有 `attachment-meta-service` 的键设计是"scope 根内相对路径"（为复制式附加设计），引用式外部目录不在 scope 根内无落点——故复用其**双作用域 JSON + 原子写模式**（`.tmp`+rename）而非存储本身；条目**只读**（预览/复制路径/系统打开/在文件管理器显示；无重命名/移动/删除/晋升）
- **数据流**：
  - 读：新 IPC `LIST_EXTERNAL_DIRS`（返回当前双作用域附加清单）+ `LIST_EXTERNAL_DIR_ENTRIES`（入参 `{ absolutePath }`；列目录返回 `Array<{ name, isDirectory, size?, modifiedAt? }>`——外部路径不在 FileRef 体系；权限=只读，拒绝符号链接）
  - 写：`ADD_EXTERNAL_DIR` / `REMOVE_EXTERNAL_DIR`（upsert/删除 `external-dirs.json` 条目；移除不动物理目录；ADD 校验路径存在且为目录）
  - 预览：v1 预览降级为「系统打开 + 在文件管理器显示」（不做内联预览，留 follow-up）
- **元数据服务**：sidecar 新 service（或 attachment-meta-service 同文件追加独立函数组）`external-dirs-service.ts`：`listExternalDirs(scope)` / `upsertExternalDir(scope, absolutePath)` / `removeExternalDir(scope, absolutePath)`——存储模式照抄 attachment-meta（原子写、按作用域路径解析）
- **展示细节**：workspace 级条目标题行加「共享」badge（`text-[9px]` 蓝灰）；mini tree 根行 `ChevronDown` 折叠 + hover ✕（stopPropagation）；子项懒加载（展开时 LIST_EXTERNAL_ATTACHMENT_DIRECTORY）；空目录显示「空文件夹」；目录物理不存在显示红色「路径不可用」+ ✕
- **状态**：mini tree 展开态/子目录缓存为组件本地 useState（不入 ThreadFileWorkspace——外部目录与 FileRef workspace 生命周期无关）；附加清单本身在元数据 JSON（持久化天然具备）
- **不做**：复制式附加（Proma 模式）；外部文件内联预览；外部目录内搜索（v1 搜索仍限四 source）

## 状态模型变更汇总

- `ThreadFileWorkspace` **零新增字段**（①刷新走既有 sourceStatus；②纯渲染；③全部组件本地+元数据 JSON）
- shared 新增：`PROMOTE_FILE_REF_TO_PROJECT` / `LIST_EXTERNAL_DIR_ENTRIES` / `ADD_EXTERNAL_DIR` / `REMOVE_EXTERNAL_DIR` 四个 channel + 对应 schema
- `ExternalAttachmentMeta` 复用不改（label/absoluteSourcePath 已够）

## 错误处理与边界

- 晋升：源被记忆管线并发写 → cpSync 快照语义（复制时点内容）；project 未绑定 → 菜单项禁用（tooltip 说明）；跨设备剪贴场景无
- 附加：路径不可达/已删除 → 「路径不可用」态；同一目录重复附加（同作用域）→ upsert 去重（按 absolutePath）；权限拒绝 → toast
- 搜索 badge：搜索无结果时空态照旧

## 测试

- sidecar 单测：晋升通道（三 source 各一例+同名 error/rename+project 未绑定）；附加三通道（upsert 去重/只读列目录/移除不动物理）
- web 组件/状态测试：搜索 badge 渲染（mock 无关断言——见 61fde147 教训）；组头四组计数；附加 mini tree（两作用域渲染/折叠/✕/不可用态/拖拽入口）；晋升菜单项条件（source 维度）+ 成功后 markSourceStale
- 实机验证清单：晋升→组头"有更新"→刷新见新文件；搜索混排 badge；附加→浏览→移除→重进面板仍在（持久化）

## 明确不做（YAGNI）

- 移动式晋升 / 晋升目标子目录选择 / 批量晋升
- 树内（非搜索态）行内 badge
- 复制式附加 / 外部文件内联预览 / 外部目录搜索
- 组头右键菜单
