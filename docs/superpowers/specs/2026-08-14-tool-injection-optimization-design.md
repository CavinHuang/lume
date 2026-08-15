# 工具注入优化设计（对标 deepseek-harness）

- 日期：2026-08-14
- 状态：待评审
- 范围：`packages/sdk`（registry、tool-search、engine）、`apps/sidecar`（node-repl 工具）

## 背景与对标结论

对标 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的工具加载策略：

| 维度 | dsh | Lume 现状 |
|---|---|---|
| 全量注入 | 每步 assemble，全量可见集合 | `toolPool`（core 集）全量注入 |
| 按需加载 | 无 | 已有 `ToolSearch` + `ExecuteTool` 代理调用（默认 tst 常开） |
| core/deferred 划分 | — | 静态 `CORE_TOOL_NAMES` 白名单 |
| 作用域裁剪 | `restrict()` 掩码 + scoped 注册 + parent chain | 静态 `disallowedTools` pattern 过滤 |
| Code Mode | `run_code` 单 transport + SDK 文本进 system prompt | 无（但 node REPL 已有 MCP 桥） |
| 装配时机 | 每步重新 assemble | pull 式 `rebuildToolPool` |

Lume 已有按需加载（比 dsh 激进），真正可借鉴的差异点是：**分层注册表的作用域语义**、**搜到即转正的原生调用语义**、**Code Mode 的工具目录进代码运行时**。

## 目标

解决四个痛点：工具可见性管理散乱（subagent/plan-mode/skill 各自为政）、多步任务效率低（逐个 tool-call）、上下文/token 压力（MCP 工具 schema 膨胀）、前瞻性架构补课。

## 非目标

- 不引入每步重装配（engine 每步循环不动，保 prompt cache）
- 不做 Python code runtime（只 TS，复用现有 node REPL）
- 不做 code-only 呈现模式（只 both：native + js 并存）
- 可见性裁剪不承担权限职责（权限仍在 permission/hooks 管道）—— 继承 dsh 的"非安全边界"原则

## 分期

```
P1 分层注册表（地基）→ P2 按需加载改进 → P3 Code Mode
P1 合并后 P2/P3 可并行（P3 依赖 P1，不依赖 P2）
```

---

## P1：分层 ToolRegistry

### 形态

**静态装配 + 分层注册表**：拿 dsh 的注册语义（注册即声明归属、层继承、掩码交集），不拿每步重装配。求值时机保持现状（MCP 连接、配置变更、agent 创建时的 `rebuildToolPool`）。

### 结构

```
ToolRegistry
├─ global 层      ← 内置工具 + MCP 工具（rebuildToolPool 时机写入）
├─ preset 层      ← agent 预设的工具面声明（core 集 + 掩码）
└─ agent 层       ← 每个 agent 实例的 overlay
                    视图向下继承，同名 nearest-wins，掩码取交集
        ↓ resolve(scope) 装配时机求值
ToolAssembly { core, deferred }
        ↓
现有 QueryEngine（每步循环零改动）
```

### API

```ts
// packages/sdk/src/tools/registry.ts
interface ToolRegistry {
  global: LayerHandle               // register(tools) / unregister
  preset(key: string): LayerHandle  // core 集声明 + restrict 掩码
  agent(id: AgentId): RegistryView  // 只读视图 + 实例级 restrict/注册
}
interface RegistryView {
  visible(): ToolDefinition[]  // 沿链合并 + shadow + 掩码交集
  split(): { core: ToolDefinition[], deferred: ToolDefinition[] }
}
```

### 现有概念归一

| 现状 | 去处 |
|---|---|
| `CORE_TOOL_NAMES` 静态白名单 | preset 层 core 声明，per-preset 可覆盖 |
| `disallowedTools` pattern | agent/preset 层 restrict 掩码 |
| `requiredDuringSkillScope`（per-tool metadata） | skill profile 掩码 |
| subagent `overrides.tools` | agent 层注册 |

注：`allowedInPlanMode` 是**权限**维度（sidecar permission-engine 在 plan 模式下判定执行放行），不是可见性维度 —— 归权限域，P1 不动。

### 兼容

`rebuildToolPool` 内部改为写 registry 再 resolve，对外行为不变；`filterTools`/`splitDeferredTools` 保留为折算适配器，标记 deprecated 不删除。

---

## P2：按需加载——搜到即转正

### 语义

ToolSearch 命中的工具**下一步起加入原生 tools 数组**，模型直接调用（参数校验、权限、hooks 走原工具定义）。`ExecuteTool` 退役为兼容期兜底。

### 改动

- `QueryEngine` 持有 `activatedTools: Set<string>`，每步请求 `tools = core + activated`（有序追加）
- `ToolSearch.call()` 命中后经新回调 `context.activateTools(names)` 写入集合
- 已转正工具从 ToolSearch 后续结果中排除

### prompt cache 取舍（明确接受）

tools 数组位于请求前缀，变化即破坏断点之后的缓存（system + messages）。缓解：

- **批量转正**：一次 ToolSearch 命中的多个工具同一步转正（一次 cache miss 换一批）
- 上线后测量命中率，劣化明显再加节流（每 N 步合并，模型无感知）
- `standard` 模式（全量注入）保留为 cache 敏感场景退路

### 划分动态化

`tst-auto` 的 token 预算判断并入 registry `split()`：工具总 schema 超 context window 阈值百分比时，非必要工具自动降级为 deferred，摆脱人工维护白名单。

---

## P3：Code Mode——工具目录进 js REPL

### 核心

node REPL 已有 MCP 桥（`mcp__<server>__<tool>`，`create-node-repl-tools.ts`）。P3 将该桥**从 MCP-only 泛化到全 registry 目录**，不是从零建 code mode。

### 改动面

1. **`tools.*` API 注入 REPL**：registry `visible()` 目录注入 REPL 沙箱，暴露 `await tools.name(args)`；嵌套执行走 runtime registry exec 通道；权限审批复用现有 broker 模式（`emitBrowserAuthRequest` 同款）
2. **SDK 文本生成**：从工具目录生成 TypeScript 声明（name + description + 参数类型）并入 `js` 工具 instructions，对齐 dsh 的 `tools:sdk` section
3. **呈现模式**：只做 both（native + js 并存），模型自选形态
4. **curated result 语义**：维持现状——REPL 内只有 print/return 进历史，嵌套 tool 调用中间结果不进 message log，执行日志进 session 事件流（dsh"外层结果独占历史"契约，Lume 已天然满足）

P2 转正的工具同样进 `tools.*` API；deferred 工具可在 REPL 内 select 后经 `tools.*` 使用（叠加效果）。

---

## 测试

- bun:test（见 `reference_test-runner-bun-test`）：registry 单测（层继承/shadow/掩码交集/profile）；engine 测试（转正后 tools 数组变化）；node-repl contract 测试扩展 `tools.*` API
- 每期独立 worktree + PR：P1 纯内部重构对外行为不变 → P2 engine 语义变化 → P3 新能力叠加
