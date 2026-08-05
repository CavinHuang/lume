# 记忆分层（Activation）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆 `active` 状态的 4 种用途语义为独立 **Activation** 向量（recall/persona/suggestion/analyst），让一条记忆可对每种用途独立授权；Evidence/Claim/Version 显式化整理（轻量）。

**Architecture:** frontmatter 加 `MemoryV2Activation`（4 布尔，默认全 true）；4 处用途读取（retrieval/persona/rules/analyst）加 activation filter；smart-add supersede 时继承旧版 activation；MemorySettings per-memory toggle。详见 spec `docs/superpowers/specs/2026-08-04-memory-activation-design.md`。

**Tech Stack:** TypeScript · bun:test · memory-v2（types/markdown-store/retrieval/persona/smart-add）· suggest（rules/analyst）· React（MemorySettings）

## Global Constraints

- **测试运行器**：bun:test。`bun test <file>`；sidecar `bun run --filter @lume/sidecar test:unit`；typecheck `bun run --filter @lume/sidecar typecheck`。
- **提交风格**：emoji 前缀（✨ feat / 🧪 test / 🐛 fix）+ 中文。
- **fail-open**：无 activation 字段（旧记忆）→ 默认全 true（兼容现状）。
- **默认全开**：新记忆 / pending→确认 → activation 全 true（现状行为不变）。
- **YAGNI**：不引入 `verified` 字段；Evidence/Claim/Version 轻量整理（不大改）。
- **base**：origin/main（含周期 1/2/3 PR #8/#9/#10）。
- **设计权威**：plan 与 spec 冲突以 spec 为准。

---

## File Structure

**Modify（sidecar）**：
- `apps/sidecar/src/services/memory-v2/types.ts` — `MemoryV2Activation` + frontmatter 字段
- `apps/sidecar/src/services/memory-v2/markdown-store.ts` — 读写 activation（默认全 true fallback）
- `apps/sidecar/src/services/memory-v2/retrieval.ts` — recall filter
- `apps/sidecar/src/services/memory-v2/persona.ts` — persona filter
- `apps/sidecar/src/services/memory-v2/smart-add.ts` — 版本迁移（supersede 继承）
- `apps/sidecar/src/services/suggest/rules.ts` — suggestion filter（loadDedupContext）
- `apps/sidecar/src/services/suggest/analyst.ts` — analyst filter
- 各 `.test.ts`

**Modify（web）**：
- `apps/web/src/components/settings/MemorySettings.tsx` — per-memory activation 4 toggle
- 可能：memory update RPC（activation 更新）

---

### Task 1: Activation 类型 + frontmatter + 兼容读取

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/types.ts` + `markdown-store.ts` + 相关 test
- 参考: frontmatter 现有字段（types.ts:44 applies_when / markdown-store.ts:152 status 默认）

**Interfaces:**
- Produces: `MemoryV2Activation` 类型（recall/persona/suggestion/analyst 4 布尔）+ frontmatter `activation` 字段（可选，默认全 true）+ `DEFAULT_ACTIVATION` 常量 + `readActivation(frontmatter): MemoryV2Activation`（fallback 全 true）

- [ ] **Step 1: 写 failing test**

```typescript
// types/markdown-store test
test("readActivation 无字段 → 默认全 true（兼容旧记忆）", () => {
  const fm = { /* 无 activation */ } as MemoryV2EntryFrontmatter;
  expect(readActivation(fm)).toEqual({ recall: true, persona: true, suggestion: true, analyst: true });
});

test("readActivation 有字段 → 返回实际值", () => {
  const fm = { activation: { recall: true, persona: false, suggestion: true, analyst: false } } as any;
  expect(readActivation(fm)).toEqual({ recall: true, persona: false, suggestion: true, analyst: false });
});

test("writeEntry 新记忆默认 activation 全 true", () => {
  // writeEntry(candidate 无 activation) → frontmatter.activation 全 true
});
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现** — types.ts 加 `MemoryV2Activation` + `frontmatter.activation?: MemoryV2Activation`（可选）+ `DEFAULT_ACTIVATION`；markdown-store 加 `readActivation(fm)`（fm.activation ?? DEFAULT_ACTIVATION）+ writeEntry 写默认 activation（若 candidate 无）。fail-open（无字段→全 true）
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): MemoryV2Activation 类型 + 兼容读取（默认全 true）"`

---

### Task 2: recall + persona filter（memory-v2 域）

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/retrieval.ts` + `persona.ts` + 相关 test

**Interfaces:**
- Consumes: `readActivation` from Task 1
- Produces: retrieval listEntries 加 `activation.recall` filter；persona ensurePersona 读 entries 加 `activation.persona` filter

- [ ] **Step 1: 写 failing test**

```typescript
// retrieval test
test("recall filter: activation.recall=false 不参与召回", () => {
  // seed 2 entries: A activation.recall=true, B recall=false
  // query → 仅 A 在结果
});

// persona test
test("persona filter: activation.persona=false 不进 persona 生成", () => {
  // seed entries: persona=false 的不进 buildAnalysisInput-persona / ensurePersona
});
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现** — retrieval.ts listEntries（includeStatuses filter 后）加 `.filter(e => readActivation(e.frontmatter).recall)`；persona.ts ensurePersona 读 entries（listEntries 后）加 `.filter(e => readActivation(e.frontmatter).persona)`
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): recall + persona activation filter"`

