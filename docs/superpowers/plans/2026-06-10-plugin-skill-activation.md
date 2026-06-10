# Plugin Skill Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `$<pluginName>:<skillSlug>` 语法激活插件技能——当用户在消息中输入该语法时，后端自动读取对应 SKILL.md 并将其内容注入模型上下文，让模型按技能指令执行。

**Architecture:** 利用已有的 `context.beforeAssemble` workflow hook 事件，在上下文组装前检测 `$plugin:skill` 语法，读取插件 SKILL.md 内容，通过 `AppendContextEffect.userMessageForModel` 注入模型输入。复用已有的插件 skill 注册机制（`run.ts` 中已按 `pluginName:skillName` 命名空间注册）。

**Tech Stack:** TypeScript, Bun test framework, Node.js fs/path

---

## File Structure

```
apps/sidecar/src/services/workflow-hooks/
├── core-plugin-hooks.ts          ← 新建：插件技能激活 hook handler
├── core-plugin-hooks.test.ts     ← 新建：单元测试
├── hook-runtime.ts               ← 修改：注册新 handler
└── contributions.ts              ← 修改：新增 contribution

apps/sidecar/src/services/skills/
└── workspace-skill-editor-service.ts  ← 修改：导出 plugin skill 路径解析
```

---

## Data Flow

```
用户输入: "$test-codex:hello-world 帮我做个测试"
    ↓
context.beforeAssemble hook 触发
    ↓
core.plugin.skill-activation handler:
  1. 正则匹配 /(\w+):(\w+)/ → pluginName="test-codex", skillSlug="hello-world"
  2. 读取 ~/.lume/plugins/test-codex/skills/hello-world/SKILL.md
  3. 构建注入内容: "[Skill: test-codex:hello-world]\n<SKILL.md 内容>\n[/Skill]\n\n用户请求: 帮我做个测试"
  4. 返回 AppendContextEffect { userMessageForModel: 注入内容 }
    ↓
ContextAssembler 将 userMessageForModel 发送给模型
    ↓
模型看到 SKILL.md 指令，按技能要求执行
```

---

### Task 1: 导出插件 Skill 路径解析函数

**Files:**
- Modify: `apps/sidecar/src/services/skills/workspace-skill-editor-service.ts`
- Test: (existing tests cover skill resolution)

**Goal:** 从 `readPluginEditableSkills` 中提取插件 skill 的 SKILL.md 路径解析逻辑，导出为独立函数供 hook handler 使用。

- [ ] **Step 1: 在 workspace-skill-editor-service.ts 中添加导出函数**

在文件末尾（`readPluginEditableSkills` 函数之后）添加：

```typescript
export function resolvePluginSkillPath(pluginName: string, skillSlug: string): string {
  const pluginDir = join(homedir(), ".lume", "plugins", pluginName);
  const skillsDir = join(pluginDir, "skills", skillSlug);
  const skillPath = join(skillsDir, "SKILL.md");
  // 路径穿越保护：确保解析后的路径在 skillsDir 下
  const relative = relative(skillsDir, skillPath);
  if (!relative || relative.startsWith("..") || relative.includes(sep + "..")) {
    throw new Error(`非法插件技能路径: ${skillPath}`);
  }
  return skillPath;
}

export function readPluginSkillContent(pluginName: string, skillSlug: string): string | null {
  try {
    const skillPath = resolvePluginSkillPath(pluginName, skillSlug);
    if (!existsSync(skillPath)) return null;
    return readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: 确认导出正确**

Run: `grep -n "resolvePluginSkillPath\|readPluginSkillContent" apps/sidecar/src/services/skills/workspace-skill-editor-service.ts`
Expected: 两个函数都已在文件末尾导出

- [ ] **Step 3: 验证类型编译通过**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无类型错误

---

### Task 2: 创建插件技能激活 Hook Handler

**Files:**
- Create: `apps/sidecar/src/services/workflow-hooks/core-plugin-hooks.ts`
- Test: `apps/sidecar/src/services/workflow-hooks/core-plugin-hooks.test.ts`

**Goal:** 创建 `core.plugin.skill-activation` handler，检测 `$plugin:skill` 语法并注入 SKILL.md 内容。

- [ ] **Step 1: 创建 core-plugin-hooks.ts**

```typescript
import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";
import { readPluginSkillContent } from "../skills/workspace-skill-editor-service";

