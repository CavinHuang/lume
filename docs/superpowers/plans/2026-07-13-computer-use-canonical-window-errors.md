# Computer Use Canonical Window Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax (- [ ]) for tracking.

**Goal:** 让 stale canonical Window 产生准确、可恢复的 Tool Error，并在确认或 OS 输入前停止，同时拒绝歧义 click 目标。

**Architecture:** Desktop Host client 用专用错误类型区分 JSON-RPC 业务错误与连接错误；Desktop Host runtime 只把连接错误转换成 unavailable。Computer Use 工具让 preflight 错误直达调用方、记录失败账本并在公共动作返回非 null 对象时保留明确 message。Host 继续严格比较 Window 身份，但 stale 错误包含采用最新 state.window 的恢复指引。

**Tech Stack:** TypeScript、Bun test、Rust、serde_json、现有 Desktop Host JSON-RPC 与 Computer Use action ledger。

---

## File map

- apps/sidecar/src/services/desktop-context/desktop-host-client.ts：产生可判别的 Host JSON-RPC 请求错误。
- apps/sidecar/src/services/desktop-context/desktop-host-runtime.ts：只转换连接错误。
- apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.ts：处理 preflight、动作返回值与 click 互斥目标。
- crates/lume-desktop-host/src/computer_use_adapter.rs：返回带恢复指引的 stale Window 错误。
- 同目录测试文件分别覆盖各层契约。

### Task 1: 保留 Host JSON-RPC 业务错误

**Files:**
- Modify: apps/sidecar/src/services/desktop-context/desktop-host-client.test.ts
- Modify: apps/sidecar/src/services/desktop-context/desktop-host-client.ts
- Modify: apps/sidecar/src/services/desktop-context/desktop-host-runtime.test.ts
- Modify: apps/sidecar/src/services/desktop-context/desktop-host-runtime.ts

- [ ] **Step 1: 为 Host error frame 编写失败测试**

~~~ts
test("classifies host JSON-RPC errors separately from connection failures", async () => {
  const connection = new FakeConnection();
  const client = new DesktopHostRpcClient({
    token: "token",
    connect: async () => connection,
    timeoutMs: 100,
  });
  const start = client.start();
  await Promise.resolve();
  connection.receive({ id: 1, result: { status: "ok", protocolVersion: 3 } });
  await start;

  const call = client.call("click", {});
  await Promise.resolve();
  connection.receive({
    id: 2,
    error: { code: -32000, message: "stale_target: use the latest state.window" },
  });
  const error = await call.catch((value) => value);

  expect(error).toBeInstanceOf(DesktopHostRequestError);
  expect(error).toMatchObject({
    code: -32000,
    message: "stale_target: use the latest state.window",
  });
});
~~~

- [ ] **Step 2: 运行 client 测试并确认 RED**

Run: bun test apps/sidecar/src/services/desktop-context/desktop-host-client.test.ts

Expected: FAIL，因为错误类型尚不存在或 error frame 仍产生普通 Error。

- [ ] **Step 3: 实现最小错误类型**

~~~ts
export class DesktopHostRequestError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "DesktopHostRequestError";
  }
}
~~~

处理 message.error 时改为：

~~~ts
pending.reject(new DesktopHostRequestError(
  typeof error.message === "string" ? error.message : "desktop host request failed",
  typeof error.code === "number" ? error.code : undefined,
));
~~~

- [ ] **Step 4: 运行 client 测试并确认 GREEN**

Run: bun test apps/sidecar/src/services/desktop-context/desktop-host-client.test.ts

Expected: PASS。

- [ ] **Step 5: 为 runtime 业务错误传播编写失败测试**

~~~ts
test("preserves authenticated host request errors", async () => {
  const invoke = createDesktopHostInvoker({
    env: {
      LUME_DESKTOP_HOST_ENDPOINT: "endpoint",
      LUME_DESKTOP_HOST_TOKEN: "token",
    },
    createClient: () => ({
      call: async () => {
        throw new DesktopHostRequestError(
          "stale_target: use the latest state.window",
          -32000,
        );
      },
    }),
  });

  await expect(invoke("click", {})).rejects.toMatchObject({
    code: -32000,
    message: "stale_target: use the latest state.window",
  });
});
~~~

- [ ] **Step 6: 运行 runtime 测试并确认 RED**