---

### Task 3: suggestion + analyst filter（suggest 域）

**Files:**
- Modify: `apps/sidecar/src/services/suggest/rules.ts`（loadDedupContext）+ `analyst.ts`（buildAnalysisInput）+ 相关 test

**Interfaces:**
- Consumes: `readActivation` from Task 1

- [ ] **Step 1: 写 failing test**

```typescript
// rules test
test("suggestion filter: activation.suggestion=false 不加载为建议源", () => {
  // loadDedupContext: correction tag entries activation.suggestion=false → 不进 correctionRules
});

// analyst test
test("analyst filter: activation.analyst=false 不进分析输入", () => {
  // buildAnalysisInput: entries activation.analyst=false → 排除
});
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现** — rules.ts loadDedupContext 读 entries 后加 `.filter(e => readActivation(e.frontmatter).suggestion)`；analyst.ts buildAnalysisInput entries 加 `.filter(e => readActivation(e.frontmatter).analyst)`
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): suggestion + analyst activation filter"`

---

### Task 4: 版本迁移（supersede 继承 activation）

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/smart-add.ts` + 相关 test
- 参考: smart-add conflict/supersede 流程（line 86/144/156）

**Interfaces:**
- Consumes: `readActivation` from Task 1

- [ ] **Step 1: 写 failing test**

```typescript
test("supersede 继承旧版 activation", () => {
  // 旧 entry activation { recall: true, persona: false, suggestion: true, analyst: false }
  // smartAdd 冲突/更新 → resolvePending 接受 → 新版 supersede 旧版
  // 新版 activation === 旧版（persona:false, analyst:false 保留）
});

test("无旧版（新记忆）→ 默认全 true", () => {
  // smartAdd 无 existing → activation DEFAULT_ACTIVATION
});
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现** — smart-add 在创建 supersede 新版（resolvePending 接受 / writeEntry 新记忆替代旧）时，若有旧版 → 复制旧版 activation；无旧版 → DEFAULT_ACTIVATION。在 writeEntry/resolvePending 的 candidate 构造处注入 activation
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): supersede 版本迁移继承 activation"`

---

### Task 5: UI（MemorySettings per-memory activation toggle）

**Files:**
- Modify: `apps/web/src/components/settings/MemorySettings.tsx` + 可能 memory update RPC
- 参考: MemorySettings 现有 per-memory 卡片 + memory update IPC

**Interfaces:**
- Consumes: memory entry frontmatter（含 activation）+ memory update RPC

- [ ] **Step 1: Read MemorySettings.tsx** — 确认 per-memory 卡片渲染 + memory update 机制（RPC）
- [ ] **Step 2: 实现** — per-memory 展开卡片加 4 toggle（recall/persona/suggestion/analyst），读 entry.activation（或 fallback 全 true）；toggle → memory update RPC（写 frontmatter.activation）。若无现成 activation update RPC，扩展 memory update handler
- [ ] **Step 3: 写 test（fake DOM）** — render + toggle 交互 → update RPC 调用
- [ ] **Step 4: typecheck web + test**
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(web): MemorySettings per-memory activation 4 toggle"`

---

### Task 6: 全量验证 + 子代理实测

- [ ] **Step 1: typecheck 全包** — `bun run typecheck` → 全绿（或仅 pre-existing）
- [ ] **Step 2: test:core** — `bun run test:core` → activation 测试全绿，无回归
- [ ] **Step 3: 子代理实测（链路审查）** — 验证：①4 处 filter（recall/persona/suggestion/analyst）真实生效 ②版本迁移继承 ③兼容（旧记忆全 true）④UI toggle。报告 dead link
- [ ] **Step 4: 修复 dead link（若有）+ Commit**

---

## Self-Review

1. **Spec 覆盖**：Activation 类型+兼容（Task 1）+ 4 处 filter（Task 2 recall+persona / Task 3 suggestion+analyst）+ 版本迁移（Task 4）+ UI（Task 5）+ 验证（Task 6）。Evidence/Claim/Version 显式化 = 轻量（spec 决策不大改）。✅
2. **占位符扫描**：Task 1-4 有 test 代码 + 实现要点。Task 5 UI 标注「读现有 + 可能扩展 RPC」（执行时读）。无 TBD/TODO。✅
3. **类型一致**：`MemoryV2Activation`（Task 1）→ readActivation/filters/版本迁移/UI 全程一致。`DEFAULT_ACTIVATION` 全 true。✅
4. **依赖顺序**：Task 1（类型+readActivation）→ Task 2/3/4（filter + 版本迁移，依赖 Task 1）→ Task 5（UI）→ Task 6。✅
5. **范围**：6 task，Activation 核心 + 轻量整理。符合 spec「聚焦 Activation」。✅

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-04-memory-activation.md`. Two execution options:

1. **Subagent-Driven（推荐）** — 每 task 派 fresh subagent + 两阶段审查（同周期 1/2/3）。
2. **Inline Execution** — 本会话批量执行 + checkpoint。

**Which approach?**
