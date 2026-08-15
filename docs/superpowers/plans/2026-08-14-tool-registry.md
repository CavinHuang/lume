# P1 分层 ToolRegistry 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立分层 ToolRegistry（global/preset/agent 三层 + restrict 掩码 + nearest-wins shadow），作为工具装配的唯一事实源，对外行为不变。

**Architecture:** 新建 `registry.ts` 持有三层工具注册与掩码，`resolve` 在装配时机（`rebuildToolPool` / overrides 处理）求值出 `visible()` 与 `split()`。现有 `assembleToolPool`/`filterTools`/`splitDeferredTools` 保留为折算适配器，`agent.ts` 的装配逻辑改为写 registry 再 resolve。engine 每步循环零改动。

**Tech Stack:** TypeScript、bun:test。pattern 匹配复用 `packages/sdk/src/utils/tool-approval.ts` 的 `matchesAnyToolPattern`。

**Spec:** `docs/superpowers/specs/2026-08-14-tool-injection-optimization-design.md`（P1 节）

## Global Constraints

- 禁止在 main 上直接改代码：先建 worktree + 新分支（`feat/tool-registry`），经 PR 合并；worktree 内先 `bun install`
- 测试跑 bun:test：`bun test packages/sdk/src/tools/registry.test.ts`
- 提交信息用 emoji 前缀（如 `✨ feat:` / `✅ test:`）
- 行为保持：Task 3/4 完成后，`packages/sdk` 与 `apps/sidecar` 现有测试全部不红（CI 对比 main baseline，平台性红测不算回归）
- `allowedInPlanMode` 属权限域（sidecar permission-engine），本计划不触碰
- 注释语言跟随现有代码（sdk 内英文注释为主）

---

### Task 1: ToolRegistry 核心解析

**Files:**
- Create: `packages/sdk/src/tools/registry.ts`
- Test: `packages/sdk/src/tools/registry.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`（`../types.js`）、`matchesAnyToolPattern`（`../utils/tool-approval.js`）
- Produces:
  ```ts
  export interface ToolMask { allow?: string[]; deny?: string[] }
  export interface RegistryView {
    visible(): ToolDefinition[]
    split(): { core: ToolDefinition[]; deferred: ToolDefinition[] }
  }
  export interface LayerHandle {
    register(tools: ToolDefinition[]): () => void
    setCore(names: string[]): void
    restrict(mask: ToolMask): () => void
  }
  export interface ToolRegistry {
    global: LayerHandle
    preset(key: string): LayerHandle
    agent(id: string): LayerHandle & { view(): RegistryView }
  }
  export function createToolRegistry(): ToolRegistry
  ```
  解析语义（后续任务依赖）：
  - 层序 global → preset → agent，同名工具 nearest-wins（后面的层覆盖前面）
  - 掩码：deny 取所有层并集；allow 取所有非空 allow 的交集；先 allow 后 deny
  - `split()`：core = 名字命中**最近一层**的 setCore 集合，或 `runtimeMetadata?.requiredDuringSkillScope === true`；其余 deferred；`ToolSearch`/`ExecuteTool` 永远排除
  - `visible()` 输出顺序 = 工具首次注册的插入序

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../types";
import { createToolRegistry } from "./registry.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    call: async () => ({ type: "tool_result", tool_use_id: "", content: name }),
  };
}

