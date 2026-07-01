# Lume Desktop `node_repl` 设计

- **日期**：2026-07-01
- **状态**：已通过 brainstorming，待实现规划
- **范围**：为 Lume Desktop 设计一个类似 Codex 的内建 `node_repl`，默认向模型暴露 `js` / `js_reset` / `js_add_node_module_dir`，复用 Electron 自带 Node/V8，并通过 Lume 现有 Desktop + sidecar 架构原生接入。

## 1. 背景与目标

Lume 当前已有完整的 Desktop + sidecar + SDK 工具链：

- `apps/desktop` 负责 Electron 打包、`extraResources`、以及 sidecar utility process 启动。
- `apps/sidecar` 负责 agent runtime、工具注册、权限/日志/会话生命周期。
- `packages/sdk` 负责工具执行循环、tool result 进消息、provider 适配。

这次目标不是单独交付一个外部 runtime 包，而是让 **Lume Desktop 自身**具备与 Codex 接近的 `node_repl` 能力。已有的 clean-room 方案和本地 Codex `cua_node` 目录表明，真正的难点不在“能执行 JS”，而在：

- 会话级持久 top-level binding；
- 顶层 `await` / 动态 `import()`；
- `js_reset` 语义；
- `js_add_node_module_dir` 语义；
- 可杀死的超时/崩溃边界；
- `nodeRepl.requestMeta` / `setResponseMeta()` / `emitImage()`；
- 结构化 tool result 回传，而不是简单字符串。

本设计选择的路线是：**保留 Codex 风格的 Rust host + Electron run-as-node kernel 主线，但把工具注册、打包、生命周期和结果回传全部并入 Lume 现有体系。**

## 2. 范围

### 本期包含

- Lume Desktop 默认内建 `js` / `js_reset` / `js_add_node_module_dir` 三个工具。
- 运行时使用 Electron 自带 Node/V8；不额外打包独立 `node.exe` 作为执行内核。
- 保留独立 Rust host，负责协议、超时、reset、stderr/退出码、进程监管。
- sidecar 内部新增 thread-scoped runtime registry，按线程维持持久 JS 会话。
- 首版对齐 Codex 风格基础 bridge：
  - `nodeRepl.cwd`
  - `nodeRepl.homeDir`
  - `nodeRepl.tmpDir`
  - `nodeRepl.requestMeta`
  - `nodeRepl.setResponseMeta(...)`
  - `await nodeRepl.emitImage(...)`
- `js` 返回结构化结果：文本块、图片块、顶层 `_meta`、错误态。

### 非目标（YAGNI）

- 暴露 `node` / `npm` / `npx` 等额外工具名。
- 首版对齐全部 trusted/privileged bridge（如 `config`、`fetch`、`nativePipe`、`computer`）。
- 通过“内部 MCP server 再回 sidecar”方式接入基础工具。
- CLI / Web / SDK 独立运行时的统一交付。本期只保证 Desktop 内建路径。
- 将不受信任 agent JS 直接放进 Electron main 或 renderer 执行。

## 3. 设计决策总表

| 维度 | 决定 |
|---|---|
| 接入路线 | `B. Lume 原生集成` |
| Node 来源 | Electron 自带 Node/V8 |
| 执行边界 | Rust host + Electron run-as-node kernel |
| 工具面 | `js` / `js_reset` / `js_add_node_module_dir` |
| 默认策略 | 默认开启，进入基础工具池 |
| 会话隔离 | 按 sidecar 当前线程 `sessionId` 独立 runtime |
| `js_reset` 语义 | 清空持久 binding，保留已添加 module dirs |
| `js_add_node_module_dir` 语义 | 仅允许绝对 `node_modules` 目录；首次 `true`，重复 `false` |
| 图片返回 | `emitImage()` 直接回传 image block |
| result `_meta` | `setResponseMeta()` 结果保留在当前 tool result 顶层 |
| 故障恢复 | timeout / child exit / 协议断裂后销毁当前 runtime，下次冷启动 |

## 4. 目标架构

```text
Model Tool Call
   │
   ▼
Sidecar built-in js tools
   │
   ├─ thread-scoped runtime registry
   ├─ permission/logging/tool result bridge
   ▼
Rust node_repl host
   │ stdin/stdout JSONL
   ▼
Electron executable (run-as-node)
   │
   ▼
Kernel process
   │
   ▼
Worker + vm.SourceTextModule cell runtime
```

