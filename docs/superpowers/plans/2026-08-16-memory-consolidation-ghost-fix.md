# 记忆 consolidation 幽灵消息修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 consolidation(记忆整理)链的 hydrate-only 幽灵消息——刷新后凭空出现的"从未 live 显示过"的 memory.changed;顺带把投影 memory.changed 分支改为幂等 upsert。

**Architecture:** 旧路内修复,与事件总线栈无关。两处:①consolidation 落 memory_saved 后补发 live memory.changed,id 用 replay 兜底公式可对齐的稳定键(`mutation_ids[0] ?? message.uuid`——consolidation 的 mutation_ids 恒空,故用 message.uuid,与 replay 投影公式一致,live/hydrate 同 id 去重);②web 投影 memory.changed 分支由无条件 push 改 upsert(findIndex by id 原位替换)。

**Tech Stack:** 同主仓(bun workspace / bun:test)。

**Spec:** 无独立 spec——缺陷取证在事件总线批次4 的 Explore 报告(§5 memory_saved)+本计划背景;主线 issue 级修复。

## Global Constraints

- **不碰事件总线任何代码**(flag/总线/适配器/跳过清单零改动——这是旧路固有缺陷)
- extractor 链零改动(其 live/replay 同 id 已正确)
- id 公式对齐是正确性关键:live 版与 replay 版(runtime-event-history.ts:33-47 的 `${run_id}:memory.changed:${mutation_ids[0] ?? uuid ?? created_at}`)**必须逐字一致**
- actor 字段:consolidation 版用 `"consolidation"`(区分于 extractor 的 "background_extract";replay 投影恒写 "background_extract"——**接受这个 hydrate 后 actor 变化的已知差异**,报告留档;不做 replay 侧透传以避免动白名单逻辑)
- commit emoji + `Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支 `fix/memory-consolidation-ghost`(基于 origin/main,独立于总线栈;PR base=main)

## 背景:缺陷机制(取证实证)

- **extractor 链**(`background-extractor.ts:444-466`):落 memory_saved(mutation_ids=真实 receipts)+ 发 live memory.changed(id=`${runId}:memory.changed:${mutationIds[0]}`);replay 投影同公式 → 同 id 去重 ✓
- **consolidation 链**(`consolidation.ts:175-201`):落 memory_saved 但 **mutation_ids: []**(空)且**不发 live memory.changed**(只发 memory.job.completed)→ replay 投影 id 落 `message.uuid`(每次 randomUUID)→ 刷新后出现 hydrate-only 幽灵消息;且该消息 id 每次重放都不同(uuid 是消息落盘时固化的,重放稳定——修正:uuid 固化后重放 id 稳定,幽灵只出现一次,但"从未 live 出现"的突兀仍在)
- **投影**(`runtime-event-message-projection.ts:159-180`):memory.changed 无条件 `messages.push`(非幂等,依赖上游 id 去重)

---

### Task 1: consolidation 补发 live + 投影 upsert

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/consolidation.ts`(:175-201 段)
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`(memory.changed 分支 :159-180)
- Test: `apps/sidecar/src/services/memory-v2/consolidation.test.ts`(追加或新建,参考同目录测试);`apps/web/src/components/agent/runtime-event-message-projection.test.ts`(追加)

**Interfaces:**
- Produces: consolidation 落盘后在同函数发 `memory.changed` runtime event(`emitAgentNotification(RUNTIME_EVENT)`,与上方 job.completed 同模式):`{id: \`${context.runId}:memory.changed:${message.uuid}\`, type:'memory.changed', threadId, runId, createdAt, actor:'consolidation', workspaceSlug, mutationIds: [], memoryIds: [], summary, details: []}`——**id 的 uuid 段必须用 message.uuid 变量**(与落盘消息同一 uuid,replay 公式对齐);投影 memory.changed 分支 upsert

- [ ] **Step 1: 失败测试**
  - sidecar(consolidation 测试):构造 consolidation 完成路径 → 断言①发出 memory.changed 通知(与 job.completed 并存)②id 格式 `${runId}:memory.changed:${message.uuid}`(通过捕获的通知解析)③mutationIds 空/summary 透传
  - web(投影测试):同 id 两份 memory.changed 事件先后 apply → 断言 messages 中该 id **恰一条**且内容为后者(upsert);不同 id 两份 → 两条并存
- [ ] **Step 2: 红**(两包各自跑目标文件)
- [ ] **Step 3: 实现**——consolidation.ts 补发段(照 job.completed 的 emitAgentNotification 模式);投影分支:`const idx = state.messages.findIndex(m => m.id === event.id); if (idx >= 0) { 替换 } else { push }`(保持现有 block 构造逻辑复用)
- [ ] **Step 4: 绿**——`cd apps/sidecar && bun test <目标文件>` + `cd apps/web && bun test src/components/agent/runtime-event-message-projection.test.ts`;随后两包全量(sidecar 基线 467+1 预存;web 1207 基线——**注意本分支基于 main,基线数字与总线栈不同,以实现者实测为准**)+ 双 typecheck
- [ ] **Step 5: Commit** `🐛 fix: 记忆整理(consolidation)补发 live memory.changed 消除刷新幽灵消息;投影改幂等 upsert`

## 验收(整体)

1. 两包测试绿+typecheck;consolidation 场景:live 出现记忆整理消息 → 刷新后 replay 同 id 去重 → **不再突现**
2. extractor 链零变化(既有测试不改)
3. 已知差异留档:hydrate 后 actor 字段显示 "background_extract"(replay 白名单恒写)而非 "consolidation"——展示文案层面影响,可接受

## 任务依赖

单任务。