describe("tool registry", () => {
  test("global tools are visible", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("Read")]);
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  test("agent layer shadows same-name global tool", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash")]);
    const sandboxed = tool("Bash");
    sandboxed.description = "sandboxed";
    registry.agent("a1").register([sandboxed]);
    const visible = registry.agent("a1").view().visible();
    expect(visible).toHaveLength(1);
    expect(visible[0].description).toBe("sandboxed");
  });

  test("deny masks union across layers, allow masks intersect", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("Read"), tool("WebFetch")]);
    registry.preset("default").restrict({ allow: ["Bash", "Read", "WebFetch"] });
    registry.agent("a1").restrict({ deny: ["WebFetch"] });
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  test("layers are isolated per agent", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash")]);
    registry.agent("a1").restrict({ deny: ["Bash"] });
    expect(registry.agent("a2").view().visible().map((t) => t.name)).toEqual(["Bash"]);
  });

  test("register and restrict disposers undo their effect", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash")]);
    const undo = registry.agent("a1").restrict({ deny: ["Bash"] });
    undo();
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toEqual(["Bash"]);
  });

  test("split uses nearest setCore plus requiredDuringSkillScope", () => {
    const registry = createToolRegistry();
    const skillTool = tool("GuanlanSearch");
    skillTool.runtimeMetadata = { requiredDuringSkillScope: true } as never;
    registry.global.register([tool("Bash"), tool("WebFetch"), skillTool]);
    registry.preset("default").setCore(["Bash"]);
    const { core, deferred } = registry.agent("a1").view().split();
    expect(core.map((t) => t.name).sort()).toEqual(["Bash", "GuanlanSearch"]);
    expect(deferred.map((t) => t.name)).toEqual(["WebFetch"]);
  });

  test("agent setCore shadows preset setCore", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("WebFetch")]);
    registry.preset("default").setCore(["Bash"]);
    registry.agent("a1").setCore(["WebFetch"]);
    const { core } = registry.agent("a1").view().split();
    expect(core.map((t) => t.name)).toEqual(["WebFetch"]);
  });

  test("ToolSearch and ExecuteTool never appear in split results", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("ToolSearch"), tool("ExecuteTool")]);
    const view = registry.agent("a1").view();
    const names = [...view.split().core, ...view.split().deferred].map((t) => t.name);
    expect(names).not.toContain("ToolSearch");
    expect(names).not.toContain("ExecuteTool");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/sdk/src/tools/registry.test.ts`
Expected: FAIL — `Cannot resolve module "./registry.js"`

- [ ] **Step 3: 最小实现**

```ts
/** Layered tool registry: global → preset → agent, resolved at assembly time. */

import type { ToolDefinition } from "../types.js";
import { matchesAnyToolPattern } from "../utils/tool-approval.js";

export interface ToolMask {
  allow?: string[];
  deny?: string[];
}

export interface RegistryView {
  visible(): ToolDefinition[];
  split(): { core: ToolDefinition[]; deferred: ToolDefinition[] };
}

export interface LayerHandle {
  register(tools: ToolDefinition[]): () => void;
  setCore(names: string[]): void;
  restrict(mask: ToolMask): () => void;
}

export interface ToolRegistry {
  global: LayerHandle;
  preset(key: string): LayerHandle;
  agent(id: string): LayerHandle & { view(): RegistryView };
}

interface Layer {
  tools: Map<string, ToolDefinition>;
  order: string[];
  core: Set<string> | undefined;
  masks: ToolMask[];
}

const RESERVED = new Set(["ToolSearch", "ExecuteTool"]);

function newLayer(): Layer {
  return { tools: new Map(), order: [], core: undefined, masks: [] };
}

function handle(layer: Layer): LayerHandle {
  return {
    register(tools) {
      for (const t of tools) {
        if (!layer.tools.has(t.name)) layer.order.push(t.name);
        layer.tools.set(t.name, t);
      }
      return () => {
        for (const t of tools) {
          layer.tools.delete(t.name);
          const index = layer.order.indexOf(t.name);
          if (index >= 0) layer.order.splice(index, 1);
        }
      };
    },
    setCore(names) {
      layer.core = new Set(names);
    },
    restrict(mask) {
      layer.masks.push(mask);
      return () => {
        const index = layer.masks.indexOf(mask);
        if (index >= 0) layer.masks.splice(index, 1);
      };
    },
  };
}

