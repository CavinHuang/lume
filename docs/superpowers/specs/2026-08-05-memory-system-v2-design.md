# Lume 记忆系统 v2 设计规范

**日期**：2026-08-05  
**状态**：草稿  
**背景**：对当前 `~/.claude/projects/.../memory/` 文件系统的全面重设计

---

## 1. 背景与问题

当前记忆系统（v1）有四个核心痛点：

1. **写入被动**：agent 不知道何时该写、写什么，重要决策和踩坑经常在 session 结束后丢失，下次重复犯错。
2. **召回失真**：记忆文件随时间累积过期内容，但 MEMORY.md 索引里没有新鲜度信号，过期信息被当作事实用。
3. **文件臃肿**：project 类型的记忆采用追加模式，只增不减，`lume-proactive-agent-parity.md` 已达 31 行高密度叙事，读完才知道有没有用。
4. **分类漂移**：4 种类型（user/feedback/project/reference）语义模糊，`reference` 实际存的是约束而非外部系统指针，agent 不知道新内容该放哪里。

**参考来源**：
- Claude Code 源码（`src/memdir/`）：sideQuery 语义召回、mtime freshness caveat、extract-memories 后台 agent、KAIROS 日志模式
- TencentDB Agent Memory（GitHub）：L0→L3 分层蒸馏、budget-aware 召回、Skill/Wiki/CodeGraph 资产类型

---

## 2. 设计目标

| 目标 | 衡量标准 |
|------|----------|
| 写入端主动 | agent 在trap/PR merged/用户要求等关键节点无需提示主动写入 |
| 召回精准 | 每次 session 开始，agent 能在扫描 MEMORY.md 后定向 Read 最相关的 ≤3 条 |
| 文件可扫描 | 任意 topic file ≤ 15 行，5 秒内读完判断相关性 |
| 生命周期清晰 | 已完成项目在 MEMORY.md 里可视为 archive，不占 active 视野 |
| 不重复踩坑 | rule 类型记忆在首次触发场景时被 sideQuery 自动选中 |

---

## 3. 核心架构：三层模型

```
┌─────────────────────────────────────────┐
│  Layer 1: MEMORY.md 索引                │  ← 始终注入 context，给方向
│  状态分区 + 年龄显示                    │
└─────────────────┬───────────────────────┘
                  │ agent 按 description 定向 Read
┌─────────────────▼───────────────────────┐
│  Layer 2: Topic Files 知识主体          │  ← sideQuery 语义选取，≤5条进 context
│  rule / task / archive 三类型           │
│  结构化 body，≤15 行                    │
└─────────────────┬───────────────────────┘
                  │ /distill 蒸馏
┌─────────────────▼───────────────────────┐
│  Layer 3: Session Log 写入缓冲          │  ← 低摩擦追加，不影响工作流
│  _inbox.md，append-only bullets，distill后清空│
└─────────────────────────────────────────┘
```

对应 TencentDB 的层级：Session Log ≈ L0，Topic Files ≈ L1+L2，MEMORY.md ≈ L3。

---

## 4. 类型收敛：4 → 3

| 新类型 | 覆盖原来 | 语义 | 生命周期 |
|--------|----------|------|----------|
| `rule` | user + feedback + 稳定 reference | 永久约束：用户偏好、平台 quirk、工作流规则 | 永久有效，变更时 replace body |
| `task` | project（进行中） | 活跃项目状态快照：当前在做什么、到哪了、下一步 | `active` → `done`，完成后迁为 `archive` |
| `archive` | project（已完成）+ reference（历史） | 已交付的知识沉淀：决策记录、踩坑教训、完成证据 | 稳定，按需检索 |

**废弃映射**：
- `user` → `rule`（用户偏好是永久约束的一种）
- `feedback` → `rule`
- `project`（active）→ `task`
- `project`（done）→ `archive`
- `reference`（外部系统指针）→ `rule`
- `reference`（技术约束）→ `rule`

---

## 5. 数据模型

### 5.1 Frontmatter Schema

```yaml
---
name: <kebab-case-slug>            # 必填，全局唯一，用于 [[link]] 引用
description: "<高信噪比一句话>"    # 必填，sideQuery 召回的核心依据，见 §8.1
type: rule | task | archive        # 必填
status: active | done              # task 类型必填，rule/archive 不填
modified: YYYY-MM-DD               # 必填，distill 时更新
---
```