关键点：

- **Desktop main 不执行 agent JS。** 它只负责资源定位、打包、环境注入、sidecar 启动。
- **Sidecar 是工具接入面。** `node_repl` 在 Lume 中表现为一组内建 tool definition，而不是第二套独立工具系统。
- **Rust host 是执行隔离面。** 超时、崩溃、协议异常时，sidecar 可以把当前 runtime 当作一次性资源整体丢弃。
- **Kernel 是语义兼容面。** 持久 binding、顶层 `await`、动态模块加载、`requestMeta`、`emitImage` 等都在这里实现。

## 5. 归属与职责边界

### 5.1 Desktop main

负责：

- 把 `node-repl/` 资源目录打入 `extraResources`。
- 在启动 sidecar 时，把 `node-repl` 资源路径、host 二进制路径、必要 env 注入 sidecar。
- 在开发态和打包态之间统一解析运行时资源路径。

不负责：

- 不直接执行任何 agent JS。
- 不直接向 renderer 暴露 runtime 句柄。
- 不在 desktop main 里实现 `js` 三个工具。

### 5.2 Sidecar

负责：

- 注册 `js` / `js_reset` / `js_add_node_module_dir` 到基础工具池。
- 以线程为粒度维护 runtime registry。
- 将调用级 `_meta` 与线程基础 metadata 组装后传给 host。
- 将 host 返回的结构化结果桥接回 SDK / provider。
- 在 timeout / crash / thread end 时回收 runtime。

### 5.3 Rust host

负责：

- 固定启动 Electron 可执行文件与指定 kernel 路径。
- 执行 JSONL 协议、握手、请求排队、超时处理。
- 维持 `reset()` / `shutdown()` / `cancel` 的进程级语义。
- 将 kernel stderr、退出码、协议错误转换成 sidecar 可判定的失败。

### 5.4 Kernel / worker runtime

负责：

- `vm.SourceTextModule` cell 执行模型。
- 顶层 binding 持久化与 `@prev` 语义。
- 动态 `import()` 与 module dir 搜索。
- `nodeRepl.*` 基础 bridge。
- `emitImage()` / `setResponseMeta()` 的结构化输出。

## 6. 线程会话模型与工具契约

### 6.1 线程级 runtime registry

runtime registry 以 sidecar 当前线程的 `sessionId` 为 key。

- 主线程与 subagent 线程各自拥有独立 runtime。
- 不共享 JS 顶层 binding。
- subagent 完成后立即回收自己的 runtime。

这样有三个好处：

- `js` 状态天然跟线程一致；
- `js_reset` 只影响当前线程；
- 不需要在多线程之间发明共享状态或锁协议。

### 6.2 `js`

输入契约：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `title` | string | 否 | 用户可见短标题 |
| `code` | string | 是 | 非空 JavaScript 源码 |
| `timeout_ms` | integer | 否 | 默认 `30000` |

运行时暴露：

- `nodeRepl.cwd`
- `nodeRepl.homeDir`
- `nodeRepl.tmpDir`
- `nodeRepl.requestMeta`
- `nodeRepl.setResponseMeta(meta)`
- `await nodeRepl.emitImage(...)`

行为约束：

- 顶层 binding 在后续 `js` 调用中持续存在，直到 `js_reset`。
- 不鼓励重复声明已有 `const` / `let`。
- 允许用顶层 `var` 复用可变状态。
- 支持顶层 `await`。
- 支持 `await import("pkg")`。

### 6.3 `js_reset`

语义：

- 清空持久 Cell binding。
- 保留通过 `js_add_node_module_dir` 添加的 module dirs。
- 当前 runtime 不存在时也应幂等成功。

实现上允许两种等价路径：

- host 提供显式 reset；
- 或 sidecar 直接销毁并重建当前线程 runtime。

对上层语义来说，两者都表现为“当前 JS 状态被清空，但 module dirs 仍在”。

### 6.4 `js_add_node_module_dir`

输入：

```ts
{ path: string }
```

约束：