const PLUGIN_SKILL_PATTERN = /\$(\w+):(\w+)/g;

export function createCorePluginHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.plugin.skill-activation": async (event, _context) => {
      if (event.event !== "context.beforeAssemble") return { effects: [] };
      const userMessage = event.userMessage?.trim();
      if (!userMessage) return { effects: [] };

      const activatedSkills: Array<{ pluginName: string; skillSlug: string; content: string }> = [];
      let match: RegExpExecArray | null;

      // 重置 lastIndex 以支持重复使用同一 RegExp
      PLUGIN_SKILL_PATTERN.lastIndex = 0;
      while ((match = PLUGIN_SKILL_PATTERN.exec(userMessage)) !== null) {
        const [, pluginName, skillSlug] = match;
        const content = readPluginSkillContent(pluginName, skillSlug);
        if (content) {
          activatedSkills.push({ pluginName, skillSlug, content });
        }
      }

      if (activatedSkills.length === 0) return { effects: [] };

      // 从用户消息中移除 $plugin:skill 语法标记
      const cleanedMessage = userMessage.replace(PLUGIN_SKILL_PATTERN, "").trim();
      const skillContextBlocks = activatedSkills.map(
        ({ pluginName, skillSlug, content }) =>
          `[Skill: ${pluginName}:${skillSlug}]\n${content}\n[/Skill]`
      ).join("\n\n");

      const userMessageForModel = cleanedMessage.length > 0
        ? `${skillContextBlocks}\n\n用户请求: ${cleanedMessage}`
        : skillContextBlocks;

      return {
        effects: [{
          type: "appendContext",
          source: "hook:plugin-skill-activation",
          content: skillContextBlocks,
          hidden: false,
          usedMemoryItems: [],
          userMessageForModel
        }]
      };
    }
  };
}
```

- [ ] **Step 2: 创建 core-plugin-hooks.test.ts**

```typescript
import { describe, expect, test } from "bun:test";
import { createCorePluginHookHandlers } from "./core-plugin-hooks";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const handler = createCorePluginHookHandlers()["core.plugin.skill-activation"]!;

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "context.beforeAssemble",
    runId: "test-run",
    threadId: "test-thread",
    userMessage: "",
    availableTools: [],
    tokenBudget: 4000,
    ...overrides
  };
}

