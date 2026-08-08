# 打扰控制（impression 曝光预算 + 渠道分级）设计 spec

> **主题**：Proactive Agent 治理 v2 — 主题② 打扰控制
> **日期**：2026-08-05
> **前置**：周期 1 主动建议（PR #8）+ 主题① Activation（PR #13）已 merged
> **状态**：设计稿，待用户审阅 → writing-plans

---

## 目标

在周期 1 建议引擎的「生成侧预算」（maxPerSession 2）之上，补齐**展示侧打扰控制**：追踪每条建议的曝光次数（impression），用三态状态机（fresh→exposed→stale）控制建议在 Banner（强打扰）与 ProactiveHub（被动查看）间的展示降级，让「打扰成本」可量化。

**核心缺口**：周期 1 的预算是生成侧（每会话最多生成 2 条），但展示侧无追踪——同一条建议可能跨多会话反复在 Banner 弹出，用户每次都要主动忽略。impression 补齐展示侧度量。

## 现状（周期 1）

| 维度 | 实现 |
|---|---|
| 生成预算 | engine: threshold 0.6 / maxPerEvaluation 1 / maxPerSession 2 |
| 频率学习 | feedback: accepted×1.2 / ignored×0.8 / never×0.5 + 连续 3 次静默 |
| 展示过滤 | Banner: threadId/ws 隔离 + 24h 过期 |
| impression | ❌ 无（SuggestionRecord 无曝光字段） |
| 渠道分级 | ❌ 无（Banner + Hub 平铺，无降级） |

## 数据模型（SuggestionRecord 扩展）

```typescript
// packages/shared/src/types/suggestion.ts — SuggestionRecord 新增
impressionCount: number;                        // 曝光次数（Banner + Hub 展示累计）
exposureState: "fresh" | "exposed" | "stale";   // 展示状态机
// 默认（新建议）：impressionCount: 0, exposureState: "fresh"
```

## 三态状态机

| 状态 | 触发条件 | Banner | ProactiveHub |
|---|---|---|---|
| **fresh** | impressionCount < FRESH_THRESHOLD（默认 3） | ✅ 弹出 | ✅ 列出 |
| **exposed** | impressionCount ≥ FRESH_THRESHOLD（3）且 < STALE_THRESHOLD（10）且未过期 | ❌ 不弹 | ✅ 列出 |
| **stale** | impressionCount ≥ STALE_THRESHOLD（10）OR 24h 过期 OR ignored/never | ❌ | ❌ 隐藏 |

**降级语义**：fresh→exposed 是「打扰降级」（Banner 撤，Hub 留）；exposed→stale 是「放弃」（都撤）。建议不丢失（store 仍存），只是不打扰。

## 曝光计数

- **Banner 渲染该建议时 +1**（前端，写回 store via RPC）
- **Hub 渲染该建议时 +1**（前端，写回 store via RPC）
- Banner + Hub 都计（用户看过即计，无论强/被动）
- 写回：扩展 suggestion RPC（`suggestion:record-impression`）或复用现有 act-on-suggestion 机制
- **防重复计数**：同一渲染周期（组件 mount）内只计一次（useRef 标记）

## 渠道展示 filter

- **Banner**（`SuggestionBanner.tsx`）：`filterVisible` 加 `exposureState === "fresh"`
- **Hub**（`ProactiveHub.tsx`）：list filter 加 `exposureState === "fresh" || "exposed"`（stale 隐藏）

## 阈值（可配置）

- `FRESH_THRESHOLD = 3`（Banner+Hub 累计 3 次曝光后降级 exposed）
- `STALE_THRESHOLD = 10`（超多曝光仍无行动 → stale）
- 24h 过期（现有 SUGGESTION_EXPIRY_MS）→ stale 触发之一
- 阈值常量集中在 engine.ts 或新 config（可后续提配置项）

## 打扰成本量化

- `impressionCount` = 可量化打扰成本（展示 N 次 = N 次曝光）
- `exposureState` = 打扰阶段（fresh 主动打扰 / exposed 已知降级 / stale 放弃）
- 未来可扩展：渠道权重（Banner=2 / Hub=1）→ impressionWeight 累积（本期 YAGNI，用平铺计数）

## 与周期 1 + 主题① 的关系

- 保留 engine 生成预算 + feedback 频率学习（不冲突，impression 是展示侧正交）
- Banner 24h 过期（现有）→ 升级为 stale 状态触发之一
- 主题① Activation（记忆用途分层）正交（impression 是建议展示侧，Activation 是记忆读取侧）

## 测试策略

- **impression 计数**：Banner/Hub 渲染 → impressionCount +1（防重复计数）
- **状态机迁移**：fresh（<3）→ exposed（≥3）→ stale（≥10 或过期）
- **渠道 filter**：Banner 只 fresh；Hub fresh+exposed；stale 都不显示
- **RPC**：record-impression 写回 store
- **集成**：建议生成（fresh）→ Banner 曝光 3 次 → exposed（Banner 撤 Hub 留）→ 过期 stale

## 偏离/权衡

- impression 平铺计数（Banner+Hub 各 1），非渠道权重（YAGNI，本期三态状态机够用）
- 阈值默认 3/10（可配置，后续可提 UI 调节）
- 不加渠道权重模型（用户选三态状态机，非渠道打扰分）
- record-impression RPC 需加 desktop 白名单（周期 1 P0 教训）或复用现有 channel

## 文件清单

**Modify（shared）**：
- `packages/shared/src/types/suggestion.ts` — SuggestionRecord 加 impressionCount + exposureState + channel 枚举（如需 record-impression）

**Modify（sidecar）**：
- `apps/sidecar/src/services/suggest/store.ts` — persistSuggestion 默认 impressionCount 0 / fresh；recordImpression 更新
- `apps/sidecar/src/services/suggest/engine.ts` 或 config — FRESH_THRESHOLD / STALE_THRESHOLD 常量
- `apps/sidecar/src/rpc/suggestion-handlers.ts` — record-impression handler（或扩展现有）
- `apps/desktop/src/renderer-sidecar-methods.ts` — 白名单（若新 channel，P0 教训）

**Modify（web）**：
- `apps/web/src/components/agent/SuggestionBanner.tsx` — filterVisible 加 fresh；渲染时 record-impression
- `apps/web/src/components/proactive/ProactiveHub.tsx` — list filter fresh+exposed；渲染时 record-impression
- `apps/web/src/lib/desktop-api/suggestion.ts` — recordImpression client

## 验证标准

1. **impression 计数**：Banner/Hub 渲染 +1，防重复。
2. **状态机**：fresh（<3）→ exposed（≥3）→ stale（≥10 或过期）迁移正确。
3. **渠道 filter**：Banner 只 fresh；Hub fresh+exposed；stale 隐藏。
4. **RPC + 白名单**：record-impression 接通（P0 守门）。
5. **集成**：fresh→曝光 3 次→exposed（Banner 撤）→过期→stale（Hub 撤）。

## 已确认决策（2026-08-05）

1. **impression 粒度**：per-record 曝光次数。
2. **曝光计数范围**：Banner + Hub 都计（用户看过即计）。
3. **渠道分级**：三态状态机（fresh→exposed→stale）+ 降级（Banner 撤→Hub 留→隐藏）。
4. **阈值**：FRESH_THRESHOLD 3 / STALE_THRESHOLD 10（默认，可配置）。