Run: bun test apps/sidecar/src/services/desktop-context/desktop-host-runtime.test.ts

Expected: FAIL，因为 runtime 当前返回 unavailable 对象。

- [ ] **Step 7: 仅重抛 Host 请求错误**

runtime 导入错误类型，并在 catch 最前面增加：

~~~ts
if (error instanceof DesktopHostRequestError) throw error;
~~~

保留现有未配置 Host、连接断开和权限诊断 unavailable 行为。

- [ ] **Step 8: 运行两组测试并确认 GREEN**

Run: bun test apps/sidecar/src/services/desktop-context/desktop-host-client.test.ts apps/sidecar/src/services/desktop-context/desktop-host-runtime.test.ts

Expected: PASS，包括既有 connection failure 测试。

- [ ] **Step 9: 按 Lore 协议提交**

提交标题：🐛 fix(sidecar): 保留 Desktop Host 业务错误

Body 记录连接错误仍返回 unavailable、Host JSON-RPC error 原样抛出，以及定向 Bun 测试命令。

### Task 2: preflight 失败闭合与 click 目标互斥

**Files:**
- Modify: apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts
- Modify: apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.ts

- [ ] **Step 1: 编写 stale preflight 回归测试**

用临时 LUME_CONFIG_DIR 创建工具，令 private preflight 抛出
stale_target: use the latest state.window。断言：

~~~ts
expect((result as any).is_error).toBeTrue();
expect(jsonResult(result).error).toBe(
  "stale_target: use the latest state.window",
);
expect(calls).toEqual(["desktop_context.preflight_action"]);
expect(requests).toEqual([]);
~~~

读取 agent-workspaces/demo/threads/thread-stale/files/computer-use/action-ledger.jsonl，
断言 phase 顺序为 ["planned", "failed"]，最后的 failureReason 保留原始错误。
finally 恢复环境变量并删除临时目录。

- [ ] **Step 2: 编写非 null 动作 message 保留测试**

~~~ts
const tools = createComputerUseMcpTools({
  threadId: "thread-host-error",
  invoke: async (method) => method === "desktop_context.preflight_action"
    ? {}
    : {
        status: "stale_target",
        message: "stale_target: use the latest state.window",
      },
});
~~~

调用 click 后断言 Tool Error 等于明确 message，而不是 null contract 文案。

- [ ] **Step 3: 编写 click schema/runtime 互斥测试**

~~~ts
expect(click.oneOf).toEqual([
  {
    required: ["element_index"],
    not: { anyOf: [{ required: ["x"] }, { required: ["y"] }] },
  },
  {
    required: ["x", "y"],
    not: { required: ["element_index"] },
  },
]);
expect(click.anyOf).toBeUndefined();
~~~

运行时调用同时传 element_index 与 x/y，断言在 preflight 前返回
click requires exactly one target: element_index or x/y，且 Host calls 为空。

- [ ] **Step 4: 运行工具测试并确认 RED**

Run: bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts

Expected: stale preflight 被吞、Host message 被覆盖、click 仍为 anyOf，因此失败。

- [ ] **Step 5: 在工具入口校验 click**

~~~ts
if (name === "click") validateClickTarget(args);

function validateClickTarget(args: Record<string, unknown>): void {
  const hasElement = args.element_index !== undefined;
  const hasX = args.x !== undefined;
  const hasY = args.y !== undefined;
  if (hasX !== hasY || hasElement === (hasX && hasY)) {
    throw new Error(
      "click requires exactly one target: element_index or x/y",
    );
  }
}
~~~

- [ ] **Step 6: 将 click schema 改为 oneOf**

object helper 输出 oneOf；pointTarget 传入：

~~~ts
[
  {
    required: ["element_index"],
    not: { anyOf: [{ required: ["x"] }, { required: ["y"] }] },
  },
  {
    required: ["x", "y"],
    not: { required: ["element_index"] },
  },
]
~~~

不改变其他工具 schema。

- [ ] **Step 7: 传播 preflight 错误并记录 ledger**

删除 preflightAction 的 catch。dispatchAction 捕获 preflight 错误时：