describe("core.plugin.skill-activation", () => {
  const testPluginRoot = join(homedir(), ".lume", "plugins", "test-plugin");

  test.beforeAll(() => {
    mkdirSync(join(testPluginRoot, "skills", "hello"), { recursive: true });
    writeFileSync(
      join(testPluginRoot, "skills", "hello", "SKILL.md"),
      "---\nname: hello\ndescription: test skill\n---\n\nHello skill instructions."
    );
  });

  test("returns no effects when no $plugin:skill syntax", async () => {
    const result = await handler(makeEvent({ userMessage: "hello world" }), { services: {} });
    expect(result.effects).toHaveLength(0);
  });

  test("activates plugin skill when $plugin:skill syntax present", async () => {
    const result = await handler(makeEvent({ userMessage: "$test-plugin:hello 帮我测试" }), { services: {} });
    expect(result.effects).toHaveLength(1);
    const effect = result.effects[0];
    expect(effect.type).toBe("appendContext");
    expect(effect.userMessageForModel).toContain("[Skill: test-plugin:hello]");
    expect(effect.userMessageForModel).toContain("Hello skill instructions.");
    expect(effect.userMessageForModel).toContain("用户请求: 帮我测试");
  });

  test("removes $plugin:skill syntax from user message", async () => {
    const result = await handler(makeEvent({ userMessage: "$test-plugin:hello 帮我测试" }), { services: {} });
    expect(result.effects[0].userMessageForModel).not.toContain("$test-plugin:hello");
  });

  test("returns no effects for non-existent plugin skill", async () => {
    const result = await handler(makeEvent({ userMessage: "$test-plugin:nonexistent 帮我测试" }), { services: {} });
    expect(result.effects).toHaveLength(0);
  });

  test("ignores non-context.beforeAssemble events", async () => {
    const result = await handler(makeEvent({ event: "run.afterComplete", userMessage: "$test-plugin:hello" }), { services: {} });
    expect(result.effects).toHaveLength(0);
  });

  test("returns no effects for empty user message", async () => {
    const result = await handler(makeEvent({ userMessage: "" }), { services: {} });
    expect(result.effects).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test apps/sidecar/src/services/workflow-hooks/core-plugin-hooks.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/sidecar/src/services/workflow-hooks/core-plugin-hooks.test.ts`
Expected: PASS (5/5)

---

### Task 3: 注册 Handler 到 Hook Runtime

**Files:**
- Modify: `apps/sidecar/src/services/workflow-hooks/hook-runtime.ts`

**Goal:** 将 `core.plugin.skill-activation` handler 注册到 workflow hook runtime。

- [ ] **Step 1: 修改 hook-runtime.ts 导入和创建函数**

修改 `createLumeWorkflowHookRuntime`：

```typescript
import { createCoreMemoryHookHandlers } from "./core-memory-hooks";
import { createCoreObservabilityHookHandlers } from "./core-observability-hooks";
import { createCoreSecurityHookHandlers } from "./core-security-hooks";
import { createCorePluginHookHandlers } from "./core-plugin-hooks";  // ← 新增
import { createCoreWorkflowHookContributions } from "./contributions";

export function createLumeWorkflowHookRuntime(input: {
  config: LumeConfigHooksInternalSection;
  services: LumeWorkflowHookHandlerContext["services"];
}): LumeWorkflowHookRuntime {
  return new LumeWorkflowHookRuntime(new LumeWorkflowHookBus({
    contributions: createCoreWorkflowHookContributions(input.config),
    handlers: {
      ...createCoreMemoryHookHandlers(),
      ...createCoreSecurityHookHandlers(),
      ...createCoreObservabilityHookHandlers(),
      ...createCorePluginHookHandlers(),  // ← 新增
    },
    context: { services: input.services }
  }));
}
```

- [ ] **Step 2: 验证类型编译通过**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无类型错误

---

### Task 4: 添加 Contribution

**Files:**
- Modify: `apps/sidecar/src/services/workflow-hooks/contributions.ts`

**Goal:** 在 `context.beforeAssemble` 事件中注册 plugin skill activation contribution，优先级在 memory hook 之后。

- [ ] **Step 1: 修改 contributions.ts**

在 `createCoreWorkflowHookContributions` 的返回数组中添加：

```typescript
export function createCoreWorkflowHookContributions(
  config: LumeConfigHooksInternalSection
): LumeWorkflowHookContribution[] {
  if (config.enabled === false) return [];
  return [
    ...(config.memory === false ? [] : [
      {
        id: "core.memory.context",
        pluginId: "lume-core",
        event: "context.beforeAssemble",
        phase: "decision",
        priority: "core",
        capabilities: ["context.append"],
        handlerRef: "core.memory.context"
      },
      {
        id: "core.memory.completion",
        pluginId: "lume-core",
        event: "run.afterComplete",
        phase: "observe",
        priority: "core",
        capabilities: ["memory.enqueue"],
        handlerRef: "core.memory.completion"
      }
    ] satisfies LumeWorkflowHookContribution[]),
    // ← 新增：插件技能激活 contribution
    {
      id: "core.plugin.skill-activation",
      pluginId: "lume-core",
      event: "context.beforeAssemble",
      phase: "decision",
      priority: "normal",       // 在 core.memory.context 之后执行
      capabilities: ["context.append"],
      handlerRef: "core.plugin.skill-activation"
    },
    ...(config.security === false ? [] : [
      {
        id: "core.security.permission",
        pluginId: "lume-core",
        event: "permission.beforeDecision",
        phase: "decision",
        priority: "core",
        capabilities: ["permission.decide"],
        handlerRef: "core.security.permission"
      }
    ] satisfies LumeWorkflowHookContribution[]),
    ...(config.observability === false ? [] : [
      {
        id: "core.observability.trace",
        pluginId: "lume-core",
        event: "context.afterAssemble",
        phase: "observe",
        priority: "core",
        capabilities: ["trace.write"],
        handlerRef: "core.observability.trace"
      }
    ] satisfies LumeWorkflowHookContribution[])
  ];
}
```

**优先级说明：**
- `core.memory.context` = `"core"` → 先执行（注入记忆上下文）
- `core.plugin.skill-activation` = `"normal"` → 后执行（注入技能上下文）
- 两者都是 `decision` phase，按 priority 排序执行

- [ ] **Step 2: 验证类型编译通过**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 无类型错误

---

### Task 5: 端到端集成测试

**Files:**
- Create: `apps/sidecar/src/services/workflow-hooks/core-plugin-hooks.integration.test.ts`

**Goal:** 验证完整的 hook 执行流程——从 `context.beforeAssemble` 事件到 `AppendContextEffect` 的正确注入。

- [ ] **Step 1: 创建集成测试**

```typescript
import { describe, expect, test } from "bun:test";
import { createLumeWorkflowHookRuntime } from "./hook-runtime";
import { LumeWorkflowContextBeforeAssembleEvent } from "./hook-events";

describe("plugin skill activation integration", () => {
  test("injects skill content into userMessageForModel via hook bus", async () => {
    const runtime = createLumeWorkflowHookRuntime({
      config: { enabled: true },
      services: {
        memory: { recallContext: async () => ({ prefix: "", items: [], userMessageForModel: "" }), extractCandidates: async () => [] },
        security: { evaluatePermissionDecision: async () => ({}) },
        runtimeEvents: { buildDiagnosticEvent: (input) => ({ type: "workflow_hook.diagnostic", ...input }) },
        trace: { buildHookTrace: (input) => ({ type: "workflow_hook", ...input }) },
        clock: { now: () => new Date() }
      }
    });

    const event: LumeWorkflowContextBeforeAssembleEvent = {
      event: "context.beforeAssemble",
      runId: "test-run",
      threadId: "test-thread",
      workspaceSlug: "test-workspace",
      userMessage: "$test-plugin:hello 帮我写个测试",
      availableTools: [],
      tokenBudget: 4000
    };

    const result = await runtime.execute(event);
    const appendEffects = result.effects.filter(e => e.effect.type === "appendContext");
    expect(appendEffects.length).toBeGreaterThanOrEqual(1);

    const skillEffect = appendEffects.find(
      (e) => e.effect.source === "hook:plugin-skill-activation"
    );
    expect(skillEffect).toBeDefined();
    expect(skillEffect!.effect.userMessageForModel).toContain("Hello skill instructions.");
    expect(skillEffect!.effect.userMessageForModel).toContain("用户请求: 帮我写个测试");
    expect(skillEffect!.effect.userMessageForModel).not.toContain("$test-plugin:hello");
  });
});
```

- [ ] **Step 2: 运行集成测试**

Run: `bun test apps/sidecar/src/services/workflow-hooks/core-plugin-hooks.integration.test.ts`
Expected: PASS

---

### Task 6: 清理测试文件

**Files:**
- Remove: 测试中创建的临时插件文件

- [ ] **Step 1: 确认测试产物可清理**

在 `core-plugin-hooks.test.ts` 的 `afterAll` 中添加清理（如果后续需要）：

```typescript
test.afterAll(() => {
  // 可选：清理测试创建的临时插件文件
});
```

- [ ] **Step 2: 确认所有测试通过**

Run: `bun test apps/sidecar/src/services/workflow-hooks/`
Expected: 所有测试 PASS

---

## Verification Checklist

完成所有任务后，验证以下端到端流程：

1. **前端**：用户在输入框输入 `$test-codex:hello-world 试试`
2. **前端**：TipTap editor 的 mention 系统识别 `$` 触发下拉（已有）
3. **前端**：用户选择 `test-codex:hello-world`，消息以 `$test-codex:hello-world 试试` 发送
4. **后端**：`appendAgentMessage` → `runAgentRuntime` → `context.beforeAssemble` hook 触发
5. **后端**：`core.plugin.skill-activation` handler 检测 `$test-codex:hello-world`
6. **后端**：读取 `~/.lume/plugins/test-codex/skills/hello-world/SKILL.md`
7. **后端**：通过 `AppendContextEffect.userMessageForModel` 注入 SKILL.md 内容
8. **后端**：`ContextAssembler` 构建最终 prompt，模型收到含 SKILL.md 指令的 user message
9. **模型**：按 SKILL.md 中的指令执行，调用 `Skill` 工具或按技能流程响应

---

## 后续扩展（不在本计划范围内）

- 支持 `$<plugin>:<skill> --arg value` 参数化调用
- 前端输入时自动补全 `$plugin:skill` 语法
- Hook 支持多个 `$plugin:skill` 同时激活
- 插件 skill 激活的 token 预算管理
- 前端展示已激活插件的视觉指示
