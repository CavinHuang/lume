# 记忆分层（Evidence/Claim/Version/Activation）设计 spec

> **主题**：Proactive Agent 治理 v2 — 主题 ① 记忆分层
> **日期**：2026-08-04
> **前置**：周期 1/2/3 Proactive Agent 已 merged（PR #8/#9/#10）
> **状态**：设计稿，待用户审阅 → writing-plans

---

## 目标

把现状过载的 `confirmed = active` 状态拆成 **Evidence / Claim / Version / Activation** 四层概念，其中 **Activation（用途授权）** 是核心新设计——一条记忆可对 recall / persona / suggestion / analyst 四种用途**独立授权**，让「用户确认」从「全有或全无」变成「精确授权」。

**核心痛点**：现状 `active` 一个状态 = 召回 + 进 Persona + 进建议源 + 进 analyst **全授权**。`pending→active` 一旦确认 = 全用途开启，无法「可召回但不进 Persona」（隐私/噪音控制）等精细治理。

## 现状 → 四层映射

| 四层 | Lume 现状 | 成熟度 | 本期工作 |
|---|---|---|---|
| **Evidence（证据）** | `Source`（type/run_id/path）+ `Confidence` | ✅ 已有 | 文档/类型整理为「Evidence 层」概念（轻量） |
| **Claim（声明）** | claim 三元组（subject/predicate/object） | ✅ 已有 | 无需改 |
| **Version（版本）** | `supersedes`/`superseded_by` 链 | ✅ 已有 | 版本迁移策略（activation 继承） |
| **Activation（激活/用途）** | `active` = 全 4 用途授权 | ❌ 过载 | **核心新设计：4 位用途向量** |

## 架构：Activation 层（核心）

### 数据模型（`memory-v2/types.ts` frontmatter 新增）

```typescript
export interface MemoryV2Activation {
  recall: boolean;      // 参与召回（注入 prompt）
  persona: boolean;     // 进 L3 Persona 生成/更新
  suggestion: boolean;  // 进建议规则源（correction tag 等）
  analyst: boolean;     // 进工作模式分析（analyst input）
}

// MemoryV2EntryFrontmatter 新增字段：
//   activation: MemoryV2Activation
// 默认值（新记忆 / pending→确认）：{ recall: true, persona: true, suggestion: true, analyst: true }
```

### 4 处用途 filter（读取时按 activation 过滤）

| 用途 | 读取点（origin/main） | filter 改动 |
|---|---|---|
| **recall** | `memory-v2/retrieval.ts` listEntries（现状 `includeStatuses: ["active","suspected_stale"]`） | 加 `activation.recall === true` |
| **persona** | `memory-v2/persona.ts` ensurePersona 读 entries（buildAnalysisInput-persona 段） | 加 `activation.persona === true` |
| **suggestion** | `suggest/rules.ts` loadDedupContext（correction/sop 源） | 加 `activation.suggestion === true` |
| **analyst** | `suggest/analyst.ts` buildAnalysisInput（entries 输入） | 加 `activation.analyst === true` |

**fail-open**：无 activation 字段（旧记忆）→ 默认全 true（兼容现状）。

### 版本迁移（supersede 时）

当新记忆 supersede 旧记忆（冲突/更新，`smartAdd` 的 conflict/superseded 流程）：
- **继承**：新版 activation 继承旧版（用户精调保留——如旧版关 persona，新版也关）。
- 实现：`smartAdd`/`resolvePending` 在创建 supersede 新版时，复制旧版 activation。

## Evidence / Claim / Version 显式化（轻量整理）

- **Evidence**：现有 Source + Confidence 整理为「Evidence 层」概念。可选加 `verified: boolean`（证据已核验），但本期不强制（YAGNI）。
- **Claim**：已显式（三元组），无需改。
- **Version**：已显式（supersedes 链），仅版本迁移策略（上）。

本期聚焦 Activation（核心新设计），Evidence/Claim/Version 不做大改（避免过度重构）。

## UI（`MemorySettings.tsx`）

- per-memory 展开卡片加 **activation 4 toggle**（recall / persona / suggestion / analyst）。
- 确认 pending 时默认全 true（不显式选，简化 UX；用户可事后在 MemorySettings 精调）。
- toggle → 更新 frontmatter activation（新 RPC 或扩展现有 memory update）。

## 向后兼容

- 现有 active 记忆（无 activation 字段）→ 读取时默认全 true（等价现状行为）。
- frontmatter 加 activation 是**可选字段**（旧记忆不强制迁移；读取时 fallback）。

## 测试策略

- **activation filter**（4 处）：mock entries 不同 activation → 验证 recall/persona/suggestion/analyst 各自过滤正确。
- **版本迁移**：supersede 时新版 activation 继承旧版（mock smartAdd conflict）。
- **兼容**：无 activation 字段 → 全 true。
- **默认**：pending→确认 → activation 全 true。
- **UI**：per-memory toggle（fake DOM）。

## 偏离/权衡

- activation 是 frontmatter 4 布尔（轻量，非独立文件/表）。
- 默认全开 = 现状行为不变（向后兼容），精调能力「备而不用」（用户不调则等价现状）。
- Evidence/Claim/Version 显式化是概念整理，避免过度重构（YAGNI）。
- 不引入 `verified` 字段（证据核验）——本期 Activation 是核心，verified 留 follow-up。

## 文件清单

**Modify（sidecar）**：
- `apps/sidecar/src/services/memory-v2/types.ts` — `MemoryV2Activation` 类型 + frontmatter 字段
- `apps/sidecar/src/services/memory-v2/markdown-store.ts` — 读写 activation（兼容 fallback）
- `apps/sidecar/src/services/memory-v2/retrieval.ts` — recall filter
- `apps/sidecar/src/services/memory-v2/persona.ts` — persona filter
- `apps/sidecar/src/services/memory-v2/smart-add.ts` — 版本迁移（supersede 继承 activation）
- `apps/sidecar/src/services/suggest/rules.ts` — suggestion filter（loadDedupContext）
- `apps/sidecar/src/services/suggest/analyst.ts` — analyst filter
- 各 `.test.ts`

**Modify（web）**：
- `apps/web/src/components/settings/MemorySettings.tsx` — per-memory activation 4 toggle
- 可能：memory update RPC（activation 更新）

## 验证标准

1. **activation filter**：4 处（recall/persona/suggestion/analyst）按 activation 过滤正确。
2. **版本迁移**：supersede 继承 activation。
3. **兼容**：旧记忆（无 activation）→ 全 true（现状不变）。
4. **UI**：per-memory 4 toggle 工作。
5. **默认**：pending→确认全 true。

## 已确认决策（2026-08-04）

1. **四层**：Evidence/Claim/Version/Activation（前三显式化现有，Activation 核心新设计）。
2. **Activation 用途**：recall / persona / suggestion / analyst 四位独立授权。
3. **默认**：全开（pending→确认全 true），MemorySettings per-memory 可精调。
4. **版本迁移**：supersede 时继承旧版 activation。
5. **范围**：聚焦 Activation（核心），Evidence/Claim/Version 轻量整理（不大改）。