export function createToolRegistry(): ToolRegistry {
  const globalLayer = newLayer();
  const presets = new Map<string, Layer>();
  const agents = new Map<string, Layer>();

  const layerOf = (map: Map<string, Layer>, key: string): Layer => {
    let layer = map.get(key);
    if (!layer) map.set(key, (layer = newLayer()));
    return layer;
  };

  const chain = (id: string): Layer[] => [globalLayer, layerOf(presets, "default"), layerOf(agents, id)];

  const merged = (id: string): { byName: Map<string, ToolDefinition>; order: string[] } => {
    const byName = new Map<string, ToolDefinition>();
    const order: string[] = [];
    for (const layer of chain(id)) {
      for (const name of layer.order) {
        const t = layer.tools.get(name);
        if (!t) continue;
        if (!byName.has(name)) order.push(name);
        byName.set(name, t);
      }
    }
    return { byName, order };
  };

  return {
    global: handle(globalLayer),
    preset: (key) => handle(layerOf(presets, key)),
    agent: (id) => {
      const layer = layerOf(agents, id);
      const view: RegistryView = {
        visible() {
          const { byName, order } = merged(id);
          const masks = chain(id).flatMap((l) => l.masks);
          const allows = masks.map((m) => m.allow).filter((a): a is string[] => !!a && a.length > 0);
          const denies = masks.flatMap((m) => m.deny ?? []);
          return order
            .map((name) => byName.get(name)!)
            .filter((t) => allows.every((a) => matchesAnyToolPattern(t.name, a)))
            .filter((t) => !matchesAnyToolPattern(t.name, denies));
        },
        split() {
          const visible = this.visible().filter((t) => !RESERVED.has(t.name));
          const core = chain(id).reverse().find((l) => l.core !== undefined)?.core ?? new Set<string>();
          return {
            core: visible.filter((t) => core.has(t.name) || t.runtimeMetadata?.requiredDuringSkillScope === true),
            deferred: visible.filter((t) => !core.has(t.name) && t.runtimeMetadata?.requiredDuringSkillScope !== true),
          };
        },
      };
      return { ...handle(layer), view };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/sdk/src/tools/registry.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 5: 提交**

```bash
rtk git add packages/sdk/src/tools/registry.ts packages/sdk/src/tools/registry.test.ts
rtk git commit -m "✨ feat(sdk): add layered ToolRegistry with shadow/mask/split resolution"
```

---

### Task 2: splitDeferredTools 折算到 registry

**Files:**
- Modify: `packages/sdk/src/tools/index.ts:258-273`（`splitDeferredTools`）
- Test: `packages/sdk/src/tools/registry.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `createToolRegistry`/`CORE_TOOL_NAMES`（同文件 `index.ts:134`）
- Produces: `splitDeferredTools(tools)` 签名与行为不变（既有调用方 `agent.ts:613`、`engine.ts:2154` 附近逻辑不受影响）；新增内部函数 `coreNamesFromDefaults(): Set<string>`

- [ ] **Step 1: 追加失败测试**（registry.test.ts 末尾）

```ts
import { splitDeferredTools, CORE_TOOL_NAMES } from "./index.js";

describe("splitDeferredTools adapter", () => {
  test("splits by CORE_TOOL_NAMES and requiredDuringSkillScope", () => {
    const skillTool = tool("GuanlanSearch");
    skillTool.runtimeMetadata = { requiredDuringSkillScope: true } as never;
    const { core, deferred } = splitDeferredTools([tool("Bash"), tool("WebFetch"), skillTool, tool("ToolSearch")]);
    expect(core.map((t) => t.name)).toEqual(["Bash", "GuanlanSearch"]);
    expect(deferred.map((t) => t.name)).toEqual(["WebFetch"]);
  });

  test("CORE_TOOL_NAMES stays the default preset core set", () => {
    expect(CORE_TOOL_NAMES.has("Bash")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `bun test packages/sdk/src/tools/registry.test.ts`
Expected: 新用例 PASS（现有实现已满足 —— 这是行为锁定测试；若 FAIL 先修当前实现的不一致再继续）

- [ ] **Step 3: 改写 splitDeferredTools 为 registry 折算**

`index.ts` 中 `splitDeferredTools` 函数体替换为（签名与导出不变）：

```ts
export function splitDeferredTools(tools: ToolDefinition[]): {
  core: ToolDefinition[]
  deferred: ToolDefinition[]
} {
  const registry = createToolRegistry();
  registry.global.register(tools);
  registry.preset("default").setCore([...CORE_TOOL_NAMES]);
  return registry.agent("adapter").view().split();
}
```

并在文件头部导入 `createToolRegistry`（`import { createToolRegistry } from './registry.js'`）。

- [ ] **Step 4: 全量回归**

Run: `bun test packages/sdk/src/tools/`
Expected: PASS（含 index.test.ts 既有用例）

- [ ] **Step 5: 提交**

```bash
rtk git add packages/sdk/src/tools/index.ts packages/sdk/src/tools/registry.test.ts
rtk git commit -m "♻️ refactor(sdk): route splitDeferredTools through ToolRegistry"
```

---

### Task 3: rebuildToolPool 接线 registry

**Files:**
- Modify: `packages/sdk/src/agent.ts:250-251`（池字段）、`agent.ts:592-628`（`rebuildToolPool`）
- Test: `packages/sdk/src/agent.test.ts`（追加用例；已有装配相关用例作回归）

**Interfaces:**
- Consumes: Task 1 `createToolRegistry`、Task 2 `CORE_TOOL_NAMES`
- Produces: `Agent` 新增私有字段 `private toolRegistry = createToolRegistry()`；`rebuildToolPool` 结束后 `this.toolPool`/`this.deferredToolPool` 的内容与改前完全一致（`agent.ts:928-942` 的 overrides 消费路径不变）

- [ ] **Step 1: 追加行为锁定测试**（agent.test.ts，沿用该文件既有的 Agent 构造 fixture；若无现成 fixture，构造最小 `Agent` 实例仅测 `rebuildToolPool` 输出）

复用该文件既有模式（`agent.test.ts:141-148` 的 `createAgent` + `getInitializationResult` + 断言内部池）：

```ts
test("rebuildToolPool keeps core tools eager and defers the rest", async () => {
  const agent = createAgent({
    persistSession: false,
    tools: [tool("Bash"), tool("GuanlanSearch")],
    provider: new StaticProvider(),
    model: "host/model-a",
  })
  await agent.getInitializationResult()

  const toolPool = (agent as any).toolPool as ToolDefinition[]
  const deferredPool = (agent as any).deferredToolPool as ToolDefinition[]
  // 内置 core 工具仍在 eager 池
  expect(toolPool.map((t) => t.name)).toContain("Bash")
  // ToolSearch/ExecuteTool 在 deferred 非空时注入 eager 池
  expect(toolPool.map((t) => t.name)).toContain("ToolSearch")
  expect(toolPool.map((t) => t.name)).toContain("ExecuteTool")
  // core 工具绝不在 deferred 池；非 core 工具进 deferred
  expect(deferredPool.map((t) => t.name)).not.toContain("Bash")
  expect(deferredPool.map((t) => t.name)).toContain("GuanlanSearch")
})
```

- [ ] **Step 2: 跑测试**

Run: `bun test packages/sdk/src/agent.test.ts`
Expected: PASS（接线前的行为基线）

- [ ] **Step 3: 改写 rebuildToolPool**

`agent.ts` 新增字段（250 行附近）：

```ts
private toolRegistry = createToolRegistry()
```

`rebuildToolPool`（592-628 行）中，从 `assembleToolPool(...)` 得到 `runtimeTools` 之后、`splitDeferredTools` 调用处，替换为：

```ts
// Registry is the single source of truth: global pool + default preset core set.
this.toolRegistry.global.register(runtimeTools)
this.toolRegistry.preset("default").setCore([...CORE_TOOL_NAMES])
const { core, deferred } = this.toolRegistry.agent(this.sid).view().split()
```

后续 `enableToolSearch` / `generatedTools` / `this.toolPool` 赋值逻辑保持不变。`splitDeferredTools` 的 import 若因此未被使用则移除（`filterTools` 仍被 overrides 路径使用，保留）。头部导入 `createToolRegistry` 与 `CORE_TOOL_NAMES`。

注意：`register` 是累积式（Map 去重，nearest-wins 无影响因为只写 global 一层），重复 rebuild 幂等 —— 与现状 `rebuildToolPool` 全量重建语义一致。

- [ ] **Step 4: 全量回归**

Run: `bun test packages/sdk/src/agent.test.ts packages/sdk/src/engine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
rtk git add packages/sdk/src/agent.ts packages/sdk/src/agent.test.ts
rtk git commit -m "♻️ refactor(sdk): assemble tool pools through ToolRegistry in rebuildToolPool"
```

---

### Task 4: overrides 折算 agent 层掩码

**Files:**
- Modify: `packages/sdk/src/tools/registry.ts`（新增 `applyOverrides` 纯函数）
- Modify: `packages/sdk/src/agent.ts:928-942`（prompt() 内 overrides 过滤改为调 `applyOverrides`）
- Test: `packages/sdk/src/tools/registry.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 `ToolRegistry`
- Produces:
  ```ts
  export interface ToolOverrides {
    disallowedTools?: string[]
    tools?: string[] | ToolDefinition[]
  }
  export function applyOverrides(
    registry: ToolRegistry,
    agentId: string,
    overrides: ToolOverrides | undefined,
  ): { tools: ToolDefinition[]; deferredTools: ToolDefinition[]; undo: () => void }
  ```
  语义与现 `agent.ts:928-942` 逐条等价：
  - `disallowedTools` → deny 掩码，作用于 tools 与 deferredTools 两个池
  - `tools` 为字符串名单 → allow 掩码，且 `deferredTools` 恒为 `[]`
  - `tools` 为定义数组 → `tools` 恒为该数组本身（不进 registry），`deferredTools` 恒为 `[]`
  - 返回的 `undo()` 撤销本次掩码（掩码是一次性求值，用后即撤）
  - 已知微差：原实现字符串名单分支基于 `buildBaseToolPool(opts)`（不含 MCP/resolveRuntimeTools 结果），registry 版基于全局池全量求值 —— registry 版更正确（名单意图是"只许这些"，MCP 工具命中名单应可用）；若既有测试锁定旧行为，以测试暴露为准并在 PR 描述记录

- [ ] **Step 1: 追加失败测试**（registry.test.ts 末尾）

```ts
import { applyOverrides } from "./registry.js";

describe("applyOverrides", () => {
  function setup() {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("WebFetch"), tool("GuanlanSearch")]);
    registry.preset("default").setCore(["Bash"]);
    return registry;
  }

  test("disallowedTools masks both pools", () => {
    const registry = setup();
    const { tools, deferredTools, undo } = applyOverrides(registry, "a1", { disallowedTools: ["Web*"] });
    expect(tools.map((t) => t.name)).toContain("Bash");
    expect(tools.map((t) => t.name)).not.toContain("WebFetch");
    expect(deferredTools.map((t) => t.name)).not.toContain("WebFetch");
    undo();
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toContain("WebFetch");
  });

  test("string tool list becomes allow mask and clears deferred", () => {
    const registry = setup();
    const { tools, deferredTools } = applyOverrides(registry, "a1", { tools: ["Bash"] });
    expect(tools.map((t) => t.name)).toEqual(["Bash"]);
    expect(deferredTools).toEqual([]);
  });

  test("tool definition array replaces tools outright", () => {
    const registry = setup();
    const custom = tool("Custom");
    const { tools, deferredTools } = applyOverrides(registry, "a1", { tools: [custom] });
    expect(tools).toEqual([custom]);
    expect(deferredTools).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/sdk/src/tools/registry.test.ts`
Expected: FAIL — `applyOverrides` 未导出

- [ ] **Step 3: 实现 applyOverrides**（registry.ts 末尾追加）

```ts
export interface ToolOverrides {
  disallowedTools?: string[];
  tools?: string[] | ToolDefinition[];
}

/** Evaluate query-time overrides as agent-layer masks; `undo` restores the registry. */
export function applyOverrides(
  registry: ToolRegistry,
  agentId: string,
  overrides: ToolOverrides | undefined,
): { tools: ToolDefinition[]; deferredTools: ToolDefinition[]; undo: () => void } {
  if (!overrides) {
    const view = registry.agent(agentId).view();
    return { tools: view.visible(), deferredTools: view.split().deferred, undo: () => {} };
  }
  if (Array.isArray(overrides.tools) && overrides.tools.length > 0 && typeof overrides.tools[0] !== "string") {
    return { tools: overrides.tools, deferredTools: [], undo: () => {} };
  }
  const layer = registry.agent(agentId);
  const undos: Array<() => void> = [];
  if (overrides.disallowedTools) undos.push(layer.restrict({ deny: overrides.disallowedTools }));
  const explicitList = overrides.tools as string[] | undefined;
  if (explicitList) undos.push(layer.restrict({ allow: explicitList }));
  try {
    const view = layer.view();
    return {
      tools: view.visible(),
      deferredTools: explicitList ? [] : view.split().deferred,
      undo: () => { for (const undo of undos) undo(); },
    };
  } catch (error) {
    for (const undo of undos) undo();
    throw error;
  }
}
```

- [ ] **Step 4: agent.ts 接线**

`agent.ts:928-942` 的 overrides 过滤块替换为：

```ts
const { tools, deferredTools } = applyOverrides(this.toolRegistry, this.sid, overrides)
```

（`tools`/`deferredTools` 在原块中为 `let` 声明，此处直接改为 `const` 解构；一次性求值无需保留 undo。头部导入 `applyOverrides`；`filterTools` import 若无其他使用处则移除。）

- [ ] **Step 5: 全量回归 + typecheck**

Run: `bun test packages/sdk/src/agent.test.ts packages/sdk/src/tools/registry.test.ts && bunx tsc --noEmit -p packages/sdk`
Expected: PASS / 无错误

- [ ] **Step 6: 提交**

```bash
rtk git add packages/sdk/src/tools/registry.ts packages/sdk/src/tools/registry.test.ts packages/sdk/src/agent.ts
rtk git commit -m "♻️ refactor(sdk): express tool overrides as registry agent-layer masks"
```

---

## 完成标准

- registry.test.ts 全绿；`bun test packages/sdk` 全绿；`bunx tsc --noEmit -p packages/sdk` 无错
- `rebuildToolPool` 与 overrides 路径经 registry 求值，`splitDeferredTools`/`filterTools` 保留为适配器（标记 `@deprecated` JSDoc，不删除）
- PR 描述附 spec 路径；CI 对比 main baseline（平台性红测不算回归，见 memory `main-ci-platform-tests-red`）

## P2/P3 衔接（不在本计划内）

- P2：`RegistryView.split()` 的 core 集从静态声明升级为 token 预算驱动；engine `activatedTools` 挂到 agent 层
- P3：`tools.*` API 目录来自 `RegistryView.visible()`
