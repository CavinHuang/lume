# 主动建议系统（Proactive Suggestion）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lume 中实现完整的主动建议子系统——会话结束评估用户消息，识别 correction/followup/automation/todo/repeat 时机，经误报控制与频率学习后通过 SuggestionBanner 三态横幅呈现，并含 LLM 工作模式分析器与 ProactiveHub 聚合视图。

**Architecture:** 作为 workflow-hook（`core-suggestion-hooks`）接入 `run.afterComplete`，与 `core-memory-hooks` 平行，不硬编码 `lume-runner`。核心逻辑（signals/rules/engine/feedback/analyst）位于 `apps/sidecar/src/services/suggest/`；action 复用既有 `createAutomationJob` / `smartAddMemoryV2Candidate`；UI 在 `apps/web`（SuggestionBanner + 独立侧栏 ProactiveHub）。详见 spec `docs/superpowers/specs/2026-08-03-proactive-suggestion-design.md`。

**Tech Stack:** TypeScript · bun:test · React（web）· Lume IPC 4 层桥（shared channel → RpcHandler → sidecar_call → Electron main）· memory-v2 LLM 适配层

## Global Constraints

- **测试运行器**：bun:test。单文件 `bun test <file路径>`；sidecar 全量 `bun run --filter @lume/sidecar test:unit`；typecheck `bun run --filter @lume/sidecar typecheck`（或 web 对应 filter）。
- **提交风格**：emoji 前缀（✨ feat / 🧪 test / ♻️ refactor / 📝 docs）+ 中文描述。仅按 plan 的 commit step 提交，不擅自提交。
- **fail-open**：所有建议/分析逻辑失败必须返回空/null + try/catch，绝不阻塞 run 完成。
- **复用优先**：action 对接既有 `createAutomationJob` / `smartAddMemoryV2Candidate`，不重造定时任务/记忆存储。
- **接入方式**：workflow-hook，不修改 `lume-runner.ts` 的 `!this.workflowHooks` 分支。
- **作用域**：所有建议记录带 `threadId` + `workspaceSlug`，UI 按 thread+workspace 隔离。
- **设计权威**：本 plan 与 spec 冲突时以 spec 为准；偏离决策见 spec「已确认决策」与「与 Proma 的偏离点」。
- **代码注释语言**：与现有代码库一致（中英混用，仿 `memory-v2/` 风格）。

---

## File Structure

**Create（sidecar `apps/sidecar/src/services/suggest/`）**：
- `signals.ts` — 6 张词典/正则表 + 重复意图检测 + normalizeRule（零 LLM）
- `rules.ts` — 5 类规则 + skill 后处理，信号→候选
- `engine.ts` — 决策引擎 + 误报控制（阈值/预算/拒绝门）
- `feedback.ts` — 频率学习 + 静默 + schema 校验
- `analyst.ts` — LLM 工作模式分析 + 严格 schema 校验
- `service.ts` — 编排（评估/反馈/分析/持久化/推送）
- `store.ts` — suggestions.json 读写 + 原子写 + 内存缓存
- `adapter.ts` — 从 thread transcript 提取对话文本
- `index.ts` — barrel 导出
- 各 `.test.ts`

**Create（sidecar workflow-hooks）**：
- `apps/sidecar/src/services/workflow-hooks/core-suggestion-hooks.ts`

**Create（shared `packages/shared/src/`）**：
- `types/suggestion.ts` — 全部类型
- channel 枚举扩展（接入现有 IPC channel 定义）

**Create（web `apps/web/src/`）**：
- `components/agent/SuggestionBanner.tsx` + `.test.tsx`
- `components/proactive/ProactiveHub.tsx`
- `lib/desktop-api/suggestion.ts` — IPC client

**Modify**：
- `apps/sidecar/src/services/workflow-hooks/hook-services.ts`（注册 suggestion hook）
- `apps/sidecar/src/rpc/`（新增 suggestion handlers，接入现有 RpcHandler factory）
- `apps/web/src/hooks/useGlobalAgentListeners.ts`（订阅 onSuggestionsChanged）
- `apps/web/src/components/agent/AgentInput.tsx`（挂载 SuggestionBanner）
- 侧栏导航组件（注册 ProactiveHub 入口——plan Task 18 定位）

---

## Phase 0：基础设施

### Task 1: shared 类型定义

**Files:**
- Create: `packages/shared/src/types/suggestion.ts`
- Modify: `packages/shared/src/types/index.ts`（re-export）

**Interfaces:**
- Produces: `SuggestionKind / SuggestionAction / SuggestionCandidate / SuggestionRecord / SuggestionFeedback / SuggestionTypeWeights / SuggestionsIndex / SuggestionStats`（签名见 spec §1）

- [ ] **Step 1: 写类型文件**

