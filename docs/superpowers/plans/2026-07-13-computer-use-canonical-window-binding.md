# Computer Use Canonical Window Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Lume 的 MCP Computer Use 在一次运行期内复用 Desktop Host 返回的 canonical Window，避免模型把完整应用路径重新缩写后导致微信输入永远停在 preflight。

**Architecture:** `createComputerUseMcpTools` 内维护一个仅存在于当前工具实例的 `Map<number, Window>`。只有成功的 Window2 读取结果可以更新缓存；后续工具按请求中的窗口 ID 恢复缓存对象，再交给现有 preflight、ledger 和 Host。Desktop Host 仍对当前 HWND 执行严格 `id/app/title` 复核，缓存不承担授权或模糊匹配。

**Tech Stack:** TypeScript、Bun test、Lume Agent SDK ToolDefinition、现有 Desktop Host v3 JSON-RPC

---

### Task 1: 为 MCP 工具补足持久 canonical Window 绑定

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.ts:62-152,306-340,684-725`
- Test: `apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts:8-230`

- [ ] **Step 1: 写入真实微信会话的失败回归测试**

在测试文件顶部增加历史与 canonical 两种 Window：

```ts
const HISTORICAL_WECHAT = { id: 42, app: "Weixin.exe", title: "小树懒" };
const CANONICAL_WECHAT = {
  id: 42,
  app: "D:\\software\\Tencent\\Weixin\\Weixin.exe",
  title: "小树懒",
};
```

增加测试，先用历史 Window 观察，再让模型重复提交历史 Window；断言 preflight、实际 click 和隐藏 ledger 元数据全部使用 Host 返回的 canonical Window：

```ts
test("reuses the canonical Window returned by observation when the model repeats a legacy app", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const tools = createComputerUseMcpTools({
    threadId: "thread-canonical-window",
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === "get_window_state") {
        return { window: CANONICAL_WECHAT, accessibility: null, screenshots: [] };
      }
      return method === "desktop_context.preflight_action" ? {} : null;
    },
  });

  await toolByName(tools, "get_window_state").call(
    { window: HISTORICAL_WECHAT, include_screenshot: false },
    { toolUseId: "canonical-state" } as never,
  );
  const result = await toolByName(tools, "click").call(
    { window: HISTORICAL_WECHAT, x: 518, y: 833 },
    { toolUseId: "canonical-click" } as never,
  );

  expect(calls.slice(1)).toEqual([
    {
      method: "desktop_context.preflight_action",
      args: { action: "click", window: CANONICAL_WECHAT, x: 518, y: 833 },
    },
    { method: "click", args: { window: CANONICAL_WECHAT, x: 518, y: 833 } },
  ]);
  expect((result as any)._meta.computerUseAction.window).toEqual(CANONICAL_WECHAT);
});
```

增加表驱动测试，覆盖全部允许写入缓存的读取来源：

```ts
test("learns canonical windows from every successful Window2 read result", async () => {
  const readCases = [
    { name: "list_windows", args: {}, result: [CANONICAL_WECHAT] },
    {
      name: "list_apps",
      args: {},
      result: [{ id: CANONICAL_WECHAT.app, windows: [CANONICAL_WECHAT] }],
    },
    {
      name: "get_window",
      args: { id: 42, app: HISTORICAL_WECHAT.app },
      result: CANONICAL_WECHAT,
    },
    {
      name: "get_window_state",
      args: { window: HISTORICAL_WECHAT, include_screenshot: false },
      result: { window: CANONICAL_WECHAT, accessibility: null, screenshots: [] },
    },
  ] as const;

  for (const read of readCases) {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const tools = createComputerUseMcpTools({
      invoke: async (method, args) => {
        calls.push({ method, args });
        if (method === read.name) return read.result;
        return method === "desktop_context.preflight_action" ? {} : null;
      },
    });
    await toolByName(tools, read.name).call(read.args, { toolUseId: `read-${read.name}` } as never);
    await toolByName(tools, "click").call(
      { window: HISTORICAL_WECHAT, x: 10, y: 20 },
      { toolUseId: `click-${read.name}` } as never,
    );

    expect(calls.find((call) => call.method === "desktop_context.preflight_action")?.args.window)
      .toEqual(CANONICAL_WECHAT);
  }
});
```

增加 `get_window` 恢复测试：

```ts
test("rehydrates get_window with the cached canonical app", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const tools = createComputerUseMcpTools({
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === "get_window_state") {
        return { window: CANONICAL_WECHAT, accessibility: null, screenshots: [] };
      }
      if (method === "get_window") return CANONICAL_WECHAT;
      return null;
    },
  });
  await toolByName(tools, "get_window_state").call(
    { window: HISTORICAL_WECHAT, include_screenshot: false },
    { toolUseId: "state-before-rehydrate" } as never,
  );
  await toolByName(tools, "get_window").call(
    { id: 42, app: HISTORICAL_WECHAT.app },
    { toolUseId: "rehydrate-canonical" } as never,
  );

  expect(calls.at(-1)).toEqual({
    method: "get_window",
    args: { id: 42, app: CANONICAL_WECHAT.app },
  });
});
```

增加无可信读取的安全边界测试：

```ts
test("does not learn a canonical identity from model input alone", async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const tools = createComputerUseMcpTools({
    invoke: async (method, args) => {
      calls.push({ method, args });
      throw new Error("stale_target: use the latest state.window");
    },
  });
  await toolByName(tools, "click").call(
    { window: HISTORICAL_WECHAT, x: 10, y: 20 },
    { toolUseId: "uncached-click" } as never,
  );

  expect(calls).toEqual([{
    method: "desktop_context.preflight_action",
    args: { action: "click", window: HISTORICAL_WECHAT, x: 10, y: 20 },
  }]);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```text
bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts
```

Expected: 新测试失败，preflight/click/get_window 仍收到 `Weixin.exe`；原有测试继续通过。

- [ ] **Step 3: 实现最小运行期缓存与参数恢复**

在 `createComputerUseMcpTools` 中增加：

```ts
const latestCanonicalWindowById = new Map<number, ComputerUseWindow>();
```

所有工具调用先通过以下恢复函数；它只读取缓存，不从模型参数生成新身份：

```ts
function restoreCanonicalWindowArgs(
  name: ComputerUseToolName,
  args: Record<string, unknown>,
  windows: Map<number, ComputerUseWindow>,
): Record<string, unknown> {
  if (name === "get_window") {
    const id = Number.isInteger(args.id) ? args.id as number : undefined;
    const cached = id === undefined ? undefined : windows.get(id);
    return cached ? { ...args, app: cached.app } : args;
  }
  const requested = canonicalWindow(args.window);
  const cached = requested ? windows.get(requested.id) : undefined;
  return cached ? { ...args, window: cached } : args;
}
```

成功读取后用限定来源函数更新缓存：

```ts
function rememberCanonicalWindows(
  name: ComputerUseToolName,
  value: unknown,
  windows: Map<number, ComputerUseWindow>,
): void {
  const remember = (candidate: unknown) => {
    const window = canonicalWindow(candidate);
    if (window) windows.set(window.id, window);
  };
  if (name === "list_windows") {
    if (Array.isArray(value)) value.forEach(remember);
    return;
  }
  if (name === "list_apps") {
    if (Array.isArray(value)) {
      for (const candidate of value) {
        const app = asRecord(candidate);
        if (Array.isArray(app.windows)) app.windows.forEach(remember);
      }
    }
    return;
  }
  if (name === "get_window") {
    remember(value);
    return;
  }
  if (name === "get_window_state") remember(asRecord(value).window);
}
```

在 `call` 内把 `const args` 改成恢复后的参数。`get_window_state` 和其他只读工具在 `invoke` 成功后调用
`rememberCanonicalWindows`；动作工具直接使用恢复后的 `args` 进入现有 `dispatchAction`。不要修改 Host、
Window2 schema、Prompt 或 action ledger 类型。

- [ ] **Step 4: 运行定向测试并确认全部通过**

Run:

```text
bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts
```

Expected: 全部通过；真实会话模式的 click 使用完整路径，未建立缓存的 stale preflight 仍失败。

- [ ] **Step 5: 检查改动范围并提交**

Run:

```text
git diff --check -- apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.ts apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts
git status --short
```

只暂存上述两个文件，并使用 Lore 提交：

```text
git add -- apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.ts apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts
git commit -m "🐛 fix(sidecar): 保持 canonical Window 运行期绑定" -m "Constraint: 缓存只接受 Host 成功读取结果
Constraint: Host 继续严格复核当前窗口身份
Rejected: basename 模糊匹配 | 可能误操作复用 HWND
Tested: bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts"
```

### Task 2: 专项验证与桌面重建

**Files:**
- Verify only; do not stage unrelated working-tree changes.

- [ ] **Step 1: 运行 Sidecar Computer Use 相关测试**

Run:

```text
bun test apps/sidecar/src/services/desktop-context/desktop-host-client.test.ts apps/sidecar/src/services/desktop-context/desktop-host-runtime.test.ts apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts
```

Expected: 0 failures。

- [ ] **Step 2: 运行仓库 Computer Use 专项门禁**

Run:

```text
bun run verify:computer-use
```

Expected: `[computer-use] verification passed`。

- [ ] **Step 3: 重建桌面端资源与 Electron 产物**

Run:

```text
bun run build:desktop
```

Expected: Sidecar bundle、`lume_desktop_host.exe` 和 Electron packaging 均以 code 0 完成。

- [ ] **Step 4: 审计工作区**

Run:

```text
git status --short
git diff --check
git log -3 --oneline
```

Expected: 本次两个运行时文件无未提交改动；用户原有 `.npmrc`、`bun.lock` 及其他未提交文件保持原状。
