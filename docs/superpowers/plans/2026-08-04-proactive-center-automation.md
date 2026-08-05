# 主动中心 + 工作模式分析自动触发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐周期 1 两处预留闭环（analyst 跳过 persona / suggestion_analyze 工具未注册），用 automation 定时实现工作模式分析的真正自动化。

**Architecture:** 4 项增量：analyst.ts 接 persona（周期 2）+ suggestion_analyze 注册为 builtin tool（Agent/automation 可调）+ suggestion-daily skill 引导用户建每日 cron automation（复用周期 1 底座）。详见 spec `docs/superpowers/specs/2026-08-04-proactive-center-automation-design.md`。

**Tech Stack:** TypeScript · bun:test · Lume builtin tools（create-lume-tools.ts）· memory-v2 persona（周期 2）· suggest service.runAnalysisAndPersist（周期 1）· automation（周期 1）· default-skills

## Global Constraints

- **测试运行器**：bun:test。单文件 `bun test <file>`；sidecar `bun run --filter @lume/sidecar test:unit`；typecheck `bun run --filter @lume/sidecar typecheck`。
- **提交风格**：emoji 前缀（✨ feat / 🧪 test / 🐛 fix）+ 中文描述。
- **fail-open**：persona/工具失败不阻塞主流程。
- **复用底座**：service.runAnalysisAndPersist（周期 1）/ persona.readPersonaRaw+parsePersonaProfile（周期 2）/ automation（周期 1）。不重造。
- **base**：origin/main（含周期 1+2 PR #8/#9）。
- **设计权威**：plan 与 spec 冲突以 spec 为准。

---

## File Structure

**Modify**：
- `apps/sidecar/src/services/suggest/analyst.ts` + `analyst.test.ts` — persona 注入 + 移除「跳过」
- `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts` + 相关 test — 注册 suggestion_analyze

**Create**：
- `apps/sidecar/default-skills/suggestion-daily/SKILL.md` — 内置 skill
- 可能 modify：default-skills inventory test（识别新 skill）

---

### Task 1: analyst 接 persona（enhance）

**Files:**
- Modify: `apps/sidecar/src/services/suggest/analyst.ts`（buildAnalysisInput）+ `analyst.test.ts`
- 参考: `apps/sidecar/src/services/memory-v2/persona.ts`（readPersonaRaw/parsePersonaProfile，周期 2）

**Interfaces:**
- Consumes: `readPersonaRaw`/`parsePersonaProfile` from `../memory-v2/persona`（周期 2）
- Produces: `buildAnalysisInput` 注入 persona summary + preferences（移除周期 1 line 24/146「跳过」）

- [ ] **Step 1: 写 failing test（mock persona）**

```typescript
// analyst.test.ts（在现有 buildAnalysisInput 相关测试附近）
test("buildAnalysisInput 注入 persona summary + preferences（persona 存在）", () => {
  // mock readPersonaRaw 返回 persona Markdown
  // mock parsePersonaProfile 返回 { summary, preferences, ... }
  const input = buildAnalysisInput({ entries: [], workspaceSlug: undefined });
  expect(input).toContain("画像摘要内容");  // summary
  expect(input).toContain("偏好A");  // preference
});

test("buildAnalysisInput persona 不存在 → 跳过（周期 1 行为）", () => {
  // mock readPersonaRaw 返回 null
  const input = buildAnalysisInput({ entries: [], workspaceSlug: undefined });
  expect(input).not.toContain("画像");  // 无 persona 段
});
```

- [ ] **Step 2: 运行验证失败** — `bun test apps/sidecar/src/services/suggest/analyst.test.ts` → FAIL（persona 未注入）
- [ ] **Step 3: 实现** — `buildAnalysisInput` 加 persona 读取：`readPersonaRaw(scope)` → 若存在 `parsePersonaProfile(md)` → 注入 `summary` + `preferences.slice(0,8)` 到 analyst input 的「用户画像（persona）」段（ANALYST_PROMPT 已有该段，周期 1 预留）。persona 不存在 → 跳过。移除 line 24/146「persona 跳过」注释。fail-open（persona 读取 try/catch）
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git add analyst.ts analyst.test.ts && rtk git commit -m "✨ feat(sidecar): analyst 注入 L3 persona（移除周期1跳过）"`

---

### Task 2: suggestion_analyze 工具注册

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts` + 相关 test
- 参考: 现有 builtin tool 注册模式（读 create-lume-tools.ts）+ `service.runAnalysisAndPersist`（周期 1）

**Interfaces:**
- Consumes: `runAnalysisAndPersist` from `../suggest/service`（周期 1）
- Produces: `suggestion_analyze` builtin tool（无参数 → 返回 `{added, summary}`）

