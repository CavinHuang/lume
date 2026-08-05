# L3 Persona 完整用户画像 设计 spec

> **周期**：周期 2（L3 Persona）
> **日期**：2026-08-04
> **对标**：[`proma-ai/Proma#1409`](https://github.com/proma-ai/Proma/pull/1409) § 1.8 Persona（generatePersona / ensurePersona / parsePersonaProfile / buildPersonaFromRules）
> **前置分析**：`docs/superpowers/analysis/2026-08-03-proactive-agent-proma-parity.md`（Lume profile.ts 现状 + Proma persona 设计）
> **关联**：周期 1（主动建议系统，PR #8 已 merged）—— correction→persona 回流本期实现
> **状态**：设计稿，待用户审阅 → writing-plans

---

## 目标

为 Lume 增加 L3 Persona——LLM 综合生成的用户画像（Markdown 白盒），从散落的 memory entries 提炼出**称呼定位 / 长期偏好 / 交互协议 / 演进轨迹**，注入 Agent 上下文，并通过 correction 回流持续更新。

**核心理念**：当前 `user_profile` 注入是「即时过滤散落条目」（新鲜但无综合）。L3 Persona 补充「LLM 提炼的综合画像」（定位/交互协议等需推理的维度）。两者共存——新鲜条目 + 综合画像。

**定位边界**：persona 是 memory entries 的**综合视图**（LLM 提炼），不取代 entries（entries 仍是事实源）。persona.md 是缓存产物，可删重建。

## 架构总览

```
┌─ apps/sidecar/src/services/memory-v2/persona.ts (新建) ───────────┐
│  PERSONA_SYSTEM_PROMPT (5 段 Markdown 结构)                      │
│  generatePersona(entries) → LLM → Markdown                       │
│  ensurePersona({scope}) → 无→生成 / 有→增量 / 无 LLM→规则兜底    │
│  parsePersonaProfile(md) → {name, summary, preferences[],         │
│                              interactionRules[], evolution[]}     │
│  buildPersonaFromRules(entries) → 规则兜底 Markdown               │
│  readPersonaRaw/writePersona/deletePersona (存储)                 │
└───────┬───────────────────────────────────────────────────────────┘
        │ 存储
        ▼
  <configDir>/memory/<scope>/persona.md (白盒 Markdown, per scope)

        │ 接线
        ▼
  workflow-hook: run.afterComplete → ensurePersona (新 core-persona-hooks)
  suggest/service.ts: handleSuggestionFeedback(accepted correction) → ensurePersona (回流)
  user-message-prefix.ts: 新增 <persona_profile> 段 (与 user_profile 共存)

┌─ apps/web MemorySettings.tsx ─────────────────────────────────────┐
│  persona 卡片: 状态 + 预览展开 + 编辑 Markdown + 重新生成按钮     │
└───────────────────────────────────────────────────────────────────┘
        │ IPC (persona:get / persona:update / persona:regenerate)
        ▼
  shared channel + sidecar persona-handlers
```

## 模块设计

### 1. persona.ts（`apps/sidecar/src/services/memory-v2/persona.ts`，新建）

#### `PERSONA_SYSTEM_PROMPT`
固定 Markdown 结构 prompt（对齐 Proma，5 段）：
```
# 用户画像
## 用户（称呼）
## 一句话定位（≤30 字）
## 长期偏好（每条 10-40 字）
## 交互协议
## 演进轨迹
```
约束：只用提供的 entries 中明确信息；不推测/编造；已有 persona 时合并保留稳定内容；输出纯 Markdown（无围栏）。

#### `generatePersona(input: { entries: MemoryV2Entry[]; existing?: string; workspaceSlug?: string }): Promise<string>`
- 输入：`listEntries`（排除 suspected_stale），按 kind/scope 过滤相关条目（preference/fact/correction tag），slice 前 40，每条 statement + claim。
- LLM 调用：**复用 memory-v2 extraction 的模型解析链**（`resolveMemoryExtractionModelRefs` → fallback），不引入独立 env（同周期 1 analyst）。`temperature=0.3 / maxTokens=4096 / timeoutMs=60_000`。
- 已有 persona（`existing`）→ prompt 含「合并保留稳定内容」指令（增量更新）。
- 失败 → throw（由 ensurePersona catch 走兜底）。

#### `ensurePersona(input: { workspaceSlug?: string }): Promise<void>`
三态：
1. 无 persona + LLM 可用 → `generatePersona` → `writePersona`
2. 有 persona + LLM 可用 → `generatePersona({existing})` 增量 → `writePersona`
3. 无 LLM（模型未配置）→ `buildPersonaFromRules` → `writePersona`
- 全程 try/catch fail-open（persona 失败绝不阻塞）。
- 幂等：短时间重复调用不重复 LLM（可加 `lastUpdatedAt` 节流，可选）。

#### `parsePersonaProfile(md: string): { name?: string; summary?: string; preferences: string[]; interactionRules: string[]; evolution: string[]; updatedAt?: string }`
按二级标题 section 名匹配（`称呼|preferred_name|name` / `定位|summary` / `偏好|preference|喜欢` / `交互|协议|规则|protocol` / `演进|轨迹|evolution`），粗取字段。用于注入 + UI 预览结构化。

#### `buildPersonaFromRules(entries: MemoryV2Entry[]): string`
规则兜底（无 LLM）：
- name：preferred_name claim 的 object
- preferences：kind=preference 前 5 条 statement
- corrections：`correction` tag 前 3 条 statement（入交互协议段）
- 拼最小 Markdown（无定位/演进——LLM 才能生成）。

#### 存储（`readPersonaRaw / writePersona / deletePersona`）
- 路径：`<configDir>/memory/<scope>/persona.md`（global/workspace，复用 memory-v2 paths + markdown-store 原子写模式）。
- 新增 `getPersonaPath(scope)` 到 `memory-v2/paths.ts`（或 config-paths）。
- `writePersona` 原子写（tmp+rename，复用 markdown-store 的 atomicWrite）。

### 2. 注入（`user-message-prefix.ts`，modify）

新增 `<persona_profile>` 段（在 `<user_profile>` 段之后）：
- 仅当 persona 存在时注入。
- 内容：`summary` + `preferences.slice(0,5)` + `interactionRules.slice(0,3)`。
- persona 不存在 → 跳过该段（不影响现有 9 段）。
- 头部指令补充：persona 是 background context，与 user 冲突时以 user 当前指令为准。

**共存**：保留现有 `<user_profile>` 即时过滤段（新鲜条目）。persona_profile 是综合画像补充。token 预算：persona_profile 计入 hardCap（context-selection 调整优先级）。

### 3. 生成时机接线

#### workflow-hook（新建 `core-persona-hooks.ts`，与 `core-suggestion-hooks` 平行）
- 监听 `run.afterComplete`（同 memory/suggestion hook）。
- fire-and-forget 调 `ensurePersona({workspaceSlug})`，try/catch 兜底。
- 在 `hook-services.ts` 注册（`createPersonaWorkflowHookService`，仿 suggestion）。
- **节流**：避免每 run 都 LLM——可记录 `lastEnsureAt`，N 分钟内跳过（如 10min），或仅在 memory 有新增时触发（读 memory index `lastExtractionAt` 对比）。MVP：每 run afterComplete 都 ensure（ensurePersona 内部可节流）。

#### service 回流（`suggest/service.ts`，modify）
- `handleSuggestionFeedback`：accepted memory_correction 后，调 `ensurePersona({workspaceSlug})`（correction 进 memory-v2 pending → 确认后 persona 应反映）。fire-and-forget。
- 实现周期 1 延后的 correction→persona 回流。

### 4. UI（`MemorySettings.tsx`，modify）

persona 卡片（在 profile view 顶部或新 tab）：
- **状态**：已生成（emerald，含 updatedAt）/ 未生成（muted + 说明）。
- **预览**：展开显示 persona.md 渲染（Markdown）。
- **编辑**：textarea 直接编辑 Markdown → `persona:update`（写回 persona.md）。
- **重新生成**：按钮 → `persona:regenerate`（ensurePersona 强制刷新）+ toast。
- 复用 MemorySettings 现有卡片模式（如 pending 卡片）。

### 5. RPC + IPC

**新增 channel**（`packages/shared/src/types/memory.ts` 或 persona 专用）：
- `persona:get(workspaceSlug?)` → `{markdown, parsed, updatedAt}`
- `persona:update({workspaceSlug?, markdown})` → 写回
- `persona:regenerate({workspaceSlug?})` → ensurePersona 强制

sidecar `persona-handlers.ts`（新建，仿 suggestion-handlers），注册 create-rpc-handlers。
web `desktop-api/persona.ts`（新建 client）。
desktop `renderer-sidecar-methods.ts` 白名单加 3 persona RPC（**周期 1 P0 教训**——务必加白名单）。

## persona 维度（Lume 适配 5 段）

| 段 | Lume 来源 | 对齐 Proma |
|---|---|---|
| 称呼 + 定位 | preferred_name claim + LLM summary | 用户 + 一句话定位 |
| 长期偏好 | LLM 从 preference entries | 长期偏好 |
| 交互协议 | LLM 从 correction tag + preference entries | 交互协议 |
| 演进轨迹 | LLM 增量追加 | 演进轨迹 |

Lume 优势：persona 生成读取 entries 的 **claim 三元组**（比 Proma atoms 更结构化），交互协议段可从 correction tag 精准提炼。

## 错误处理（fail-open）

- LLM 失败 → `buildPersonaFromRules` 兜底（仍写 persona，缺定位/演进）。
- persona 解析失败 → 当作无 persona（重新生成）。
- workflow-hook / service 回流 → try/catch，绝不阻塞 run / feedback。
- 存储损坏 → 备份 + 重建（markdown-store 模式）。

## 测试策略

- **单测**（bun:test）：
  - persona.ts：`generatePersona`（mock LLM）、`parsePersonaProfile`（section 匹配）、`buildPersonaFromRules`（兜底）、`ensurePersona` 三态（无/有/无 LLM）、存储读写。
  - 注入：`<persona_profile>` 段存在/不存在 persona 的渲染。
- **集成**：correction accepted → ensurePersona → persona.md 更新（回流）。
- **子代理实测**（对标 Proma）：真实链路——run.afterComplete → ensurePersona → persona.md；correction 回流；注入段；UI 编辑/重新生成。

## 与 Proma 的偏离点（Lume 适配）

| 偏离 | Proma | Lume | 理由 |
|---|---|---|---|
| LLM 配置 | 独立 MEMORY_LLM_* | 复用 memory-v2 extraction 模型链 | 统一 LLM 适配（同 analyst/周期1） |
| 输入 | memory atoms | memory-v2 entries（含 claim 三元组） | 适配 Lume 数据模型，claim 更结构化 |
| 存储 | ~/.proma/memory/profile.md | `<configDir>/memory/<scope>/persona.md` | Lume memory-v2 paths + per-scope |
| 注入 | `<persona_profile>` 替代 | 共存（user_profile 即时 + persona_profile 综合） | 保留新鲜条目 + 综合画像互补 |
| 回流 | confirmCorrection | handleSuggestionFeedback(accepted) + ensurePersona | 接周期 1 service（correction 走 pending） |
| 节流 | markExtractionCompleted 触发 | ensurePersona 内部节流（可选 lastEnsureAt） | 避免每 run LLM |

## 文件清单

**Create（sidecar）**：
- `apps/sidecar/src/services/memory-v2/persona.ts` + `.test.ts`
- `apps/sidecar/src/services/workflow-hooks/core-persona-hooks.ts` + `.test.ts`
- `apps/sidecar/src/rpc/persona-handlers.ts` + `.test.ts`

**Create（shared）**：
- persona channel 枚举（`types/memory.ts` 或 `types/persona.ts`）

**Create（web）**：
- `apps/web/src/lib/desktop-api/persona.ts`（IPC client）

**Modify**：
- `apps/sidecar/src/services/memory-v2/paths.ts`（`getPersonaPath`）
- `apps/sidecar/src/services/memory-v2/user-message-prefix.ts`（`<persona_profile>` 段）
- `apps/sidecar/src/services/workflow-hooks/hook-services.ts`（注册 persona hook）
- `apps/sidecar/src/services/suggest/service.ts`（correction 回流 ensurePersona）
- `apps/sidecar/src/rpc/create-rpc-handlers.ts`（注册 persona handlers）
- `apps/web/src/components/settings/MemorySettings.tsx`（persona 卡片）
- `apps/desktop/src/renderer-sidecar-methods.ts`（白名单加 3 persona RPC——周期 1 P0 教训）

## 验证标准

1. **单元**：persona.ts（generate/parse/buildFromRules/ensure 三态）+ 注入段 + handler 全 bun:test 通过。
2. **端到端**：run.afterComplete → ensurePersona → persona.md 生成；含偏好/correction 的对话 → persona 反映；persona_profile 段注入；UI 编辑写回 + 重新生成。
3. **fail-open**：LLM 失败 → 规则兜底 persona；hook/回流失败不阻塞。
4. **P0 守门**：desktop renderer-sidecar-methods 白名单含 3 persona RPC（electron-security.test 反射 guard 应自动覆盖，若不覆盖则补）。
5. **子代理实测**：真实链路执行（非空转）。

## 已确认决策（2026-08-04）

1. **数据模型**：独立 Markdown persona（对齐 Proma，profile.md 白盒）。
2. **注入**：共存（保留 user_profile 即时过滤 + 新增 persona_profile 综合）。
3. **生成时机**：会话结束（run.afterComplete hook）+ correction accepted 回流。
4. **UI**：预览 + 编辑 + 重新生成。
5. **范围**：完整（5 段 + 生成 + 增量 + 回流 + 注入 + UI + 规则兜底）。
