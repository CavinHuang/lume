# Proactive Agent 对标差距分析：Lume vs Proma PR #1409

> **日期**：2026-08-03
> **对标对象**：[`proma-ai/Proma#1409`](https://github.com/proma-ai/Proma/pull/1409) "feat: Proactive Agent - 主动记忆 + 主动建议 + 主动中心"（76 文件，+10524 行）
> **目的**：逐项核对 Lume 现状，定位真实缺口，为后续 spec → plan 决策提供事实依据
> **方法**：两个并行子代理分别深读 Proma PR 全量实现与 Lume `memory-v2` / `automation` / `routine` / agent 注入链，关键缺口项均经主会话二次核实

---

## 执行摘要

**核心结论**：Proma PR #1409 的三大能力中，**主动记忆 Lume 已全面具备且数据模型更成熟**，**主动建议是 Lume 唯一的实质空白**，**主动中心依赖建议系统 + 已有 automation 即可组合**。

| 子系统 | Lume 状态 | 工作性质 | 优先级 |
|---|---|---|---|
| ① 主动记忆 | ✅ 数据模型/去重/冲突/召回/注入/UI 均已具备，多处更强 | 增量补 L3 Persona + 触发面 | P1 |
| ② 主动建议 | ❌ 完全空白（已确认） | **全新子系统** | **P0** |
| ③ 主动中心 + 工作模式分析 | ⚠️ 有数据源底座，缺分析器与聚合视图 | 新建（依赖②） | P2 |

**关键洞察**：「同样的思维在 Lume 实现」≠ 重做三大能力。记忆系统重做是纯重复劳动，且会丢弃 Lume 已有的更优设计（claim 三元组、6 态状态机、SmartAdd 8 动作）。真正能让 Lume 获得完整 Proactive Agent 体验的，是补上**主动建议子系统**，复用已有 memory-v2 + automation + planning。

---

## 一、主动记忆子系统对比

### 1.1 能力对比矩阵

| 能力维度 | Proma 实现 | Lume 实现 | 判定 |
|---|---|---|---|
| **记忆分类** | 5 类：`fact/preference/correction/sop/todo_context` | 5 类：`preference/fact/decision/lesson/state` | ⚠️ 分类不同（见 1.3） |
| **状态机** | `confirmed` 布尔 + correction 独立 4 态 | 6 态：`active/archived/superseded/pending_conflict/pending_low_confidence/suspected_stale` | ✅ **Lume 更强** |
| **Claim 三元组** | 无（纯 content + type） | `subject/predicate/object + qualifiers` + 预定义常量 | ✅ **Lume 独有** |
| **去重** | fingerprint + 包含度 ≥0.6（2 层） | SmartAdd 8 动作：精确指纹 + claim 键 + Jaccard ≥0.82 + 语义 dot ≥0.92（8 层） | ✅ **Lume 远更强** |
| **冲突检测** | claim object 不等 → pending | claim 冲突 + 9 组反向词对 + preferred-name 冲突 | ✅ **Lume 更强** |
| **过期检测** | 无显式 | `suspected_stale`（搬家/迁到/现在 等词触发） | ✅ **Lume 独有** |
| **召回机制** | BM25 + LLM 改写 + embedding + 规则，RRF 融合（k=60） | 多源（entries + MEMORY.md + daily + runs）+ lexical 加权 + LLM rerank + 语义 | ✅ **对等，机制不同** |
| **召回阈值** | 归一化 `RECALL_MIN_SCORE=0.12`；融合 `finalScore≥0.35` | `score≥7`（stale 门槛）；语义 `dot>0.25` | 对等 |
| **语义召回** | 可选 local（node-llama-cpp 768d）/ api | 本地 ONNX embeddinggemma（默认本地） | ✅ **Lume 默认本地，更强** |
| **停用词** | 完整中英文表（含中文功能词/量词/时间词） | 仅 14 英文词，**无中文停用词**（靠 CJK 二元 gram） | ⚠️ Proma 更全 |
| **查询改写** | LLM 改写为多查询 + 10min LRU 缓存 + 规则同义词兜底 | query-planner LLM（subject + predicates）+ 正则 fallback | 对等，机制不同 |
| **提取触发** | 会话结束（run complete/fail），取最近 **20 条**对话 | run 完成后（`lume-runner`）+ workflow-hooks，仅取 **userMessage** | ⚠️ Lume 触发面窄（见 1.3） |
| **提取分类判定** | LLM 明确 5 类 + 规则兜底 | 显式正则 + LLM，kind 靠关键词（`prefer/actually`）判定，较粗 | ⚠️ Proma 更明确 |
| **L3 Persona** | 完整：生成 + 增量更新 + 反馈回流 + 规则兜底，6 段 Markdown | **仅 `preferred_name`（称呼/名字）** | ❌ **Lume 重大缺口** |
| **纠正审批** | 一等公民：专类 + 专状态机 + persona 回流 + 撤销 | 通用 `MemoryV2PendingItem`（conflict/stale/low-confidence）open/resolved/archived | ⚠️ 底座有，缺 persona 回流 |
| **Prompt 注入** | 3 块：`<persona_profile>` + `<working_memory>` + `<memory_context>` | 双通道：user-message-prefix（**9 段分类**）+ system memory sections | ✅ **Lume 更精细** |
| **当前任务快照** | `<working_memory>`（memory atoms 的 todo_context 前 5 条） | `<planning_todo_context>`（planning 系统待办，`context-assembler.ts:261`） | ✅ **Lume 等价且架构更干净** |
| **MCP 工具** | 7 个：search/capture/stats/corrections/confirm/reject/analyze | 3 个：search/read/remember | ⚠️ Lume 少审批/统计类（见 1.3） |
| **记忆看板 UI** | `ProactiveMemoryPanel`：4 统计 + 模式切换 + persona 编辑 + 搜索 + pending 审批 | `MemorySettings.tsx`：`snapshot.counts` 统计 + `resolveMemoryPending` 审批 + pending 视图 | ✅ **Lume 已覆盖核心**（persona 编辑因 persona 弱而缺） |
| **配置安全** | `.env` 同源原则 + baseUrl 校验 + 禁用开关 | `policy.ts`（工具 allow/deny + citations + sources + retrieval） | 不同机制，各有侧重 |
| **内置 Skill** | `memory-daily` | default-skills 机制已有，无此特定 skill | ⚠️ 缺特定 skill |

### 1.2 Lume 优势项（无需补，部分更强）

- **Claim 三元组知识图谱**：`{subject, predicate, object}` 让记忆可结构化查询与冲突检测，Proma 完全没有。
- **6 态状态机 + suspected_stale**：比 Proma 的 `confirmed` 布尔 + 独立 correction 状态机表达力强得多，且独有过期检测。
- **SmartAdd 8 动作去重链**：8 层判定（精确指纹 → claim 键 → Jaccard 0.82 → 语义 0.92 → low_confidence → preferred-name 冲突 → 反向词 → stale），远超 Proma 的 2 层。
- **本地 ONNX 语义召回**：默认本地 embeddinggemma，无云端依赖；Proma 默认 off。
- **9 段分类注入**：`<lume_memory_context>` 拆成 user_voice/user_profile/recalled_claims/global_memory/global_preferences/workspace_core/conversation_history/relevant_recall/maybe_stale 9 段，比 Proma 3 块更精细。
- **Markdown 白盒存储**：YAML frontmatter + body，原子写 + secret 自动 REDACTED。
- **记忆看板 UI 已有**：`MemorySettings.tsx` 覆盖统计 + pending 审批。

### 1.3 Lume 真实缺口（已收窄，按优先级）

> 经二次核实，`working_memory`（→ `planning_todo_context` 已覆盖）与记忆看板 UI（→ `MemorySettings.tsx` 已覆盖）**不是缺口**。

| 优先级 | 缺口 | 现状 | Proma 对照 | 工作量 |
|---|---|---|---|---|
| **P0** | **L3 Persona 完整用户画像** | `profile.ts` 仅提取 `preferred_name`（称呼/名字），无职业/时区/语言/技能/兴趣/交互协议等维度 | `persona.ts`：LLM 生成 6 段 Markdown 画像 + 增量更新 + 反馈回流 + 规则兜底 | 中（新模块 + LLM prompt + 注入 + UI 编辑） |
| **P1** | **提取触发面** | `pre_compaction` / `micro_reflection` 枚举存在但**无生产代码**（仅 smoke 脚本）；run 完成后仅取 `userMessage`，可能丢失 assistant 上下文 | 会话结束取最近 20 条 user/assistant 对话；有三态模式（off/rule/llm） | 小-中（补触发点 + 对话窗口） |
| **P2** | **中文停用词表** | 无中文停用词，靠 CJK 二元 gram | 完整中文功能词/量词/时间词停用词表 | 小（加表 + 查询侧过滤） |
| **P2** | **MCP 工具补齐** | 仅 search/read/remember | 多 stats/corrections 列表/confirm/reject（审批类） | 小（wrapper 已有 pending 能力） |
| **P2** | **correction → persona 回流** | 无（因 persona 本身不完整） | 确认纠正后异步刷新 persona | 随 P0 persona 一起做 |
| **P3** | **memory-daily Skill** | 无此特定 skill | 有 | 小（skill 内容） |

**记忆子系统结论**：除 **L3 Persona** 外，其余缺口均为小到中等增量。Lume 的记忆底座在工程成熟度上**领先 Proma**，不值得为对齐而重做。

---

## 二、主动建议子系统对比

### 2.1 状态：❌ 完全空白（已确认）

全 `apps/` 范围搜索 `suggestion|proactive|SuggestionBanner|signal_extract|frequency|working_pattern`，命中均为无关项（`editor-mention-suggestions` @提及、`advisor-service` code review advisor、`PermissionBanner` 等）。**Lume 不存在任何主动建议引擎、信号提取、频率学习或建议横幅。**

> 注意：`agent-runtime/advisor/advisor-service.ts` 是「coding turn 事后 code review」，输出 `clear/suggestion/concern/blocker`，**与 Proma 的主动建议是不同概念**，不可复用为建议引擎。

### 2.2 需移植的 Proma 完整能力

| 模块 | Proma 实现 | 核心设计 |
|---|---|---|
| **信号提取**（`signals.ts`） | 6 词典/正则表，零 LLM | `CORRECTION_PATTERNS`(conf 0.95) / `FOLLOWUP_PATTERNS`(0.8) / `AUTOMATION_PATTERNS`(0.85) / `TODO_PATTERNS`(0.72) / `NEGATIVE_PATTERNS`(拒绝门) / `POSTPONE_PHRASES`(延后过滤)；重复意图检测（`≥2 次` 且跨 `≥2 条`） |
| **5 类规则**（`rules.ts`） | 信号 → 候选 | correction / followup / automation / repeat / todo + skill 后处理（`sop≥3`）；每类有 `duplicateKey` |
| **决策引擎**（`engine.ts`） | 误报控制 + 预算 | `threshold=0.6`（`rawConfidence × typeWeight ≥ threshold`）；`maxPerEvaluation=1`；`maxPerSession=2`；类型权重 correction/followup/automation=1.0、skill=0.8、todo=0.9；明确拒绝门 |
| **频率学习**（`feedback.ts`） | 越用越好用 | `accepted×1.2`（上限 2.0）/ `ignored×0.8`（下限 0.2）/ `never` 永久屏蔽；**连续忽略 3 次自动静默**；`MAX_RECORDS=500` |
| **数据模型**（`suggestion.ts`） | 类型 + 动作 | `SuggestionKind`(5) + `SuggestionAction`(4：memory_correction / open_automation_create / open_memory_board / open_skill_creator) + Candidate + Record(status: suggested/accepted/ignored/never) |
| **会话钩子**（`service.ts`） | 编排 | 会话结束取最近 30 条；加载去重源（automation titles / correction rules / sop count）；静默跳过；持久化 + IPC 广播 |
| **横幅 UI**（`SuggestionBanner.tsx`） | 三态 + 实时 | 24h 过期；会话隔离；订阅 `onSuggestionsChanged` 实时刷新；接受/忽略/不再建议 |
| **SDK 消息桥接**（`sdk-messages.ts`） | 格式适配 | SDKMessage（嵌套）↔ AgentMessage（平铺）文本提取 |

**核心理念（必须移植）**：*主动性 = 用户接受率，不是建议次数*。所有模型 Recall 98%+ 但误报率 51-65%，**「该沉默时沉默」也是能力**——误报控制（阈值 + 预算 + 频率学习 + 静默）是一等公民。

### 2.3 Lume 可复用底座

| 底座 | 位置 | 复用方式 |
|---|---|---|
| **automation**（定时任务） | `services/automation/`（cron/once/interval/manual + misfirePolicy + 原子持久化） | 建议的 `open_automation_create` action 直接调用现有 `createAutomationJob` |
| **memory-v2 pending** | `MemoryV2PendingItem`（conflict/stale/low-confidence） | 建议的 `memory_correction` action 复用 pending 审批链 |
| **planning todo** | `planning_todo_context` | 建议的 `todo` / `open_memory_board` 可对接 planning |
| **IPC 4 层桥** | shared channel → RpcHandler → `sidecar_call` → Electron main | 建议的实时推送（对应 Proma `SUGGESTIONS_CHANGED` 广播）走现有通道 |
| **default-skills 机制** | `services/skills/` | `suggestion-daily` skill 可直接加入 |

**建议子系统结论**：这是 Lume 唯一需要**全新构建**的子系统，但底座充足——automation / pending / IPC / skills 全部可复用，新工作集中在**信号提取 + 规则引擎 + 频率学习 + 横幅 UI** 四块。

---

## 三、主动中心 + 工作模式分析对比

### 3.1 状态与缺口

| 能力 | Lume 现状 | 缺口 |
|---|---|---|
| **Proactive Today 聚合视图** | 有 `PlanningView`（可加 tab），有 automation 列表 / memory pending / routine 等数据源 | ❌ 缺聚合 tab（建议卡 + 主动任务 + 待确认 + 画像 + 统计） |
| **工作模式分析器** | 无（routine 是固定 10 activity 模板，不学习用户模式） | ❌ 缺低频 LLM 分析器（从记忆推断隐含模式） |
| **schema 严格校验** | memory-v2 有 schema 校验经验 | 分析器候选需新建校验（`ALLOWED_KINDS=[automation,skill,todo]`，`MAX_CANDIDATES=3`，LLM 只产候选不直接创建） |

**结论**：主动中心依赖主动建议系统先就位（聚合视图要展示建议卡，分析器要写入 suggestions）。**应作为第二个周期**。

---

## 四、后续路径建议

### 推荐顺序（按依赖与价值）

```
周期 1（P0）：主动建议系统          ← 唯一实质空白，独立可交付
    ↓ 复用 memory-v2 + automation + planning
周期 2（P1a）：L3 Persona 完整画像   ← 记忆子系统最大缺口，增量
    ↓
周期 3（P2）：主动中心 + 工作模式分析 ← 依赖周期 1 的建议数据
    ↓
周期 4（P1b，可选）：提取触发面 + 停用词 + MCP 工具补齐  ← 记忆小增量
```

### 各周期工作量初估

| 周期 | 性质 | 新代码主体 | 复用底座 | 风险 |
|---|---|---|---|---|
| **1. 主动建议** | 全新子系统 | signals / rules / engine / feedback / SuggestionBanner / IPC | automation + pending + IPC + skills | 中（误报控制需迭代调参，建议子代理验证） |
| **2. L3 Persona** | 增量 | persona 生成模块 + LLM prompt + 注入段 + UI 编辑 | memory-v2 atoms + claim + MemorySettings | 低-中 |
| **3. 主动中心** | 新建 | analyst + Proactive Today 视图 | 周期 1 suggestions + automation + memory | 低（依赖项清晰） |
| **4. 记忆小增量** | 补齐 | 触发点 + 停用词 + 工具 wrapper | 现有 memory-v2 | 低 |

### 架构落点（Lume sidecar 架构）

- **建议引擎 / 频率学习 / 分析器** → `apps/sidecar/src/services/suggest/`（后端能力，进程隔离，崩溃域独立，符合记忆 `[[lume-vs-proma-feature-gap]]` 的「后端类能力放 sidecar 成本更低」）
- **会话结束钩子** → 复用 `lume-runner.ts` 的 `fireRunAfterComplete`（与现有记忆提取同点）
- **SuggestionBanner / Proactive Today** → `apps/web/src/components/`（渲染层）
- **实时推送** → 现有 IPC 4 层桥（无需原生 API，不涉及 desktop main）

> 与 Proma 的关键差异：Proma 全部在 Electron main 进程；Lume 拆 sidecar（逻辑）+ web（UI）+ desktop（壳），**建议系统不依赖任何原生 API**，落点干净，无记忆 `[[lume-vs-proma-feature-gap]]` 所述的「原生 API 必须放 desktop」约束。

---

## 附录 A：关键阈值常量对照

| 用途 | Proma | Lume |
|---|---|---|
| 语义去重 | — | dot ≥0.92 |
| 指纹相似 | 包含度 ≥0.6 | Jaccard ≥0.82 |
| 语义召回入选 | cosine >0.68 | dot >0.25 |
| 召回最低分 | 归一化 0.12 / 融合 0.35 | score ≥7 |
| 单条召回截断 | 300 字符 | 240 字符（历史 180） |
| 注入块上限 | 2000 字符 | hardCap 5（有 subject 时 3/5） |
| 提取 maxTokens | 4096 | 单条 700 / 批量 1200 |
| 提取对话窗口 | 最近 20 条 | 仅 userMessage |
| Persona atoms 上限 | 前 40 条（排除 todo_context） | — |
| 建议 threshold | 0.6 | — |
| 建议 maxPerEval / Session | 1 / 2 | — |
| 频率 accepted / ignored | ×1.2 / ×0.8 | — |
| 静默连续忽略 | 3 次 | — |
| 建议横幅过期 | 24h | — |
| 分析器 MAX_CANDIDATES | 3 | — |

## 附录 B：信息来源与可信度

- **Proma 侧**：子代理从 `gh pr diff 1409` 提取全量实现（head SHA `5a716152`），含两个设计文档 + memory/suggest 全模块 + UI + skills + config。所有阈值/词典/公式均代码原文。
- **Lume 侧**：子代理逐文件读取 `memory-v2/`（17 核心文件）+ automation + routine + agent 注入链；主会话二次核实 `context-assembler.ts`（working memory）、`MemorySettings.tsx`（看板 UI）、`profile.ts`（persona 范围）。
- **已澄清的伪缺口**：working_memory（Lume 用 planning_todo_context 等价覆盖）、记忆看板 UI（MemorySettings.tsx 已覆盖统计+审批）——**均非缺口**。
- **待后续核实**：周期 2 Persona 实施前需确认 memory-v2 atoms 是否能提供足够画像原料（当前 5 类无明确「画像」类，可能需扩展 kind 或靠 tags）。