**说明**：
- 移除 `metadata.node_type`、`metadata.originSessionId`（实现细节，非记忆内容）
- `status` 只对 `task` 类型有意义：`active` = 当前在做，`done` = 完成待归档
- `modified` 用于 MEMORY.md 年龄计算，distill 时同步更新

### 5.2 Body 模板

#### `rule` 类型（≤10 行）

```markdown
<规则陈述，1-2 行，直接说结论>

**Why**：<为什么这条规则存在，1 行>

**How to apply**：<怎么用，1-2 行或 bullet>
```

示例（`windows-worktree-trap.md`）：
```markdown
Windows 上清理 git worktree 禁止用裸 `rm -rf`。NTFS junction 指向主仓目录，
GNU rm 会递归进入删除主仓源码。

**Why**：2026-08-05 清理 worktree 时 1886 个文件从磁盘消失，git restore 恢复。

**How to apply**：优先用 `git worktree remove <path>`；必须用 rm 前先
`Get-ChildItem <path> -Force -Recurse | Where { $_.Attributes -band ReparsePoint }`
确认无 junction；清理前确保已 commit/stash。
```

#### `task` 类型（≤15 行）

```markdown
**What**：<一行说清楚这是什么项目>

**Status**：<当前状态，最后一个关键里程碑，1 行>

**Next**：
- <待做项1>
- <待做项2>（≤3 条）

**Constraints**：
- <关键约束/踩坑>（≤3 条）
```

#### `archive` 类型（≤15 行）

```markdown
**Summary**：<做了什么、怎么结束的，2-3 行>

**Key decisions**：
- <重要决策>

**Refs**：
- spec: `docs/superpowers/specs/...`
- plan: `docs/superpowers/plans/...`
```

### 5.3 强制约束

- **body ≤ 15 行**（不含 frontmatter）。超出部分移至 spec/plan 文档，在 Refs 中引用。
- **禁止追加模式**：有新信息时 replace body，不在末尾追加段落。
- **file 命名**：`{type}_{name}.md`，延续现有约定。

---

## 6. MEMORY.md 新格式

MEMORY.md 始终注入 context，是 agent 的方向盘，不是内容仓库。

### 6.1 结构

```markdown
## 🔴 Active Tasks（优先加载）
- [Agent Island] `task` 0d — Phase 2 macOS 刘海待做（macos-26, NSPanel）
- [Browser Annotation] `task` 1d — Plan 5-8 完成待提交

## 📌 Rules（始终适用）
- [Windows worktree 陷阱] `rule` 0d — rm -rf 禁用，NTFS junction 跨越删源码
- [Bun install 要求] `rule` 0d — 新 worktree 缺 node_modules，先 bun install
- [Commit 风格] `rule` 3d — emoji 前缀，主题合并 ~5-7 commit
- [Main 分支保护] `rule` 1d — 禁直接 push，必须走 PR

## 👤 Persona（始终适用）
- [用户画像] `rule` 0d — Leo，Lume 主开发，中文交流，emoji commit

## 📚 Archive（按需检索）
- [Proactive Agent] `archive` 1d — PR#8-10 merged，三周期完成
- [Input Queue] `archive` 0d — 98e74a3e，Codex 对齐，平铺+dnd-kit
- [Browser Annotation] `archive` 1d — Plan 1-8 完成，preload 合并
...
```

### 6.2 规则

- **Active Tasks** 分区：只放 `status: active` 的 task，任务完成立即移走
- **Rules** 分区：所有 `rule` 类型，按重要性排序（高频触发的放前面）
- **Persona** 分区：1 条用户画像记忆，单独分区强调
- **Archive** 分区：`status:done` 的 task（待下次 distill 转型）和 `archive` 类型，agent 不自动加载，需要时手动 Read
- **年龄显示**：`Nd`（N 天前）在 distill 时更新；> 30 天的 rule 条目末尾加 `⚠️`
- **每条 ≤ 100 字符**：名称 + 类型 + 年龄 + 一句 hook，多余细节在 topic file 里

---

## 7. 写入纪律

### 7.1 立即写入（不可 defer）