```typescript
// packages/shared/src/types/suggestion.ts
export type SuggestionKind = "correction" | "followup" | "automation" | "todo" | "skill";

export type SuggestionAction =
  | { type: "memory_correction"; raw: string; rule: string }
  | { type: "open_automation_create"; automationTitle: string; suggestedPrompt: string }
  | { type: "open_memory_board" }
  | { type: "open_skill_creator"; topic: string };

export interface SuggestionCandidate {
  duplicateKey: string;
  kind: SuggestionKind;
  title: string;
  reason: string;
  evidence: string;
  rawConfidence: number;
  action: SuggestionAction;
}

export interface SuggestionRecord extends SuggestionCandidate {
  id: number;
  sessionId?: string;
  threadId?: string;
  workspaceSlug?: string;
  status: "suggested" | "accepted" | "ignored" | "never";
  createdAt: number;
  feedbackAt?: number;
}

export type SuggestionFeedback = "accepted" | "ignored" | "never";
export type SuggestionTypeWeights = Record<SuggestionKind, number>;

export interface SuggestionsIndex {
  version: 1;
  records: SuggestionRecord[];
  typeWeights: SuggestionTypeWeights;
  enabled: boolean;
}

export interface SuggestionStats {
  suggestedCount: number;
  todayAccepted: number;
  todayIgnored: number;
  todayNever: number;
  typeWeights: SuggestionTypeWeights;
}

export const DEFAULT_TYPE_WEIGHTS: SuggestionTypeWeights = {
  correction: 1.0, followup: 1.0, automation: 1.0, skill: 0.8, todo: 0.9,
};
```

- [ ] **Step 2: re-export** — 在 `types/index.ts` 加 `export * from "./suggestion";`
- [ ] **Step 3: typecheck** — `bun run --filter @lume/shared typecheck` → PASS
- [ ] **Step 4: Commit** — `rtk git add packages/shared/src/types/suggestion.ts packages/shared/src/types/index.ts && rtk git commit -m "✨ feat(shared): 主动建议类型定义"`

---

### Task 2: store（suggestions.json 持久化）

**Files:**
- Create: `apps/sidecar/src/services/suggest/store.ts` + `store.test.ts`

**Interfaces:**
- Consumes: `SuggestionsIndex / SuggestionRecord / SuggestionStats / DEFAULT_TYPE_WEIGHTS` from shared
- Produces: `persistSuggestion / listSuggestions(status?) / deleteSuggestion / clearSuggestions / suggestionStats / setTypeWeights / setEnabled / getEnabled / resetSuggestionStoreForTest`

- [ ] **Step 1: 写 failing test**

```typescript
// store.test.ts（bun:test，仿 memory-v2/markdown-store.test.ts 的 tmpdir + LUME_CONFIG_DIR 模式）
import { rm, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test, expect } from "bun:test";
import { persistSuggestion, listSuggestions, resetSuggestionStoreForTest, getEnabled, setEnabled } from "./store";
import type { SuggestionCandidate } from "@lume/shared";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lume-suggest-")); process.env.LUME_CONFIG_DIR = root; resetSuggestionStoreForTest(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const candidate = (overrides: Partial<SuggestionCandidate> = {}): SuggestionCandidate => ({
  duplicateKey: "correction:test", kind: "correction", title: "t", reason: "r",
  evidence: "e", rawConfidence: 0.9,
  action: { type: "memory_correction", raw: "以后不要用 var", rule: "不要用 var" },
  ...overrides,
});

test("persistSuggestion 写入并分配自增 id + status suggested", () => {
  const rec = persistSuggestion(candidate(), { threadId: "t1", workspaceSlug: "ws" });
  expect(rec.id).toBeGreaterThan(0);
  expect(rec.status).toBe("suggested");
  expect(listSuggestions()[0].threadId).toBe("t1");
});

test("listSuggestions(status) 按状态过滤", () => {
  const a = persistSuggestion(candidate({ duplicateKey: "k1" }));
  // 模拟 accepted（通过 feedback 模块调，这里直接测过滤：手动改不可行，故测默认 suggested）
  expect(listSuggestions("suggested")).toHaveLength(1);
  expect(listSuggestions("accepted")).toHaveLength(0);
});

test("enabled 默认 true，setEnabled 持久化", () => {
  expect(getEnabled()).toBe(true);
  setEnabled(false);
  expect(getEnabled()).toBe(false);
});
```

- [ ] **Step 2: 运行验证失败** — `bun test apps/sidecar/src/services/suggest/store.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现 store.ts** — 文件路径 `getSuggestionIndexPath()`（参考 `memory-v2/paths.ts` + `config-paths.ts`：`<configDir>/suggestions/suggestions.json`）；原子写（tmp+rename，参考 `automation-manager.ts:20-58`）；内存缓存 + `resetSuggestionStoreForTest`；`persistSuggestion` unshift + 自增 id（`Date.now()` 不可用则用 records.length+1 或 maxId+1——注意脚本禁用 Date.now，用 records.reduce max id +1）；schema 校验（`isValidSuggestionRecord`：id>0 / status 枚举 / 字段长度截断 title≤200 reason≤500 evidence≤500 duplicateKey≤200）；`MAX_RECORDS=500` 裁最旧
- [ ] **Step 4: 运行验证通过** — `bun test apps/sidecar/src/services/suggest/store.test.ts` → PASS
- [ ] **Step 5: Commit** — `rtk git add apps/sidecar/src/services/suggest/store.ts apps/sidecar/src/services/suggest/store.test.ts && rtk git commit -m "✨ feat(sidecar): 建议存储 suggestions.json + 原子写"`

---

## Phase 1：核心逻辑（TDD）

### Task 3: signals（信号提取，零 LLM）

**Files:**
- Create: `apps/sidecar/src/services/suggest/signals.ts` + `signals.test.ts`

**Interfaces:**
- Produces: `extractSignals(messages: {role:"user"; content:string}[]): Signal[]`；`Signal = {kind, raw, confidence, extra?}`；辅助 `normalizeRule / isMeaningfulRule / hasStrongSignal`
- 词典/正则：从 spec §2 + Proma `signals.ts` 1:1 移植（CORRECTION/FOLLOWUP/AUTOMATION/TODO/NEGATIVE/POSTPONE/WEAK_INTENT_KEYS + detectRepeatIntents）

- [ ] **Step 1: 写 failing test（核心断言）**

```typescript
import { test, expect } from "bun:test";
import { extractSignals, normalizeRule, hasStrongSignal } from "./signals";

