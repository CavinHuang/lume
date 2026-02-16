# OpenClaw 记忆与 CLI 能力对齐任务进度

## 任务目标
- 与 OpenClaw 对齐记忆系统（memory_search / memory_get / memory_save、citation mode、工具策略）。
- 与 OpenClaw 对齐 CLI 编程工具能力（Claude CLI / Codex CLI），支持按模型 provider 路由。
- 在 Lume 中形成可持续维护的实现与配置方式。

## 当前结论（截至 2026-02-12）
- 已实现 Claude SDK + Claude CLI + Codex CLI 三后端。
- 后端路由不是“模型自己决策工具”，而是由 provider/model 解析后选择 backend（与 OpenClaw 一致）。
- 记忆工具当前通过 sidecar MCP 注入（与 OpenClaw 插件架构不同，但行为已对齐大部分核心能力）。
- Agent 前端已补齐“低心智负担”使用路径：不填模型时可自动走 CLI 默认模型，并提供 Claude/Codex 一键切换按钮。

## 已完成
1. CLI 后端能力
- 新增 `apps/sidecar/src/services/agent-cli-runner.ts`。
- 支持 `claude_cli` 与 `codex_cli` 执行、resume、JSON/JSONL/text 解析、timeout/abort。
- 支持运行队列串行控制（`serialize`）。
- 支持运行时环境控制（`env`、`clearEnv`）。
- 支持运行时覆盖配置 `cliBackends`。
- 支持 OpenClaw 关键语义：`sessionMode`、`sessionArgs`、`systemPromptArg/systemPromptWhen`、`input(arg/stdin)`、`maxPromptArgChars`、`modelAliases`。

2. Agent 路由与会话元数据
- `packages/shared/src/types/agent.ts` 增加 `AgentExecutionBackend`、`executionBackend`、`cliSessionIds`。
- `apps/sidecar/src/services/agent-service.ts` 支持：
  - `claude-cli/...`、`codex-cli/...`（并兼容 `claude_cli/...`、`codex_cli/...`）模型前缀路由。
  - CLI 模式提示词追加：`Tools are disabled in this session. Do not call tools.`
  - CLI 分支补齐系统提示词追加（含 memory recall/citation 规则），减少与 SDK 路径行为差异。
  - 会话级 backend/cliSessionId 持久化。
  - 前端模型前缀识别与后端统一，兼容 `*-cli/` 与 `*_cli/` 两种写法。

3. 运行时配置
- 新增 `apps/sidecar/src/services/agent-runtime-config.ts`。
- 支持 `cliBackends` 配置覆盖。
- 兼容 OpenClaw 风格 key：`claude-cli` / `codex-cli`（同时兼容下划线写法）。

4. 记忆策略层（对齐 OpenClaw）
- `apps/sidecar/src/services/memory-policy.ts` 已支持：
  - `allow/deny` 分组展开（`group:memory`）。
  - 通配符策略匹配（如 `memory_*`、`*_save`、`*`）。
  - `deny` 优先于 `allow`。
  - citation mode：`on/off/auto`，`auto` 下 direct 显示、group/channel 抑制。
- 相关测试已补齐。

5. 前端收敛
- 去除显式 backend 选择残留状态，收敛到“由 model/provider 决定 backend”的路径。
- 模型输入区增加一键按钮：`Claude Code` / `Codex` / `SDK`。
- 无 channel 场景下默认 backend 推断为 Claude CLI（无需先手填模型才能发送）。
- 移除易混淆的“手输模型输入框”，改为按钮驱动 + 当前模型文本提示。

## 当前进行中
1. 持续对照 OpenClaw 做回归验证与增量维护（功能对齐项已完成）。

## 待完成 / 差异项
1. 架构差异（暂接受）
- OpenClaw 记忆是插件/工具体系；Lume 当前通过 sidecar MCP 注入记忆工具。

2. 深度对齐候选项
- CLI 进程清理策略已补齐基础实现（resume/suspended），并新增 ps 解析匹配测试。
- 若要“完全一致”，需继续补齐更细粒度 live 行为与故障注入测试。
- 已完成：CLI 图片参数通道（通过附件路径提取 + `imageArg` 注入）。
- 已完成：任意 provider id 映射 CLI backend（动态 `cliBackends` key）。
- 已完成：CLI 分支系统提示词统一接入 memory/tool 策略追加。
- 已完成：CLI failover 原因分类并附带结构化前缀输出。

## 风险与注意
- CLI 依赖本地二进制（`claude`、`codex`）与登录态，环境不一致会导致运行失败。
- provider/model 命名必须符合路由约定，否则会回落到 SDK 路径。

## 验证状态
- 已通过：
  - `bun run --filter @lume/sidecar typecheck`
  - `bun run --filter @lume/web typecheck`
  - `bun test apps/sidecar/src/services/agent-runtime-config.test.ts apps/sidecar/src/services/agent-cli-runner.test.ts apps/sidecar/src/services/memory-policy.test.ts`
- 最近一次结果：
  - 20 pass / 0 fail（agent-runtime-config + agent-cli-runner + memory-policy）

## 更新日志
- 2026-02-16：
  - Soul/Memory 对齐收口完成：
    - Session Bootstrap 读取顺序、Project Context 注入顺序与 OpenClaw 对齐。
    - subagent 上下文白名单对齐（仅 AGENTS/TOOLS）。
    - `memory.md` fallback 全链路对齐（读取、索引、提示词注入、工具描述）。
    - `memory_search/memory_get/memory_save` 异常降级语义对齐（disabled payload，非 tool error）。
    - 抽离 `memory-mcp-service`，实现 memory 工具模块复用与独立单测。
    - 增加 `sessionType` 合同字段并在主前端发送入口显式透传。
    - 修复大小写不敏感文件系统下 `MEMORY.md/memory.md` 回显偏差。
  - 测试补齐并通过：
    - `memory-mcp-service.test.ts`
    - `agent-prompt-builder.test.ts`
    - `workspace-bootstrap-service.test.ts`
    - `memory-service.test.ts`
    - `memory-policy.test.ts`
    - `config-paths.test.ts`
- 2026-02-12：
  - 建立本任务进度文件并补录当前全量进展。
  - 完成 memory 策略通配符对齐。
  - 完成 cliBackends OpenClaw 风格 key 兼容。
  - 完成 CLI env/clearEnv/serialize 配置对齐。
  - 完成 CLI 进程清理策略第一版对齐（resume/suspended best-effort cleanup）。
  - 增加 `agent-cli-runner` 匹配器测试，覆盖 claude/codex 会话命令模式。
  - 完成 task 进度文件机制落地：后续统一在本文件持续更新。
  - 新增挂起进程匹配提取测试（`collectSuspendedMatchedPids`），提升清理策略可回归性。
  - CLI 分支接入统一 `buildSystemPromptAppend`，首轮消息包含系统提示词区块（与 SDK 路径策略对齐）。
  - AgentView 前端路由提示补齐下划线 provider 前缀兼容，避免前后端分歧。
  - CLI 运行语义新增对齐：`sessionMode/sessionArgs/systemPromptWhen/input/stdin/modelAliases/maxPromptArgChars`。
  - 动态 CLI backend 路由上线：`cliBackends` 支持任意 provider key。
  - CLI 图片参数链路接入：从 `<attached_files>` 提取图片路径并注入 `imageArg`。
  - 新增 `custom_cli` 执行后端类型，保证会话元数据语义一致。
  - 新增自定义 backend key 解析测试。
  - Agent 前端体验优化：新增 Claude/Codex/SDK 快捷按钮与无 channel 默认 CLI 推断，减少手输模型前缀成本。