- `path` 必须是绝对路径。
- `path` 必须指向 `node_modules` 目录。
- 首次添加返回 `true`。
- 重复添加返回 `false`。

额外决定：

- 允许先于第一次 `js` 调用发生。
- 如果 runtime 尚未启动，sidecar 先把路径记入 pending module dirs，首次启动 runtime 时一并注入。

## 7. Request Metadata 与结构化结果

### 7.1 `requestMeta`

每次 `js` 执行都接收两层 metadata：

- **基础 metadata**：线程/运行时级上下文提供；
- **调用级 `_meta`**：来自当前 `js` 调用输入。

合并规则：

- 浅合并；
- 调用级 `_meta` 覆盖基础 metadata 同名字段；
- 执行期通过深冻结的 `nodeRepl.requestMeta` 只读暴露。

### 7.2 `setResponseMeta()`

`nodeRepl.setResponseMeta(meta)` 的结果必须挂在**当前 tool result 顶层 `_meta`**。

这不是可选增强，而是 Codex 风格契约的一部分。Lume 首版必须保留这条通路，不能在 sidecar / SDK / provider 层丢弃。

### 7.3 `emitImage()`

`nodeRepl.emitImage()` 的结果不写成临时文件路径字符串，不回退成 base64 文本，而是直接转成 tool result image block 回传。

这是为了：

- 最接近 Codex 模型看到的语义；
- 避免线程文件系统路径污染；
- 让 provider 层统一处理文本块与图片块。

### 7.4 当前 Lume 的显式兼容缺口

当前 `packages/sdk` 存在一个明确的结构性不匹配：

- `defineTool()` 默认把 `{ data }` 序列化为字符串；
- `engine` 默认把 tool result 当字符串或 JSON 字符串塞回消息；
- provider adapter 读取 tool result 时也默认按字符串处理。

因此本设计要求在实现阶段新增一个**结构化 tool result 通道**，允许内部结果携带：

- `content` blocks（text / image）
- 顶层 `_meta`
- `is_error`

原则是：**不要在 runtime 入口过早 stringify。**

## 8. 正常调用流与恢复流

### 8.1 正常调用流

```text
Model selects js
  → Sidecar js tool
  → lookup/create runtime by thread id
  → Rust host execute(code, requestMeta, timeout)
  → Electron kernel execute
  → structured result(text/image/_meta)
  → Sidecar / SDK / provider bridge
  → Model receives tool result
```

步骤展开：

1. 模型选择 `js`。
2. sidecar 的内建工具定义收到 `title/code/timeout_ms/_meta`。
3. sidecar 通过线程 id 查 runtime registry；若不存在则惰性启动 host/kernel。
4. host 把代码与 request metadata 送给 kernel。
5. kernel 执行并产生文本、图片、`_meta` 或错误。
6. sidecar 把结构化结果透传给 SDK / provider。
7. provider 只在需要时做 provider-specific 适配，不提前丢信息。

### 8.2 超时

单次执行超时后：

- 本次 `js` 返回 tool error；
- 当前 runtime 视为污染态；
- sidecar 立即销毁当前 host/kernel；
- 下一次 `js` 冷启动新 runtime。

不尝试在超时后继续复用同一 runtime。

### 8.3 child exit / 协议错误

只要出现以下任一情况：

- host 非零退出；
- 握手失败；
- JSONL 协议断裂；
- kernel 提前退出；

sidecar 就清理 registry entry，把当前 runtime 视为已失效。之后的下一次 `js` 自动重建，而不是尝试修补半死状态。

### 8.4 线程结束

线程关闭、归档、sidecar 退出、或 subagent 生命周期结束时，显式执行 runtime shutdown，避免悬挂 child process。

## 9. 打包与资源布局

### 9.1 Desktop 打包职责

`apps/desktop` 负责将 `node-repl/` 作为新的 `extraResources` 目录打包进应用。

目标布局：

```text
resources/
├── web/
├── sidecar/
├── natives/
└── node-repl/
    ├── manifest.json
    ├── runtime/
    ├── bin/
    │   └── node_repl[.exe]
    └── ...
```

### 9.2 路径解析

- 开发态：从工作区构建输出路径读取。
- 打包态：从 `process.resourcesPath/node-repl` 读取。

Desktop main 在启动 sidecar 时把以下信息注入 env：