const um = (content: string) => [{ role: "user", content }] as const;

test("correction 模式命中 + confidence 0.95", () => {
  const s = extractSignals(um("以后不要用 var 声明变量"));
  expect(s.some(x => x.kind === "correction")).toBe(true);
  expect(s.find(x => x.kind === "correction")!.confidence).toBe(0.95);
});

test("normalizeRule 剥离引导词但保留否定词", () => {
  expect(normalizeRule("以后不要用 var")).toBe("不要用 var");
  expect(normalizeRule("请记住别再用 any")).toBe("别再用 any");
});

test("NEGATIVE 整条短消息被标记拒绝（供 engine 用）", () => {
  // extractSignals 不直接拒绝，但暴露 negative 标志
  const s = extractSignals(um("不用了"));
  expect(s.some(x => x.kind === "negative")).toBe(true);
});

test("POSTPONE 过滤掉 correction 尾巴", () => {
  const s = extractSignals(um("以后注意代码风格，再聊"));
  expect(s.some(x => x.kind === "correction")).toBe(false);
});

test("repeat 跨 2 条消息同意图触发", () => {
  const s = extractSignals([
    { role: "user", content: "帮我跑测试" },
    { role: "user", content: "帮我跑一下测试" },
  ]);
  expect(s.some(x => x.kind === "repeat")).toBe(true);
});

test("hasStrongSignal 快速路径", () => {
  expect(hasStrongSignal("明天提醒我提交")).toBe(true);
  expect(hasStrongSignal("你好")).toBe(false);
});
```

- [ ] **Step 2: 运行验证失败** — `bun test apps/sidecar/src/services/suggest/signals.test.ts` → FAIL
- [ ] **Step 3: 实现 signals.ts** — 1:1 移植 spec §2.2 的 6 张表与 `detectRepeatIntents`（intentKey=`intent.slice(0,2)`，≥2 次跨 ≥2 条）；`normalizeRule` 循环剥离句首引导词（请记住/我希望你/我希望/我更喜欢/我更倾向/以后/下次/记住/麻烦你?），**绝不删否定词**；`isMeaningfulRule`（length≥2 且非无意义残留集合）；correction raw.length<6 丢弃；每消息最多 1 个 correction 信号
- [ ] **Step 4: 运行验证通过** — `bun test apps/sidecar/src/services/suggest/signals.test.ts` → PASS
- [ ] **Step 5: Commit** — `rtk git add apps/sidecar/src/services/suggest/signals.* && rtk git commit -m "✨ feat(sidecar): 建议信号提取（6 类词典 + 重复意图）"`

---

### Task 4: rules（信号 → 候选）

**Files:**
- Create: `apps/sidecar/src/services/suggest/rules.ts` + `rules.test.ts`

**Interfaces:**
- Consumes: `Signal[] from signals`；去重源 `loadDedupContext(input): {automationTitles: string[]; correctionRules: string[]; sopCandidateCount: number}`
- Produces: `applyRules(ctx): SuggestionCandidate[]`；`buildSkillCandidate(sopCount): SuggestionCandidate | undefined`

- [ ] **Step 1: 写 failing test**

```typescript
import { test, expect } from "bun:test";
import { applyRules, buildSkillCandidate } from "./rules";
import type { Signal } from "./signals";

test("correction 信号 → memory_correction 候选 + duplicateKey", () => {
  const sig: Signal = { kind: "correction", raw: "以后不要用 var", confidence: 0.95 };
  const out = applyRules({ signals: [sig], automationTitles: [], correctionRules: [], sopCandidateCount: 0 });
  expect(out[0].kind).toBe("correction");
  expect(out[0].action.type).toBe("memory_correction");
  expect(out[0].duplicateKey).toBe("correction:不要用 var".slice(0, 33));
});

test("automation 信号去重已有 automation 标题", () => {
  const sig: Signal = { kind: "automation", raw: "每天自动拉取数据", confidence: 0.85 };
  const out = applyRules({ signals: [sig], automationTitles: ["每天拉取数据"], correctionRules: [], sopCandidateCount: 0 });
  expect(out).toHaveLength(0);
});

