# 主动中心 + 工作模式分析自动触发 设计 spec

> **周期**：周期 3（主动中心自动化）
> **日期**：2026-08-04
> **对标**：[`proma-ai/Proma#1409`](https://github.com/proma-ai/Proma/pull/1409) § 三、主动中心 + 工作模式分析（Phase B）
> **前置**：周期 1（主动建议系统 PR #8）+ 周期 2（L3 Persona PR #9）已 merged
> **状态**：设计稿，待用户审阅 → writing-plans

---

## 目标

把周期 1 的「手动点按钮分析工作模式」进化到「**定时自动分析 + persona 增强 + Agent 可主动调**」。补齐周期 1 刻意预留的两处闭环（analyst 跳过 persona、suggestion_analyze 工具未注册），并加 automation 定时 + suggestion-daily skill 实现真正自动化。

**定位边界**：不重建主动中心（ProactiveHub 周期 1 已做，不动；「分析工作模式」手动按钮保留）。本周期是 4 项增量增强 + 自动化。

## 周期 3 真实增量（4 项）

| 增量 | 周期 1/2 现状 | 周期 3 工作 |
|---|---|---|
| **analyst 接 persona** | analyst.ts line 24/146 明确「persona 段跳过（Lume persona 未完整）」 | 移除跳过，readPersonaRaw + parsePersonaProfile → summary + preferences 注入 buildAnalysisInput |
| **suggestion_analyze 工具** | runAnalysisAndPersist 函数有，但**未注册为 Agent 工具**（grep 确认 origin/main 无） | 注册 builtin tool（create-lume-tools.ts），Agent/automation 可调 |
| **automation 定时** | 仅 ProactiveHub 手动按钮；automation 底座完整（周期 1） | suggestion-daily skill 引导用户建每日 cron automation → job prompt 调 suggestion_analyze |
| **suggestion-daily skill** | 无 | 内置 skill（default-skills/suggestion-daily/），指导建每日分析 automation + 处理 ProactiveHub 建议 |

## 架构

```
┌─ 增量 1: analyst 接 persona (enhance) ──────────────────────┐
│  analyst.ts buildAnalysisInput:                             │
│    readPersonaRaw(scope) → parsePersonaProfile              │
│    → 注入 persona.summary + preferences（LLM 看到画像）      │
│  移除 line 24/146「persona 跳过」注释                        │
└─────────────────────────────────────────────────────────────┘

┌─ 增量 2: suggestion_analyze 工具 (注册) ────────────────────┐
│  create-lume-tools.ts: 注册「suggestion_analyze」builtin    │
│    无参数 → service.runAnalysisAndPersist() → 返回 added 数 │
│  Agent 可调（automation job prompt / 用户对话）              │
└─────────────────────────────────────────────────────────────┘

┌─ 增量 3+4: automation 定时 + skill ─────────────────────────┐
│  default-skills/suggestion-daily/SKILL.md:                  │
│    指导用户建每日 23:30 automation job（cron）               │
│    job prompt: "调用 suggestion_analyze 分析近期工作模式"    │
│    → Agent 调 suggestion_analyze → runAnalysisAndPersist     │
│    → 新建议进 ProactiveHub（用户下次看）                     │
│  复用周期 1 automation（createAutomationJob cron/once）      │
└─────────────────────────────────────────────────────────────┘
```

## 模块设计

### 1. analyst 接 persona（`apps/sidecar/src/services/suggest/analyst.ts`，modify）

- `buildAnalysisInput`：加 persona 读取。
  - `readPersonaRaw(scope)` → 若存在 → `parsePersonaProfile(md)` → 取 `summary` + `preferences.slice(0,8)`。
  - 注入 analyst input 作为「用户画像」段（persona 不存在则跳过，保持周期 1 行为）。
  - 移除 line 24/146「persona 跳过」注释，改为「persona 注入（周期 2 完成）」。
- LLM ANALYST_PROMPT 已有「用户画像（persona）」段（周期 1 预留），现在真正填充。
- fail-open：persona 读取失败 → 跳过（不影响分析）。

### 2. suggestion_analyze 工具（`apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`，modify）

- 注册 builtin tool `suggestion_analyze`：
  - 无参数。
  - 描述：「分析近期记忆与用户画像，发现可自动化/沉淀的工作模式，产出主动建议。低频高价值（不建议每天多次）。」
  - 调用 `service.runAnalysisAndPersist({})`（默认 global scope；workspace 由 Agent context）。
  - 返回：`{ added: number }`（新增建议数）+ 简短说明（"分析了 N 条记忆，发现 M 个候选模式，已加入主动中心"）。
- 参考 create-lume-tools.ts 现有 builtin tool 注册模式（zod schema + handler）。

### 3. automation 定时（复用周期 1，无新代码）

- 用户经 suggestion-daily skill 引导，建 automation job：
  - schedule: cron（如每日 23:30：`30 23 * * *`）。
  - prompt: 「调用 suggestion_analyze 分析近期工作模式」。
- Agent 执行 job prompt → 调 suggestion_analyze → runAnalysisAndPersist。
- 复用 `createAutomationJob`（周期 1）。无新触发机制。

### 4. suggestion-daily skill（`apps/sidecar/default-skills/suggestion-daily/SKILL.md`，create）

- group: lume, version 1.0.0。
- 内容：
  - 何时用：用户想定期自动分析工作模式 / 建立每日主动建议复盘。
  - 步骤：调 `suggestion_analyze` 工具运行分析；引导用户在主动中心处理建议；建议用户建每日 automation job（调 createAutomationJob cron 23:30 + prompt 调 suggestion_analyze）让分析无人值守。
  - 强调低频高价值（不建议比每天更频繁）、只读记忆、保守产出（产出为空正常）。
- 触发词：分析工作模式 / 发现可自动化习惯 / suggestion-daily。
- 参考 default-skills 现有 skill 结构（SKILL.md frontmatter + body）。

## 错误处理（fail-open）

- analyst persona 读取失败 → 跳过 persona 段（不影响分析，保持周期 1 行为）。
- suggestion_analyze 工具失败 → runAnalysisAndPersist 已 fail-open（返回 0）。
- automation job 执行 → 复用 automation runner（周期 1 fail-open）。

## 测试策略

- **analyst persona 注入**（modify analyst.test.ts）：mock readPersonaRaw → buildAnalysisInput 含 persona summary/preferences；persona 不存在 → 跳过（周期 1 行为）。
- **suggestion_analyze 工具**（create-lume-tools test）：工具注册 + 调用 → runAnalysisAndPersist 被调 + 返回 added。
- **suggestion-daily skill**：default-skills inventory 测试（skill 被识别）+ 内容审查（触发词/步骤）。
- **集成**：suggestion_analyze 工具 → runAnalysisAndPersist → suggestions.json（端到端）。

## 与 Proma 的偏离点（Lume 适配）

| 偏离 | Proma | Lume | 理由 |
|---|---|---|---|
| automation | mcp__automation__create_automation | createAutomationJob（周期 1 底座） | 复用既有 |
| suggestion_analyze 工具 | Pi/Claude 双 runtime MCP | Lume builtin tools（create-lume-tools.ts） | 适配 Lume 工具体系 |
| analyst persona 输入 | memory atoms | memory-v2 persona.md（周期 2） | 适配 Lume 数据模型 |
| skill 位置 | default-skills/suggestion-daily/ | 同（Lume default-skills 机制） | 一致 |

## 文件清单

**Modify**：
- `apps/sidecar/src/services/suggest/analyst.ts` + `.test.ts`（persona 注入 + 移除跳过）
- `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts` + 相关 test（注册 suggestion_analyze）

**Create**：
- `apps/sidecar/default-skills/suggestion-daily/SKILL.md`（内置 skill）
- 可能：default-skills inventory test 更新（识别新 skill）

## 验证标准

1. **analyst persona**：analyst.test 验证 persona 注入（mock）+ 不存在跳过。
2. **suggestion_analyze 工具**：注册 + 调用 → runAnalysisAndPersist + 返回 added。
3. **suggestion-daily skill**：inventory 识别 + 内容含触发词/步骤。
4. **端到端**：suggestion_analyze 工具 → suggestions.json 新建议（ProactiveHub 可见）。
5. **fail-open**：persona/工具失败不影响主流程。

## 已确认决策（2026-08-04）

1. **scope**：全做 4 项（analyst persona + suggestion_analyze 工具 + automation 定时 + suggestion-daily skill）。
2. **自动触发**：automation 定时（对齐 Proma，复用周期 1 automation，用户可控 + 每日节流）。
3. **suggestion_analyze 工具**：无参数（调用即分析，对齐 Proma）。
4. **不重建主动中心**：ProactiveHub（周期 1）不动；手动「分析工作模式」按钮保留。