- runtime 根目录
- Rust host 二进制路径
- manifest 路径
- 必要的兼容/诊断开关

### 9.3 `RunAsNode` 前置条件

本方案依赖 Electron run-as-node 能力。

当前 Lume 代码库中没有显式 Electron fuse 配置，因此实现阶段必须把下面这条当成**必须验证的前置条件**：

- 当前构建链与发布产物中，Electron `RunAsNode` 能力仍可用。

如果未来引入 `@electron/fuses`，则必须显式保留 `RunAsNode`。

## 10. 首版兼容边界

首版只承诺：

- `js`
- `js_reset`
- `js_add_node_module_dir`
- `cwd/homeDir/tmpDir/requestMeta/setResponseMeta/emitImage`

首版不承诺：

- `nodeRepl.config`
- `nodeRepl.fetch`
- `nodeRepl.nativePipe`
- `nodeRepl.computer`
- 其它 trusted-only bridge

设计上保留 host request 通道，但默认只把 `emitImage` 当成必须交付能力。这样可以把“Codex 风格 `node_repl` 基础兼容”与“Lume 特权桥接扩展”拆成两个迭代。

## 11. 预期实现落点

实现阶段预计会触及这些区域：

- `apps/desktop/package.json`
  - 新增 `extraResources.node-repl`
- `apps/desktop/src/main.ts`
  - sidecar 启动环境注入 node-repl 资源路径
- `apps/sidecar/src/services/agent-runtime/tools/`
  - 新增 `node-repl` 工具定义与 runtime manager
- `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
  - 将 `js` 三工具加入基础工具分组
- `packages/sdk/src/types.ts`
  - 扩展 tool result 结构以容纳结构化内容 / `_meta`
- `packages/sdk/src/tools/types.ts`
  - 避免 helper 过早 stringify
- `packages/sdk/src/engine.ts`
  - 保留结构化 tool result 进入消息流
- `packages/sdk/src/providers/*`
  - 让 provider adapter 兼容结构化 tool result

## 12. 验证策略

### 12.1 Sidecar 单测

验证：

- thread-scoped runtime registry；
- `js_reset` 保留 module dirs；
- 重复 `js_add_node_module_dir` 返回 `false`；
- timeout 后 runtime 淘汰；
- child exit 后下次 `js` 冷启动。

### 12.2 Desktop / packaging 集成验证

验证：

- 开发态与打包态都能解析 node-repl 资源路径；
- desktop 能把路径正确注入 sidecar；
- 发布产物内 `RunAsNode` 可用。

### 12.3 端到端契约验证

至少覆盖：

- `var` / `let` / `const` 持久化；
- 顶层 `await`；
- 动态 `import()`；
- `js_reset` 清空 binding 但保留 module dirs；
- `emitImage` 结构化返回；
- `setResponseMeta()` 顶层 `_meta`；
- host / kernel 崩溃后下一次 `js` 自动恢复。

## 13. 风险与实现注意点

- **结构化结果改造范围不小。** 不是只改一个工具，而是会穿过 SDK `ToolResult`、engine、provider adapter。
- **默认开启意味着回滚路径必须明确。** 一旦上线后发现兼容问题，应允许通过实现时的内部配置快速停用 `js` 三工具。
- **Electron run-as-node 是真实前置条件。** 必须在 Desktop 打包层显式验证，而不是靠假设。
- **Subagent 生命周期需要单独回收。** 否则容易残留 host/kernel 子进程。
- **不要把 privileged bridge 范围带大。** 首版若同时做 `config/fetch/computer`，复杂度会显著上升。

## 14. 本轮已确认的产品决策

本设计基于本轮 brainstorming 已明确确认的决策：

- 这是 **Lume Desktop 内建能力**，不是独立可选 runtime 包。
- 首版使用 **Electron 自带 Node/V8**，不再携带第二份独立 Node。
- 首版工具面只暴露 **`js` / `js_reset` / `js_add_node_module_dir`**。
- 兼容目标为 **高兼容 Codex 风格语义**，不是最小 JS 执行器。
- 首版 **保留 Rust host**。
- 首版 **默认开启**，进入基础工具池。

这些决策在进入实现规划前不再重开，除非产品目标发生变化。