test("skill 候选仅当 sop≥3", () => {
  expect(buildSkillCandidate(2)).toBeUndefined();
  expect(buildSkillCandidate(3)?.kind).toBe("skill");
});
```

- [ ] **Step 2: 运行验证失败** — `bun test apps/sidecar/src/services/suggest/rules.test.ts` → FAIL
- [ ] **Step 3: 实现 rules.ts** — 5 类规则各产 duplicateKey（见 spec §3）；`automationTitleFromRaw`（去句首每天/每周/帮我/盯等 + 尾标点，≤24 字）；correction 去重查 `correctionRules` 包含度；repeat→automation `定期{intent}`；`loadDedupContext` 桥接 `listAutomationJobs()` 名称 + memory-v2 pending 中 correction tag rules + memory-v2 sop/state 条目计数（具体 memory-v2 API 在实现时读 `memory-v2/tools.ts` / `markdown-store.ts` 确认）
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): 建议规则引擎（5 类 + skill 后处理）"`

---

### Task 5: engine（决策 + 误报控制）

**Files:**
- Create: `apps/sidecar/src/services/suggest/engine.ts` + `engine.test.ts`

**Interfaces:**
- Consumes: `applyRules / buildSkillCandidate from rules`；`getEnabled / listSuggestions / typeWeights from store/feedback`
- Produces: `evaluateSuggestions(messages, opts): {candidates: SuggestionCandidate[]; suppressed: {candidate; reason}[]}`；`DEFAULT_SUGGEST_OPTIONS = {threshold:0.6, maxPerEvaluation:1, maxPerSession:2}`

- [ ] **Step 1: 写 failing test（误报控制是核心）**

```typescript
import { test, expect } from "bun:test";
import { evaluateSuggestions } from "./engine";

const um = (content: string) => [{ role: "user", content }] as const;

test("明确拒绝门：最后一条含 NEGATIVE → 整轮空", () => {
  const out = evaluateSuggestions([...um("以后注意代码风格"), ...um("不用了")], { maxPerSession: 2, seenKeys: new Set(), activeTypeWeights: {correction:1,followup:1,automation:1,skill:0.8,todo:0.9} });
  expect(out.candidates).toHaveLength(0);
});

test("threshold 过滤：effective < 0.6 进 suppressed", () => {
  // todo rawConfidence 0.72 × weight 0.9 = 0.648 > 0.6 通过；构造低置信被压
  const out = evaluateSuggestions(um("还差一点没做完"), { maxPerSession: 2, seenKeys: new Set(), activeTypeWeights: {correction:1,followup:1,automation:1,skill:0.8,todo:0.1} });
  expect(out.suppressed.length + out.candidates.length).toBeGreaterThan(0);
  // weight=0.1 → todo 0.648×0.1=0.0648 < 0.6 → suppressed
  expect(out.candidates.find(c => c.kind === "todo")).toBeUndefined();
});

test("maxPerEvaluation=1：多候选只取最高 effective 1 条", () => {
  const out = evaluateSuggestions(um("以后不要用 var，明天提醒我提交"), { maxPerSession: 2, seenKeys: new Set(), activeTypeWeights: {correction:1,followup:1,automation:1,skill:0.8,todo:0.9} });
  expect(out.candidates.length).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现 engine.ts** — 流程：filter user 文本（空→return 空）→ 最后一条含 negative→return 空 → `extractSignals` + `applyRules` + `buildSkillCandidate` → 去重四连（seenKeys / never 屏蔽集 / 同次 dup / kind 静默）→ `effective = rawConfidence × typeWeight(kind)` → `<threshold` 进 suppressed（带原因）→ 降序取 maxPerEvaluation → 返回 `{candidates, suppressed}`
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): 建议决策引擎 + 误报控制（阈值/预算/拒绝门）"`

---

### Task 6: feedback（频率学习 + 静默）

**Files:**
- Create: `apps/sidecar/src/services/suggest/feedback.ts` + `feedback.test.ts`

**Interfaces:**
- Consumes: `store`（读写 typeWeights + records）
- Produces: `recordFeedback(id, feedback): void`；`isTypeSilenced(kind): boolean`；`getNeverKeys(): Set<string>`

- [ ] **Step 1: 写 failing test（频率收敛 + 静默）**

```typescript
import { test, expect, beforeEach } from "bun:test";
import { persistSuggestion, resetSuggestionStoreForTest } from "./store";
import { recordFeedback, isTypeSilenced } from "./feedback";
// (tmpdir + LUME_CONFIG_DIR setup 同 Task 2)

beforeEach(() => resetSuggestionStoreForTest());

test("accepted ×1.2 上限 2.0；ignored ×0.8 下限 0.2", () => {
  const r1 = persistSuggestion({ duplicateKey:"k1", kind:"correction", title:"t", reason:"r", evidence:"e", rawConfidence:0.9, action:{type:"memory_correction",raw:"r",rule:"r"} });
  recordFeedback(r1.id, "accepted");
  // 校验 typeWeights.correction 变化需读取 store——通过 getEnabled 旁的 getTypeWeights
  // 见 Step 3：store 暴露 getTypeWeights
});

test("连续忽略 3 次同 kind → 静默", () => {
  for (let i=0;i<3;i++){ const r=persistSuggestion({duplicateKey:`k${i}`,kind:"todo",title:"t",reason:"r",evidence:"e",rawConfidence:0.72,action:{type:"open_memory_board"}}); recordFeedback(r.id,"ignored"); }
  expect(isTypeSilenced("todo")).toBe(true);
  expect(isTypeSilenced("correction")).toBe(false);
});

test("never → duplicateKey 永久屏蔽", () => {
  const r = persistSuggestion({ duplicateKey:"never1", kind:"automation", title:"t", reason:"r", evidence:"e", rawConfidence:0.85, action:{type:"open_automation_create",automationTitle:"t",suggestedPrompt:"p"} });
  recordFeedback(r.id, "never");
  expect(getNeverKeys().has("never1")).toBe(true);
});
```

