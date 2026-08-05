# 主动建议系统（Proactive Suggestion）设计 spec

> **周期**：周期 1（方案 B 全量复刻）
> **日期**：2026-08-03
> **对标**：[`proma-ai/Proma#1409`](https://github.com/proma-ai/Proma/pull/1409) § 主动建议 + 主动中心 + 工作模式分析
> **前置分析**：`docs/superpowers/analysis/2026-08-03-proactive-agent-proma-parity.md`
> **状态**：设计稿，待用户审阅 → writing-plans

---

## 目标

让 Lume Agent 从「被动回答」进化到「对的时候提对的建议」。在用户使用过程中识别值得建议的时机，主动提出**轻量、可解释、可反馈**的建议，并通过频率学习实现「越用越准、该沉默时沉默」。

**核心理念**（贯彻全程）：*主动性 = 用户接受率，不是建议次数*。所有 LLM Recall 98%+ 但误报率 51-65%，因此**误报控制是一等公民**——阈值、预算、频率学习、静默机制缺一不可。

**定位边界**：建议系统**不取代** Lume 既有的 planning todo / automation / routine / memory，而是**主动识别时机，建议用户去创建/确认**这些实体。它是「建议层」，不是「执行层」。

## 架构总览

```
┌─ apps/sidecar/src/services/suggest/ ──────────────────────────────┐
│                                                                   │
│  signals.ts ──(词典/正则)──► rules.ts ──(候选)──► engine.ts       │
│       ▲                                          │  误报控制+预算  │
│       │                                          ▼                │
│  adapter.ts                              feedback.ts              │
│  (对话文本)                              (频率学习+静默)            │
│       ▲                                          │                │
│       │                                          ▼                │
│  service.ts ◄────────────────────────────  analyst.ts             │
│  (编排:评估/反馈/分析/持久化/推送)          (LLM 工作模式分析)      │
│       │                                                           │
│  store.ts (suggestions.json: records + typeWeights + enabled)     │
└───────┬───────────────────────────────────────────────────────────┘
        │ workflow-hook 接入
        ▼
  core-suggestion-hooks.ts (监听 run.afterComplete)
        │ 复用
        ▼
  createAutomationJob / smartAddMemoryV2Candidate (既有底座)

┌─ apps/web/src/components/ ────────────────────────────────────────┐
│  agent/SuggestionBanner.tsx   (三态横幅 + 实时订阅)                │
│  proactive/ProactiveHub.tsx   (聚合视图:建议/任务/审批/统计)       │
└───────────────────────────────────────────────────────────────────┘
        │ IPC (sidecar_call 4 层桥)
        ▼
  shared channel 枚举 + RpcHandler
```

**接入方式（关键决策）**：作为 **workflow-hook** 接入（新增 `core-suggestion-hooks.ts` 监听 `run.afterComplete`），与现有 `core-memory-hooks.ts` 平行。**不硬编码进 `lume-runner`**，不触碰 `!this.workflowHooks` 分支。理由：符合 Lume 解耦架构，与记忆提取同点触发但独立演进。

## 模块设计

### 1. 数据模型（`shared/types/suggestion.ts`）

```typescript
type SuggestionKind = "correction" | "followup" | "automation" | "todo" | "skill";

type SuggestionAction =
  | { type: "memory_correction"; raw: string; rule: string }
  | { type: "open_automation_create"; automationTitle: string; suggestedPrompt: string }
  | { type: "open_memory_board" }
  | { type: "open_skill_creator"; topic: string };

interface SuggestionCandidate {
  duplicateKey: string;
  kind: SuggestionKind;
  title: string;
  reason: string;
  evidence: string;
  rawConfidence: number;   // 0-1
  action: SuggestionAction;
}

interface SuggestionRecord extends SuggestionCandidate {
  id: number;
  sessionId?: string;
  threadId?: string;
  workspaceSlug?: string;
  status: "suggested" | "accepted" | "ignored" | "never";
  createdAt: number;
  feedbackAt?: number;
}

type SuggestionFeedback = "accepted" | "ignored" | "never";

type SuggestionTypeWeights = Record<SuggestionKind, number>;

interface SuggestionsIndex {
  version: 1;
  records: SuggestionRecord[];
  typeWeights: SuggestionTypeWeights;
  enabled: boolean;
}

interface SuggestionStats {
  suggestedCount: number;
  todayAccepted: number;
  todayIgnored: number;
  todayNever: number;
  typeWeights: SuggestionTypeWeights;
}
```

**偏离 Proma**：增加 `threadId` / `workspaceSlug`（Lume 多工作区 + thread 模型，Proma 仅 sessionId）。Lume 建议需按 `workspaceSlug` 作用域隔离（与 memory-v2 scope 对齐）。

### 2. 信号提取（`signals.ts`，零 LLM，确定性）

1:1 移植 Proma 的 6 张词典/正则表（详见对标报告 §2.2），核心：
- `CORRECTION_PATTERNS`（conf 0.95）/ `FOLLOWUP_PATTERNS`(0.8) / `AUTOMATION_PATTERNS`(0.85) / `TODO_PATTERNS`(0.72)
- `NEGATIVE_PATTERNS`（明确拒绝门）/ `POSTPONE_PHRASES`（延后过滤）/ `WEAK_INTENT_KEYS`（弱意图）
- `detectRepeatIntents`：同 intentKey `≥2 次` 且跨 `≥2 条` 消息 → repeat 信号
- `normalizeRule`：剥离句首引导词，**绝不删否定词**（防语义反转）
- `isMeaningfulRule` / `hasStrongSignal`（快速路径）

**中英双语**：Proma 表已含中文模式，Lume 直接复用（Lume 用户中文为主，更有价值）。

### 3. 规则引擎（`rules.ts`，信号 → 候选）

5 类规则 + skill 后处理，每类产 `duplicateKey`：
- correction → `correction:{rule.slice(0,30)}`
- followup → `followup:{raw.slice(0,24)}`
- automation → `automation:{title}`
- repeat（count≥2）→ `automation:定期{intent}`
- todo → `todo:{raw.slice(0,20)}`
- skill 后处理（sop 候选 ≥3）→ `skill:sop-candidates`

**去重源加载**：`loadAutomationTitles`（复用 `listAutomationJobs`）/ `loadCorrectionRules`（memory-v2 pending 中 correction tag）/ `loadSopCandidateCount`（memory-v2 中 sop/state 条目）。

### 4. 决策引擎 + 误报控制（`engine.ts`）

默认参数（`DEFAULT_SUGGEST_OPTIONS`）：
- `threshold = 0.6`（`effective = rawConfidence × typeWeight ≥ threshold`）
- `maxPerEvaluation = 1`（单次最多 1 条）
- `maxPerSession = 2`（同会话最多 2 条）
- 类型权重：correction/followup/automation=1.0、skill=0.8、todo=0.9

决策流程：过滤 user 文本 → **明确拒绝门**（最后一条含 NEGATIVE → 整轮 return 空）→ applyRules → 去重四连（已建议/never 屏蔽/同次重复/seenKeys）→ 频率加权 → `< threshold` 进 suppressed → 按 effective 降序取 maxPerEvaluation → 返回 `{candidates, suppressed}`。

### 5. 频率学习（`feedback.ts`，「越用越好用」）

- `accepted → weight = min(2.0, weight × 1.2)`
- `ignored → weight = max(0.2, weight × 0.8)`
- `never → duplicateKey 永久屏蔽 + weight = max(0.2, weight × 0.5)`
- **连续忽略自动静默**：某 kind 最近 3 条记录全 ignored → 静默
- `MAX_RECORDS = 500`（裁最旧）；schema 校验 + 字段长度截断（防膨胀/注入）

### 6. 工作模式分析器（`analyst.ts`，低频 LLM）

从「明确信号触发」进化到「隐含模式发现」——LLM 从 memory-v2 记忆推断用户从未明说但反复出现的工作模式。

- `ALLOWED_KINDS = ["automation", "skill", "todo"]`（保守，不含 correction/followup）
- `MAX_CANDIDATES = 3`
- **输入**：`recentMemoryEntries(60)`（slice 40，content slice 100）+ persona summary（周期2后接入，本期 persona 为空时跳过）+ active corrections 前 5 + 已有 automation 名
- **调用**：复用 memory-v2 LLM 配置（`memory.extraction.modelRef` → `models.agent.fallbackModelRefs`），`temperature=0.2 / maxTokens=4096 / timeoutMs=60_000`
- **schema 严格校验**（`validateAnalystCandidate`）：kind ∈ ALLOWED_KINDS、字段非空、长度上限（title≤40/reason≤200）、kind 与 action.type 匹配；**LLM 只产候选，不能直接创建**，写入 suggestions.json 走三态反馈
- **真实验证目标**（对标 Proma）：注入记忆 → 发现「定期任务」「SOP 沉淀」类隐含模式

**偏离 Proma**：Proma 用独立 `MEMORY_LLM_*`；Lume 复用 memory-v2 模型配置（统一 LLM 适配层，不新增 env）。

### 7. 编排服务（`service.ts`）

- `evaluateSessionSuggestions(messages, {sessionId, threadId, workspaceSlug})`：被 workflow-hook fire-and-forget 调用，取最近 **30 条**对话
  - `enabled` 关 → 空；同会话已达 maxPerSession → 空
  - 加载去重源 → `evaluateSuggestions` → 静默 kind 跳过 → `persistSuggestion` + `notifySuggestionsChanged()`（广播 IPC）
- `handleSuggestionFeedback(id, feedback)`：
  - `accepted + memory_correction` → **一步生效**：`smartAddMemoryV2Candidate`（写 preference/fact + `correction` tag，走 pending）+ `recordFeedback`
  - `accepted + open_automation_create` → `createAutomationJob`（复用）
  - `accepted + open_memory_board` / `open_skill_creator` → 触发 UI 跳转
  - 调 `recordFeedback` 调权
- `runAnalysisAndPersist()`：去重已有 suggested/never → persistSuggestion + 广播

### 8. 存储（`store.ts`）

`<configDir>/suggestions/suggestions.json`（结构 `SuggestionsIndex`），原子写（tmp + rename，复用 memory-v2/automation 的 atomicWrite 模式）+ 内存缓存 + 测试重置函数。API：`persistSuggestion / listSuggestions(status?) / deleteSuggestion / clearSuggestions / suggestionStats`。

### 9. 对话文本适配（`adapter.ts`）

**Lume 侧接入工作**：`lume-runner` 现有 `observer.getUserMessage()` 仅单条。建议评估需多轮（跨消息重复/跟进检测）。决策：adapter 从 **thread transcript / observer** 提取最近 30 条 user 消息纯文本（跳过 tool/thinking），产 `{role, content}[]`。需在 spec→plan 阶段确认 observer 或 agent-thread-manager 的多轮读取 API（候选：`agent-thread-manager.ts` 的 transcript 读取）。

## 接入点（workflow-hook）

新增 `apps/sidecar/src/services/workflow-hooks/core-suggestion-hooks.ts`：
- 监听 `run.afterComplete`（与 `core-memory-hooks.ts:27-40` 同事件）
- 取 `{workspaceSlug, threadId, sessionId, messages}`（messages 由 adapter 提供）
- 调 `evaluateSessionSuggestions`，fire-and-forget（不阻塞完成，try/catch 兜底）
- 在 `createMemoryWorkflowHookService`（`hook-services.ts`）注册该 hook

## UI 设计

### SuggestionBanner（`apps/web/src/components/agent/SuggestionBanner.tsx`）

- 位置：`AgentInput.tsx` 上方（与输入框同区域，git status 显示该文件已有改动，正好相关）
- **会话隔离**：仅展示 `record.threadId === currentThreadId && record.workspaceSlug === currentWorkspace` 的建议
- **过期**：24h 内未处理不展示（`SUGGESTION_EXPIRY_MS`）
- **三态按钮**：接受（✓）/ 忽略（×）/ 不再建议这类（Ban）
- **实时刷新**：`useEffect` 订阅 `onSuggestionsChanged`，新建议生成时立即 reload
- 视觉：复用 Lume 现有 Banner 模式（如 PermissionBanner / AgentRecommendBanner），Sparkles 图标 + 卡片 + slide-in 动画

### ProactiveHub 聚合视图（`apps/web/src/components/proactive/ProactiveHub.tsx`）

**宿主（已确认）**：新增侧栏导航项「主动」+ 独立 `ProactiveHub` 视图（最清晰，与 Proma「默认第一个 tab」精神一致）。需在侧栏导航注册新入口。

布局（1:1 对齐 Proma Proactive Today）：
- header：「主动中心」+ 副标题（关注 N 件事 + M 条建议待定）+「分析工作模式」按钮
- 4 统计卡：主动任务 / 待定建议 / 长期记忆 / 今日采纳
- **Proma 建议**（suggested 列表，kind 标签 + 三态 + 删除）
- **正在关注**（启用 automation，`formatSchedule` 渲染）
- **需要确认**（memory-v2 pending atoms/corrections，跳 MemorySettings）
- **用户画像**（周期2接入前显示占位）

数据源全部复用既有 IPC（listSuggestions / listAutomationJobs / memory snapshot），并发拉取。

## IPC + 实时推送

**新增 shared channel 枚举**（`@lume/shared`，接入现有 4 层桥）：
- 请求/响应：`listSuggestions(status?)` / `actOnSuggestion(id, feedback)` / `getSuggestionStats` / `deleteSuggestion(id)` / `clearAllSuggestions` / `runSuggestionAnalysis` / `setSuggestionsEnabled(bool)`
- 推送：`onSuggestionsChanged(cb) → unsubscribe`

**实时推送通道**：参考 Lume 现有 sidecar→web 推送模式（runtime event stream / EventEmitter，见 `agent-handlers.ts` / `run-observer.ts`）。新建议生成时 sidecar 广播 `SUGGESTIONS_CHANGED`，web 端 `useGlobalAgentListeners`（已存在，grep 命中）订阅后 reload。**接入工作**：确认 Lume 现有「非 run 事件」推送通道（run 事件走 onRuntimeEvent；建议变更需独立通道），在 plan 阶段定位最贴近的现成机制。

## 与 Lume 既有系统的协作（去重边界）

| 建议类型 | 复用的既有系统 | 边界 |
|---|---|---|
| automation / repeat | `createAutomationJob`（cron/once/interval/manual） | 建议只「提议创建」，不自动建；去重查 automation titles |
| correction | `smartAddMemoryV2Candidate` → pending | Lume 无 correction 专类，用 preference/fact + `correction` tag；审批走 MemorySettings pending |
| todo | `planning_todo_context` / TodoView | 建议只「打开待办板」，不创建 todo |
| skill | `SkillSettingsView` | 建议只「打开 skill 创建」 |

**关键偏离**：Proma correction 是独立 `corrections.json` + 专状态机 + persona 回流；Lume **复用 memory-v2 pending 机制**承载 correction（KISS + 利用 Lume 更强的 pending/claim 体系）。persona 回流延后至周期 2（L3 Persona 完成后）。

## 错误处理（fail-open，全链路）

- 所有 LLM（分析器）/ 评估失败 → 返回空/null，**绝不阻塞 run 完成**（与记忆提取 `try/catch` 同原则）
- workflow-hook 内 fire-and-forget + try/catch
- schema 校验贯穿（records / analyst 候选逐字段校验 + 长度截断 + 数量上限，防膨胀/注入/DoS）
- 存储损坏 → 备份 + 重建空 index（参考 automation-manager 模式）

## 配置与开关

- `suggestions.json` 内 `enabled` 字段（总开关，默认 true）
- 类型权重 `typeWeights`（频率学习自动调节）
- ProactiveHub「分析工作模式」按钮手动触发分析器（低频，不建议自动化）
- 后续可加 `suggestion-daily` skill（定时分析，归入 skill 库）

## 测试策略

- **单测**（`bun:test`，参考 `memory-v2/*.test.ts` 模式）：
  - signals：6 类信号命中/miss、normalizeRule 不删否定词、repeat 跨消息检测
  - rules：5 类 duplicateKey、去重源加载
  - engine：误报控制（threshold/预算/拒绝门）、suppressed 归因
  - feedback：频率学习收敛（accepted 升/ignored 降/never 屏蔽）、连续 3 次静默、「该沉默时沉默」用例
  - analyst：schema 校验拒绝越界 kind、长度截断、LLM 只产候选
- **UI 测试**（参考 `AgentView.test.tsx` fake DOM 模式）：横幅三态、会话隔离、过期不展示
- **集成**：workflow-hook 触发 → 评估 → 持久化 → IPC 推送 端到端
- **子代理实测**（对标 Proma 方法论）：完成后派子代理真实体验，发现「功能看似正常但链路不执行」类盲区

## 与 Proma 的偏离点汇总（Lume 适配）

| 偏离 | Proma | Lume | 理由 |
|---|---|---|---|
| 接入 | agent-orchestrator 钩子 | workflow-hook（core-suggestion-hooks） | 符合 Lume 解耦架构 |
| correction 落地 | 独立 corrections.json + 专状态机 + persona 回流 | memory-v2 pending（preference/fact + correction tag） | 复用 Lume 更强的 pending/claim；KISS |
| persona 回流 | 确认纠正后刷新 persona | 延后至周期 2 | Lume persona 当前仅称呼 |
| LLM 配置 | 独立 MEMORY_LLM_* | 复用 memory-v2 模型配置 | 统一 LLM 适配层 |
| 分析器输入 | memory atoms + persona | memory-v2 entries（persona 为空时跳过） | 适配 Lume 数据模型 |
| 作用域 | sessionId | threadId + workspaceSlug | Lume 多工作区 + thread 模型 |
| Proactive Today 宿主 | PlanningView tab | 独立 ProactiveHub / TodoView tab（待确认） | Lume 无 PlanningView |
| 对话文本源 | SDKMessage（嵌套） | thread transcript / observer | Lume 消息结构不同 |

## 文件清单

**Create（sidecar）**：
- `apps/sidecar/src/services/suggest/signals.ts` + `.test.ts`
- `apps/sidecar/src/services/suggest/rules.ts` + `.test.ts`
- `apps/sidecar/src/services/suggest/engine.ts` + `.test.ts`
- `apps/sidecar/src/services/suggest/feedback.ts` + `.test.ts`
- `apps/sidecar/src/services/suggest/analyst.ts` + `.test.ts`
- `apps/sidecar/src/services/suggest/service.ts` + `.test.ts`
- `apps/sidecar/src/services/suggest/store.ts` + `.test.ts`
- `apps/sidecar/src/services/suggest/adapter.ts`
- `apps/sidecar/src/services/suggest/index.ts`
- `apps/sidecar/src/services/workflow-hooks/core-suggestion-hooks.ts`

**Create（shared）**：
- `packages/shared/src/types/suggestion.ts`
- shared channel 枚举扩展

**Create（web）**：
- `apps/web/src/components/agent/SuggestionBanner.tsx` + `.test.tsx`
- `apps/web/src/components/proactive/ProactiveHub.tsx`
- `apps/web/src/lib/desktop-api/suggestion.ts`（IPC client）

**Modify**：
- `apps/sidecar/src/services/workflow-hooks/hook-services.ts`（注册 suggestion hook）
- `apps/sidecar/src/rpc/*`（新增 suggestion RpcHandlers）
- `apps/web/src/hooks/useGlobalAgentListeners.ts`（订阅 onSuggestionsChanged）
- `apps/web/src/components/agent/AgentInput.tsx`（挂载 SuggestionBanner）
- 侧栏导航（ProactiveHub 入口，待宿主决策）

## 验证标准

1. **单元**：signals/rules/engine/feedback/analyst 全部 bun:test 通过（预计 40+ 测试）
2. **端到端**：真实 run 完成后，含纠正词的用户消息 → 横幅出现 correction 建议 → 接受 → memory-v2 pending 出现该 correction → 频率权重 ×1.2
3. **误报控制**：含「不用/算了」的整轮不触发；同会话 ≤2 条；连续忽略 3 次的 kind 静默
4. **fail-open**：LLM/分析器失败不阻塞 run；存储损坏可重建
5. **子代理实测**：派子代理真实体验，确认链路真实执行（对标 Proma P0 教训：SDKMessage 格式不匹配导致引擎从不执行）

## 已确认决策（2026-08-03）

1. **ProactiveHub 宿主**：独立侧栏入口「主动」+ 独立视图。
2. **correction 落地**：复用 memory-v2 pending（preference/fact + `correction` tag，走 MemorySettings 审批）。
3. **分析器**：本期实现，默认手动触发（ProactiveHub「分析工作模式」按钮），不自动跑，避免早期记忆少时空跑。
4. **对话文本源**：扩展 `agent-thread-manager` transcript 读取最近 30 条 user 消息（adapter 实现）。