~~~ts
const message = error instanceof Error ? error.message : String(error);
const failed = input.ledger.plan({
  action: input.action,
  window: window ?? {
    id: 0,
    app: stringValue(input.args.app) ?? "unknown",
  },
  screenshotId: stringValue(input.args.screenshotId),
  point: pointFromArgs(input.args),
  text: input.action === "type_text"
    ? rawString(input.args.text)
    : input.action === "set_value"
      ? rawString(input.args.value)
      : undefined,
  sensitive: false,
});
input.ledger.fail(failed.actionId, message);
throw error;
~~~

该路径发生在确认和实际动作前。

- [ ] **Step 8: 对非 null 动作结果保留 message**

~~~ts
if (result !== null) {
  const returned = asRecord(result);
  throw new Error(
    stringValue(returned.message)
      ?? "Computer Use v3 input methods must return null",
  );
}
~~~

- [ ] **Step 9: 运行工具测试并确认 GREEN**

Run: bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts

Expected: PASS，既有确认、视觉输入和 ledger 测试保持通过。

- [ ] **Step 10: 按 Lore 协议提交**

提交标题：🐛 fix(sidecar): 阻止 stale Window 输入分派

Body 记录 preflight fail closed、click 目标互斥和显式 Host message 优先。

### Task 3: 为 stale canonical Window 提供恢复指引

**Files:**
- Modify: crates/lume-desktop-host/tests/computer_use_adapter.rs
- Modify: crates/lume-desktop-host/src/computer_use_adapter.rs

- [ ] **Step 1: 编写旧 Window 身份回归测试**

观察时传入：

~~~rust
let stale = json!({
    "id": 42,
    "app": "Weixin.exe",
    "title": "小树懒"
});
~~~

断言 get_window_state 返回完整路径的 window。随后 private preflight 必须报：

~~~text
stale_target: window identity changed before action preflight; use the latest state.window
~~~

再写 dispatch 测试：旧 Window 报同类 dispatch 错误；使用观察返回的 state.window
调用 click 返回 JSON null。

- [ ] **Step 2: 运行 adapter 测试并确认 RED**

Run: cargo test --locked --manifest-path crates/lume-desktop-host/Cargo.toml --test computer_use_adapter

Expected: FAIL，现有错误没有 stale_target 和恢复指引。

- [ ] **Step 3: 实现统一 stale identity 错误**

~~~rust
fn stale_window_identity(stage: &str) -> anyhow::Error {
    anyhow!(
        "stale_target: window identity changed before {stage}; use the latest state.window"
    )
}
~~~

get_window、private preflight、dispatch 分别传入 rehydration、action preflight、dispatch。
不改变 window_matches 的严格 id/app/title 比较。

- [ ] **Step 4: 运行 adapter 测试并确认 GREEN**

Run: cargo test --locked --manifest-path crates/lume-desktop-host/Cargo.toml --test computer_use_adapter

Expected: PASS。

- [ ] **Step 5: 按 Lore 协议提交**

提交标题：🐛 fix(desktop-host): 明确 stale Window 恢复方式

Body 记录保持严格 app/title 校验、不做自动重写，以及 Rust 测试命令。

### Task 4: 定向验证、资源重建与审计

**Files:**
- Verify only; build may regenerate ignored desktop resources.

- [ ] **Step 1: 运行 Sidecar 相关测试**

~~~text
bun test apps/sidecar/src/services/desktop-context/desktop-host-client.test.ts apps/sidecar/src/services/desktop-context/desktop-host-runtime.test.ts apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts
~~~

Expected: PASS。

- [ ] **Step 2: 运行 Host contract 测试**

Run: cargo test --locked --manifest-path crates/lume-desktop-host/Cargo.toml --test computer_use_adapter

Expected: PASS。

- [ ] **Step 3: 运行 Computer Use 定向验证**

Run: bun run verify:computer-use

Expected: portable、Windows Host 和真实 Windows fixture 全部通过。

- [ ] **Step 4: 重建桌面端**

Run: bun run build:desktop

Expected: exit 0，更新 Sidecar bundle 与 Host executable 到 desktop resources 和 unpacked build。

- [ ] **Step 5: 审计工作区**

~~~text
git status --short
git diff --check
git log -6 --oneline
~~~

Expected: .npmrc、bun.lock 仍是用户原有未暂存改动；没有其他未提交源代码；修复提交符合 Lore 协议。

- [ ] **Step 6: 记录剩余风险**

若 Lume 和微信未运行，不声称真实发送验收完成。最终报告区分自动化 contract、资源重建和真实微信草稿/发送验证。