- [ ] **Step 2: 运行验证失败** — FAIL（需 store 暴露 `getTypeWeights`，先补 store）
- [ ] **Step 3: 实现 feedback.ts** — `recordFeedback`：accepted `min(2.0, w×1.2)` / ignored `max(0.2, w×0.8)` / never `max(0.2, w×0.5)` + neverKey 加入 record + 该 duplicateKey 永久屏蔽；`isTypeSilenced(kind)`：该 kind 最近 3 条 records 全 ignored → true；`getNeverKeys`：records 中 status=never 的 duplicateKey 集。同步在 store.ts 补 `getTypeWeights()` 导出
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): 建议频率学习 + 连续忽略静默"`

---

## Phase 2：工作模式分析器

### Task 7: analyst（LLM 隐含模式发现）

**Files:**
- Create: `apps/sidecar/src/services/suggest/analyst.ts` + `analyst.test.ts`

**Interfaces:**
- Consumes: memory-v2 entries 读取（`memory-v2/markdown-store.ts` 的 listEntries 或 retrieval）+ automation titles + LLM 调用（复用 `memory-v2/extraction.ts` 的 callLlm 适配）
- Produces: `runAnalysis(input): Promise<SuggestionCandidate[]>`；`validateAnalystCandidate(raw): SuggestionCandidate | null`

- [ ] **Step 1: 写 failing test（schema 严格校验为主，LLM 走 mock）**

```typescript
import { test, expect } from "bun:test";
import { validateAnalystCandidate, ALLOWED_KINDS } from "./analyst";

test("ALLOWED_KINDS 不含 correction/followup", () => {
  expect(ALLOWED_KINDS).toEqual(["automation", "skill", "todo"]);
});

test("越界 kind 被拒", () => {
  expect(validateAnalystCandidate({ kind:"correction", title:"t", reason:"r", evidence:"e", duplicateKey:"k", action:{type:"memory_correction",raw:"r",rule:"r"} })).toBeNull();
});

test("kind 与 action 不匹配被拒（automation 必须 open_automation_create）", () => {
  expect(validateAnalystCandidate({ kind:"automation", title:"t", reason:"r", evidence:"e", duplicateKey:"k", action:{type:"open_memory_board"} })).toBeNull();
});

test("字段超长被截断后接受", () => {
  const longTitle = "x".repeat(50);
  const c = validateAnalystCandidate({ kind:"automation", title:longTitle, reason:"r", evidence:"e", duplicateKey:"k", action:{type:"open_automation_create",automationTitle:"t",suggestedPrompt:"p"} });
  expect(c?.title.length).toBeLessThanOrEqual(40);
});

test("rawConfidence 默认值 automation=0.7", () => {
  const c = validateAnalystCandidate({ kind:"automation", title:"t", reason:"r", evidence:"e", duplicateKey:"k", action:{type:"open_automation_create",automationTitle:"t",suggestedPrompt:"p"} });
  expect(c?.rawConfidence).toBe(0.7);
});
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现 analyst.ts** — `ALLOWED_KINDS=["automation","skill","todo"]`，`MAX_CANDIDATES=3`；`ANALYST_PROMPT`（识别 4 类模式，输出严格 JSON 数组，kind/action 匹配约束，不确定输出 []）；`buildAnalysisInput`（recentMemoryEntries 60→slice40 content slice100 + active corrections 5 + automation names）；`callLlm` 复用 memory-v2 模型配置（temperature 0.2 / maxTokens 4096 / timeout 60s）；`parseAnalystResponse`（围栏剥离 + 区间提取 + Array.isArray）；`validateAnalystCandidate`（kind∈ALLOWED、字段 safeStr 非空、长度上限、kind-action 匹配、默认 rawConfidence）；`validateAnalystCandidates`（duplicateKey 去重 + slice 3）。LLM 调用包 try/catch fail-open 返回 []
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): 工作模式分析器 + schema 严格校验"`

---

## Phase 3：编排与接入

### Task 8: adapter（thread transcript → 对话文本）

**Files:**
- Create: `apps/sidecar/src/services/suggest/adapter.ts`
- 参考：`agent-thread-manager.ts`（确认 transcript 读取 API）

**Interfaces:**
- Produces: `extractRecentConversation(input: {threadId; workspaceSlug; limit?:30}): Promise<{role:"user"; content:string}[]>`

- [ ] **Step 1: 定位 transcript 读取 API** — Read `apps/sidecar/src/services/agent/agent-thread-manager.ts`，找读取 thread 历史 user message 的现成方法（候选：transcript append 的逆操作 / `merge-turns` 相关读取）。若无直接 API，从 thread store/jsonl 读取
- [ ] **Step 2: 实现 adapter.ts** — 按 Step 1 确认的 API 读取最近 N 条，过滤 role=user 纯文本（跳过 tool/thinking/attachment），content slice 800；空则返回 []
- [ ] **Step 3: typecheck + 简单单测**（mock thread 读取） — PASS
- [ ] **Step 4: Commit** — `rtk git commit -m "✨ feat(sidecar): 建议评估对话文本 adapter"`