| 触发条件 | 写入目标 | 类型 |
|----------|----------|------|
| 发现新平台约束/踩坑 | 新建 topic file | `rule` |
| 用户明确要求 remember | 新建或更新 topic file | 按内容判断 |
| PR merged / 任务完成 | 将对应 task 的 `status` 改为 `done` | `task` |
| 确认一个长期有效的偏好/规则 | 新建或更新 topic file | `rule` |

### 7.2 Session Log 追加（低摩擦记录）

在 `_inbox.md` 追加时间戳 bullet，不做分析：

```markdown
# 2026-08-05

- 13:15 Agent Island Phase 2 完成，PR#21 commit 133293c0，macOS验证待做
- 13:40 发现 NTFS junction 陷阱，1886 文件丢失，git restore 恢复
- 14:20 input queue 全部合并 main 98e74a3e，手动验证待做
- 15:00 /distill 触发，上述内容已蒸馏入 topic files，_inbox.md 已清空
```

适用场景：
- 做了关键决策但还不确定是否值得保存
- 任务状态发生变化（开始/暂停/转向）
- 发现潜在约束但需要验证

### 7.3 禁止写入

以下内容**不应**进入记忆系统（即使用户明确要求，也要询问"这里有什么不显然的信息"）：

- 可从当前代码/git history 推导的内容
- CLAUDE.md 里已有的内容
- 仅在当前 session 有效的临时状态
- PR 列表、活动摘要等流水账（应问：有什么不显然的决策值得保存？）
- 超过 15 行的大段叙事（拆分或移至 spec）

---

## 8. 召回机制

### 8.1 Description 质量规范

`description` 是 sideQuery 的核心输入，决定召回精度。

**写法要求**：
1. 包含关键词（技术术语、文件名、场景触发词）
2. 说清楚"什么时候该用这条记忆"
3. 避免泛化描述

```
❌ 差：Lume Agent 灵动岛 Phase 1 完成（2026-08-05）
✅ 好：Agent Island Phase 2 macOS 刘海待做（macos-26, NSPanel, Swift, SwiftUI）

❌ 差：用户提交偏好
✅ 好：大量 WIP 提交时按主题合并 ~5-7 commit，不问粒度（emoji 前缀）

❌ 差：Windows 清 worktree 注意事项
✅ 好：Windows rm worktree 禁用 rm -rf，NTFS junction 跨越删主仓源码（git restore 可恢复）
```

### 8.2 Session 开始时的主动召回

每次接到新任务，agent 应：

1. 扫描 MEMORY.md 的 **Active Tasks** 分区，判断当前任务是否关联已有 task
2. 根据任务关键词，定向 Read 1-3 条最相关的 topic file
3. 对 modified > 7 天的 `task` 文件，先验证 Status 是否仍准确
4. 对 modified > 30 天的 `rule` 文件，加 ⚠️ 提示自己验证

### 8.3 Freshness Caveat

读取 topic file 时：
- `task` 文件 modified > 7 天：先验证 Status 字段，再用 Next/Constraints
- `rule` 文件 modified > 30 天：验证规则是否仍适用（查文件/命令确认）
- `archive` 文件中的 file:line 引用：引用前先确认文件/函数仍存在

---

## 9. /distill 流程

将 session log（L0）蒸馏为 topic files（L1+L2）并更新 MEMORY.md（L3）。

### 9.1 触发时机

- **手动**：`/distill` 或 `/memory:distill`（推荐主要方式）
- **agent 判断触发**：PR merged、重大决策确认等节点，agent 应主动建议运行 distill
- **注意**：Claude Code 没有可靠的 session 结束钩子，"session 自然结束"不是自动触发点，需要 agent 或用户主动执行

### 9.2 执行步骤

```
1. 读取 `_inbox.md`（session log 暂存区）
2. 对每条 log 条目判断：
   a. 更新已有 topic file？（flip status / 更新 Status+Next / 追加 Constraint）
   b. 新建 topic file？（新 rule / 新 archive）
   c. 无需持久化？（临时状态，忽略）
3. 对所有 status:done 的 task，转换为 archive 类型（移 Refs，精简 body）
4. 重写 MEMORY.md：
   a. 重新分区（Active/Rules/Persona/Archive）
   b. 更新年龄（计算 today - modified）
   c. 标记 > 30 天 rule 为 ⚠️
5. 在 `_inbox.md` 末尾追加 `- HH:mm /distill 完成` 标记，然后清空文件
```

### 9.3 Task → Archive 转换规则