- [ ] **Step 1: Read `create-lume-tools.ts`** — 确认 builtin tool 注册模式（zod schema + handler + readOnlyHint 等）
- [ ] **Step 2: 写 failing test**

```typescript
// create-lume-tools test（现有工具测试模式）
test("suggestion_analyze 工具注册 + 调用 runAnalysisAndPersist", async () => {
  // mock runAnalysisAndPersist 返回 { added: 2 }
  const tools = createLumeTools({...});
  const analyze = tools.find(t => t.name === "suggestion_analyze");
  expect(analyze).toBeDefined();
  const result = await analyze.handler({});
  expect(runAnalysisPersistMock).toHaveBeenCalled();
  expect(result).toContain("2");  // added 数
});
```

- [ ] **Step 3: 运行验证失败** — FAIL（工具未注册）
- [ ] **Step 4: 实现** — 注册 `suggestion_analyze`：无参数 zod schema；描述「分析近期记忆与用户画像，发现可自动化/沉淀的工作模式，产出主动建议。低频高价值。」；handler 调 `runAnalysisAndPersist({})` → 返回 `{added} + 简短说明`；`readOnlyHint: false`（产生建议）。参考现有 builtin tool 模式
- [ ] **Step 5: 运行验证通过** — PASS
- [ ] **Step 6: Commit** — `rtk git commit -m "✨ feat(sidecar): suggestion_analyze 工具注册（Agent/automation 可调）"`

---

### Task 3: suggestion-daily skill

**Files:**
- Create: `apps/sidecar/default-skills/suggestion-daily/SKILL.md`
- Modify: default-skills inventory test（识别新 skill，如 `services/skills/default-skills-inventory.test.ts`）
- 参考: 现有 default-skills 结构（读一个现有 SKILL.md frontmatter + body）

- [ ] **Step 1: Read 现有 default-skills SKILL.md** — 确认 frontmatter（name/description/group/version/triggers）+ body 结构
- [ ] **Step 2: 创建 `default-skills/suggestion-daily/SKILL.md`** — 内容：
  - frontmatter: name suggestion-daily / description（定期分析工作模式）/ group lume / version 1.0.0 / 触发词（分析工作模式/发现可自动化习惯/suggestion-daily）
  - body: 何时用（用户想定期自动分析）；步骤（调 suggestion_analyze 工具运行分析 → 引导用户在主动中心处理建议 → 建议用户建每日 automation job：createAutomationJob cron 23:30 + prompt「调用 suggestion_analyze」）；强调低频高价值（不建议比每天更频繁）、只读记忆、保守产出（产出为空正常）
- [ ] **Step 3: 更新 inventory test**（若 default-skills-inventory.test.ts 枚举 skills）— 加 suggestion-daily
- [ ] **Step 4: 运行 inventory test + 简单内容审查** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): suggestion-daily skill 指导每日工作模式分析 automation"`

---

### Task 4: 全量验证 + 子代理实测

- [ ] **Step 1: typecheck 全包** — `bun run typecheck` → 全绿（或仅 pre-existing 无关）
- [ ] **Step 2: test:core** — `bun run test:core` → 周期 3 测试全绿，无回归
- [ ] **Step 3: 子代理实测（链路审查）** — 验证：①analyst 注入 persona（mock LLM 跑通）②suggestion_analyze 工具注册 + runAnalysisAndPersist 接通 ③suggestion-daily skill 被识别 + 内容含 automation 引导。报告 dead link
- [ ] **Step 4: 修复 dead link（若有）+ Commit**

---

## Self-Review

1. **Spec 覆盖**：analyst persona（Task 1）+ suggestion_analyze 工具（Task 2）+ automation 定时（Task 3 skill 引导，复用周期 1，无新代码）+ suggestion-daily skill（Task 3）。spec 4 项全覆盖。✅
2. **占位符扫描**：Task 1/2/3 有 test 代码 + 实现要点。无 TBD/TODO。✅
3. **类型一致**：`runAnalysisAndPersist`（周期 1 签名）/ `readPersonaRaw`+`parsePersonaProfile`（周期 2 签名）/ `suggestion_analyze` 无参 → added。一致。✅
4. **依赖顺序**：Task 1（analyst persona）独立；Task 2（工具）依赖周期 1 service；Task 3（skill）独立；Task 4 验证。✅
5. **范围**：周期 3 4 task（比周期 1/2 14-20 少），符合 spec「增量增强」定位。✅

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-04-proactive-center-automation.md`. Two execution options:

1. **Subagent-Driven（推荐）** — 每 task 派 fresh subagent + 两阶段审查（同周期 1/2）。
2. **Inline Execution** — 本会话批量执行 + checkpoint。

**Which approach?**