---

### Task 9: service（编排）

**Files:**
- Create: `apps/sidecar/src/services/suggest/service.ts` + `service.test.ts`

**Interfaces:**
- Consumes: engine / feedback / analyst / store / adapter + `createAutomationJob` + `smartAddMemoryV2Candidate`
- Produces: `evaluateSessionSuggestions(ctx): Promise<void>`；`handleSuggestionFeedback(id, feedback): Promise<void>`；`runAnalysisAndPersist(ctx): Promise<number>`

- [ ] **Step 1: 写 failing test（编排逻辑，依赖 mock）**

```typescript
import { test, expect, mock } from "bun:test";
// mock store/engine/feedback/createAutomationJob/smartAddMemoryV2Candidate
test("evaluateSessionSuggestions: enabled 关 → 不评估", async () => {
  setEnabled(false); // mock
  await evaluateSessionSuggestions({ messages: [{role:"user",content:"以后不要用 var"}], threadId:"t", workspaceSlug:"ws", sessionId:"s" });
  expect(persistSuggestionMock).not.toHaveBeenCalled();
});

test("handleSuggestionFeedback accepted + memory_correction → smartAddMemoryV2Candidate 被调", async () => {
  const r = persistSuggestion({ duplicateKey:"k", kind:"correction", title:"t", reason:"r", evidence:"e", rawConfidence:0.95, action:{type:"memory_correction",raw:"以后不要用 var",rule:"不要用 var"} });
  await handleSuggestionFeedback(r.id, "accepted");
  expect(smartAddMock).toHaveBeenCalledWith(expect.objectContaining({ candidate: expect.objectContaining({ tags: expect.arrayContaining(["correction"]) }) }));
});
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现 service.ts** — `evaluateSessionSuggestions`：getEnabled 关→return；同会话 suggested 数 ≥maxPerSession→return；`evaluateSuggestions(messages, {typeWeights: getTypeWeights(), seenKeys, neverKeys, maxPerSession})`；静默 kind 跳过；`persistSuggestion` + `notifySuggestionsChanged()`（IPC 推送，Task 12 实现，此处调占位 broadcaster）。`handleSuggestionFeedback`：accepted+memory_correction→`smartAddMemoryV2Candidate({workspaceSlug, candidate:{kind:"preference", statement:rule, confidence:"high", tags:["correction","suggestion-derived"], claim:{subject:"user/self",predicate:"preference",object:rule}}})`；accepted+open_automation_create→`createAutomationJob({name:automationTitle, schedule:{type:"manual"}, prompt:suggestedPrompt})`；`recordFeedback(id, feedback)`。`runAnalysisAndPersist`：去重已有 suggested/never keys → `runAnalysis` → persistSuggestion 每个候选 + broadcaster。全程 try/catch fail-open
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): 建议编排服务（评估/反馈/分析）"`

---

### Task 10: workflow-hook 接入

**Files:**
- Create: `apps/sidecar/src/services/workflow-hooks/core-suggestion-hooks.ts`
- Modify: `apps/sidecar/src/services/workflow-hooks/hook-services.ts`

**Interfaces:**
- Consumes: `evaluateSessionSuggestions from service`；`extractRecentConversation from adapter`
- 参考：`core-memory-hooks.ts:27-40`（监听 `run.afterComplete` 的模式）

- [ ] **Step 1: Read `core-memory-hooks.ts` + `hook-services.ts`** — 确认 hook 注册模式与 `run.afterComplete` 事件 payload（是否含 threadId/workspaceSlug/sessionId）
- [ ] **Step 2: 实现 core-suggestion-hooks.ts** — 监听 `run.afterComplete`，fire-and-forget 调 `extractRecentConversation({threadId, workspaceSlug})` → `evaluateSessionSuggestions({messages, threadId, workspaceSlug, sessionId})`，try/catch 兜底（注释：建议评估必须不阻塞完成）
- [ ] **Step 3: 在 hook-services.ts 注册** — 仿 `createMemoryWorkflowHookService` 加 `createSuggestionWorkflowHookService`，注入 hook 列表
- [ ] **Step 4: typecheck** — `bun run --filter @lume/sidecar typecheck` → PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar): 建议评估 workflow-hook 接入 run.afterComplete"`

---

## Phase 4：RPC + 实时推送

### Task 11: sidecar RPC handlers + IPC channel

**Files:**
- Modify: `packages/shared/src/`（channel 枚举，定位现有 IPC channel 定义文件）
- Modify: `apps/sidecar/src/rpc/`（RpcHandler factory，参考 `model-meta-handlers.ts`）
- Create: `apps/sidecar/src/rpc/suggestion-handlers.ts`

**Interfaces（请求/响应 channel）**：`listSuggestions(status?) / actOnSuggestion(id, feedback) / getSuggestionStats / deleteSuggestion(id) / clearAllSuggestions / runSuggestionAnalysis(workspaceSlug) / setSuggestionsEnabled(bool)`