`task` 变为 `status: done` 后，在下次 distill 时转换：
- type: `task` → `archive`
- 移除 status 字段
- body 重写为 archive 模板（Summary + Key decisions + Refs）
- description 更新为"已完成"语义（包含 PR 号/commit hash 等关键证据）

---

## 10. 现有记忆迁移映射

共 17 条记忆，迁移策略如下：

| 现有文件 | 新类型 | 新 status | 操作 |
|----------|--------|-----------|------|
| `feedback_commit-style.md` | `rule` | — | rename + 更新 frontmatter |
| `feedback_commit-granularity.md` | `rule` | — | rename + 更新 frontmatter |
| `project_lume-agent-island.md` | `task` | `active` | 重写 body 为 task 模板（≤15行） |
| `project_browser-annotation-codex-parity.md` | `task` | `active` | 重写 body（计划全完成，需确认） |
| `project_lume-input-queue-codex-parity.md` | `archive` | — | 转 archive 模板，body 大幅精简 |
| `project_lume-proactive-agent-parity.md` | `archive` | — | 转 archive 模板，31行→≤15行 |
| `project_lume-quoted-selection-proma-parity.md` | `archive` | — | 转 archive 模板 |
| `project_lume-aligns-proma-ui.md` | `task` 或 `archive` | 需确认 | 确认是否还有活跃工作 |
| `project_lume-vs-proma-feature-gap.md` | `archive` | — | 转 archive 模板 |
| `project_lume-clipboard-write-ipc.md` | `rule` | — | 是平台约束，转 rule |
| `project_lume-models-dev-sync-feature.md` | `archive` | — | 转 archive 模板 |
| `project_lume-model-meta-runtime-data-source.md` | `archive` | — | 转 archive 模板 |
| `project_main-branch-protection.md` | `rule` | — | 是工作流约束，转 rule |
| `reference_baseui-select-value.md` | `rule` | — | 是 UI 约束，转 rule |
| `reference_test-runner-bun-test.md` | `rule` | — | 是工具约束，转 rule |
| `reference_windows-worktree-rm-junction.md` | `rule` | — | 是平台约束，已是最佳实践 |
| `reference_worktree-bun-install.md` | `rule` | — | 是工具约束，转 rule |
| **（新增）** `user_leo-persona.md` | `rule` | — | 新建用户画像，TencentDB L3 补充 |

迁移后分布：**rule: 10 条，task: 2-3 条，archive: 5-6 条**。

---

## 11. 成功标准

| 场景 | v1 行为 | v2 目标行为 |
|------|---------|-------------|
| 新 session 开始处理 worktree 任务 | 全量扫 MEMORY.md，可能忽略 junction 陷阱 | 扫 MEMORY.md → description 命中 → 主动 Read rule 文件 |
| PR merged | 人工提示才更新 project 记忆 | 立即 flip task status:done，追加 session log |
| 查某个已完成项目的状态 | 读 30 行密文才找到结论 | Read archive 文件，5 行内看到 Summary + Refs |
| 询问 commit 风格 | 读 feedback 文件（可能109天旧） | MEMORY.md 显示年龄，⚠️ 提示验证 |
| 新踩坑发生 | 记在 project 末尾，下次难找 | 立即新建 rule 文件，下次 sideQuery 精准命中 |

---

## 12. 待确认事项（实现前需用户确认）

1. `project_lume-aligns-proma-ui.md`：是否还有活跃的 UI 对齐工作？→ 决定 `task:active` 还是 `archive`
2. `project_browser-annotation-codex-parity.md`：Plan 5-8 完成，但有"后续批（2026-08-04，未提交）"——这批 4 项修复是否已提交？→ 影响 status
3. `/distill` 的触发方式：实现为 slash command（`/memory:distill`）还是 agent 自主判断？
4. Session log 文件名：`_inbox.md`（memory dir 顶层，distill 后清空）。选用下划线前缀而非 `logs/` 目录，避免被 gitignore 或清理脚本误删。
5. 是否需要保留 `[[link]]` 交叉引用语法？（当前部分文件有用，部分没有）

---

*本 spec 基于以下研究：*
- *Claude Code 源码分析（`src/memdir/`）：sideQuery、memoryAge、KAIROS 模式*
- *TencentDB Agent Memory README：L0-L3 分层、budget-aware 召回*
- *当前 17 条记忆文件的实地解剖*