- [ ] **Step 1: 定位 IPC 4 层桥接入点** — Read `apps/sidecar/src/rpc/create-rpc-handlers.ts` + shared channel 枚举文件（参考 `project_lume-model-meta-runtime-data-source` 记忆的「IPC 模式参考：4 层」）
- [ ] **Step 2: shared 加 channel 枚举** + sidecar 加 `suggestion-handlers.ts`（每个 handler 调 service/store 对应方法，错误 throw→reject→toast 模式）
- [ ] **Step 3: 注册到 create-rpc-handlers** — 仿现有 handler 注册
- [ ] **Step 4: typecheck + handler 单测（仿 model-meta-handlers 测试模式）** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar,shared): 建议 RPC handlers + IPC channel"`

---

### Task 12: 实时推送（onSuggestionsChanged）

**Files:**
- Modify: 侧边推送机制（定位 sidecar→web 非 run 事件推送通道）
- Modify: `apps/sidecar/src/services/suggest/service.ts`（实现 `notifySuggestionsChanged`）
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`

**Interfaces（推送）**：`onSuggestionsChanged(cb) → unsubscribe`

- [ ] **Step 1: 定位推送通道** — 确认 Lume 现有「非 run 事件」sidecar→web 推送（grep `EventEmitter / emit / onRuntimeEvent` 在 `agent-handlers.ts` / `run-observer.ts`；automation job 变更如何通知 web 刷新）。选定最贴近机制（若无现成通用通道，复用 runtime event stream 加自定义事件类型）
- [ ] **Step 2: sidecar 实现 notifySuggestionsChanged** — 在 service.ts 的占位 broadcaster 落地为选定通道广播 `SUGGESTIONS_CHANGED`
- [ ] **Step 3: web 端订阅** — `useGlobalAgentListeners` 加 `onSuggestionsChanged` 订阅，触发建议状态 reload（提供给 SuggestionBanner/ProactiveHub 的 context 或 hook）
- [ ] **Step 4: typecheck + 手动验证推送链路** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(sidecar,web): 建议变更实时推送 onSuggestionsChanged"`

---

## Phase 5：UI

### Task 13: web IPC client

**Files:**
- Create: `apps/web/src/lib/desktop-api/suggestion.ts`
- 参考：`apps/web/src/lib/desktop-api/model.ts`（IPC client 模式）

**Interfaces**：封装 Task 11/12 的 channel 为 typed client：`listSuggestions / actOnSuggestion / getSuggestionStats / deleteSuggestion / clearAllSuggestions / runSuggestionAnalysis / setSuggestionsEnabled / onSuggestionsChanged`

- [ ] **Step 1: Read `desktop-api/model.ts`** — 确认 web 端 IPC client 调用模式（`window.desktopAPI` / sidecar_call 桥）
- [ ] **Step 2: 实现 suggestion.ts client** — 每个 channel 一个 typed 函数
- [ ] **Step 3: typecheck** — PASS
- [ ] **Step 4: Commit** — `rtk git commit -m "✨ feat(web): 建议 IPC client"`

---

### Task 14: SuggestionBanner 组件

**Files:**
- Create: `apps/web/src/components/agent/SuggestionBanner.tsx` + `.test.tsx`
- 参考：`apps/web/src/components/agent/AgentView.test.tsx`（fake DOM 测试模式，记忆 `reference_test-runner-bun-test`）

**Interfaces**：props `{ threadId; workspaceSlug }`；内部订阅 `onSuggestionsChanged`；渲染当前 thread+workspace 的 suggested 记录三态卡

- [ ] **Step 1: 写 failing test（fake DOM）**

```tsx
import { test, expect } from "bun:test";
// 仿 AgentView.test.tsx：fake desktopAPI + render 组件
test("无建议时不渲染", () => { /* listSuggestions 返回 [] → 容器为空 */ });
test("有建议时渲染三态按钮（接受/忽略/不再建议）", () => { /* */ });
test("点击忽略 → actOnSuggestion(id,'ignored') 被调", () => { /* */ });
test("会话隔离：只显示当前 threadId 的建议", () => { /* */ });
test("过期（>24h）不展示", () => { /* */ });
```

- [ ] **Step 2: 运行验证失败** — FAIL
- [ ] **Step 3: 实现 SuggestionBanner.tsx** — `useEffect` 订阅 `onSuggestionsChanged` reload；过滤 `record.threadId===threadId && record.workspaceSlug===workspaceSlug && status==="suggested" && now-createdAt<SUGGESTION_EXPIRY_MS(24h)`；三态按钮调 `actOnSuggestion`；视觉复用现有 Banner 模式（Sparkles 图标 + 卡片 + slide-in）。注意：renderer 写相关（如 toast）用 IPC，禁 `navigator.clipboard`（记忆 `lume-clipboard-write-ipc`，虽本组件大概率不涉及剪贴板）
- [ ] **Step 4: 运行验证通过** — PASS
- [ ] **Step 5: Commit** — `rtk git commit -m "✨ feat(web): SuggestionBanner 三态横幅 + 实时订阅"`

---

### Task 15: 挂载 SuggestionBanner 到 AgentInput

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

- [ ] **Step 1: Read `AgentInput.tsx`** — 找顶部挂载点（该文件 git status 已有改动，确认不冲突）
- [ ] **Step 2: 挂载** — `<SuggestionBanner threadId={threadId} workspaceSlug={workspaceSlug} />` 置于输入框上方
- [ ] **Step 3: typecheck + 手动验证** — PASS
- [ ] **Step 4: Commit** — `rtk git commit -m "✨ feat(web): AgentInput 挂载 SuggestionBanner"`

---

### Task 16: ProactiveHub 聚合视图

**Files:**
- Create: `apps/web/src/components/proactive/ProactiveHub.tsx`

**Interfaces**：聚合 `listSuggestions("suggested") / listAutomationJobs(active) / memory snapshot pending / getSuggestionStats`；「分析工作模式」按钮调 `runSuggestionAnalysis`

- [ ] **Step 1: 实现 ProactiveHub.tsx** — 布局见 spec §UI：header + 4 统计卡 + 建议列表（三态 + 删除）+ 正在关注（automation，`formatSchedule`）+ 需要确认（pending 跳 MemorySettings）+ 画像占位。并发拉取 `Promise.all`
- [ ] **Step 2: 「分析工作模式」按钮** — 调 `runSuggestionAnalysis(workspaceSlug)` + toast
- [ ] **Step 3: typecheck** — PASS
- [ ] **Step 4: Commit** — `rtk git commit -m "✨ feat(web): ProactiveHub 主动中心聚合视图"`

---

### Task 17: 侧栏导航入口

**Files:**
- Modify: 侧栏导航组件（定位 `LeftSidebar.tsx` 或主导航定义，grep 命中 `app-shell/LeftSidebar.tsx`）

- [ ] **Step 1: Read `LeftSidebar.tsx`** — 确认导航项注册模式（icon + label + view route）
- [ ] **Step 2: 新增「主动」项** — 路由到 ProactiveHub
- [ ] **Step 3: typecheck + 手动验证侧栏入口** — PASS
- [ ] **Step 4: Commit** — `rtk git commit -m "✨ feat(web): 侧栏新增「主动」入口"`

---

## Phase 6：集成验证

### Task 18: 端到端集成

**Files:**
- Create: `apps/sidecar/src/services/suggest/integration.test.ts`

- [ ] **Step 1: 写集成测试** — 模拟 run.afterComplete → hook 触发 → 含「以后不要用 var」的消息 → 评估 → persistSuggestion → 广播；验证 suggestions.json 出现 correction 记录；频率反馈 accepted 后 typeWeights.correction 升至 1.2
- [ ] **Step 2: 运行** — `bun test apps/sidecar/src/services/suggest/integration.test.ts` → PASS
- [ ] **Step 3: Commit** — `rtk git commit -m "🧪 test(sidecar): 建议系统端到端集成测试"`

---

### Task 19: 全量 typecheck + 测试

- [ ] **Step 1: typecheck 全包** — `bun run typecheck` → 全绿
- [ ] **Step 2: 测试全量** — `bun run test:core` → 新增测试全绿，无回归
- [ ] **Step 3: 修复回归**（若有）
- [ ] **Step 4: Commit**（若有修复） — `rtk git commit -m "🐛 fix: 建议系统全量验证修复"`

---

### Task 20: 子代理实测（对标 Proma 方法论）

- [ ] **Step 1: 派子代理真实体验** — 启动 app，真实对话含纠正词/时间词/周期词，验证：横幅渲染、三态交互、频率权重变化、ProactiveHub 聚合、分析按钮。重点排查 Proma P0 教训：「功能看似正常但真实链路从不执行」（SDKMessage 格式 / IPC 通道 / hook 注册是否真的被触发）
- [ ] **Step 2: 记录发现并修复**
- [ ] **Step 3: Commit** — `rtk git commit -m "🐛 fix: 子代理实测发现的问题修复"`

---

## Self-Review（plan 写完后自查）

1. **Spec 覆盖**：spec 的 9 个模块（types/signals/rules/engine/feedback/analyst/service/store/adapter）→ Task 1-9 全覆盖；UI（Banner/ProactiveHub/侧栏）→ Task 14-17；IPC/推送 → Task 11-13；workflow-hook → Task 10；分析器手动触发 → Task 7+16；correction 复用 pending → Task 9 Step 3；对话文本源 adapter → Task 8。✅
2. **占位符扫描**：Task 8/10/11/12/17 的 Step 1 是「定位现有 API」（必须先读代码确认），非占位符——这是 Lume 既有代码的接入点，执行时读取即明确。无 TBD/TODO。✅
3. **类型一致**：`SuggestionKind/Action/Candidate/Record` 在 Task 1 定义，后续 task 引用一致；`evaluateSuggestions` 返回 `{candidates, suppressed}` 在 Task 5 定义、Task 9 消费一致。✅
4. **依赖顺序**：Task 1(types)→2(store)→3-6(逻辑)→7(分析器)→8(adapter)→9(service)→10(hook)→11-12(rpc/推送)→13-17(ui)→18-20(验证)。service(Task 9) 依赖 store+engine+feedback+adapter，顺序正确。✅

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-proactive-suggestion.md`. Two execution options:

1. **Subagent-Driven（推荐）** — 每个 task 派 fresh subagent，task 间审查，快速迭代。适合本 plan 的 TDD task 结构。
2. **Inline Execution** — 本会话按 executing-plans 批量执行 + checkpoint 审查。

**Which approach?**
