# Lume 最终态架构边界设计文档包

本目录包含三份设计文档。它们的重点不是短期代码拆分，而是先定义 Lume 最终态的系统边界：谁拥有 runtime 真相，谁只是宿主，哪些能力是 AI 可见工具，哪些能力是后台服务。

1. `lume-overall-architecture-modification-design.md`  
   整体架构边界设计：Runtime Kernel、Tauri Host、Sidecar Runtime Host、Tool Runtime、Service Runtime、Adapters、状态真相归属。

2. `lume-agent-loop-modification-design.md`  
   Agent Loop 边界设计：Agent Runtime Kernel 内部的 loop engine、上下文、事件、checkpoint、interruption、SDK adapter、PostRun 调度边界。

3. `lume-tool-system-modification-design.md`  
   Tool Runtime 边界设计：Tool Registry、Tool Resolver、Execution Gateway、AI 可见工具与后台服务分界、MCP/Skill/Subagent/Memory/Automation 接入策略。

建议放置位置：

```text
docs/architecture/lume-overall-architecture-modification-design.md
docs/architecture/lume-agent-loop-modification-design.md
docs/architecture/lume-tool-system-modification-design.md
```

建议阅读顺序：

```text
1. 先读整体架构边界，确认 Runtime Kernel 和 Host/Adapter 的职责分离
2. 再读 Agent Loop 边界，确认 loop 内部协议和状态真相
3. 最后读工具系统边界，确认 Tool Runtime 与 Service Runtime 的分界
```

最终态核心判断：

```text
Agent Runtime Kernel 是 Lume 的产品真相来源。
Sidecar Runtime Host 只是本地宿主和服务容器。
Tool Runtime 是 AI 可见能力边界。
Service Runtime 是系统自动能力边界。
UI、Tauri、Adapters 不拥有业务状态真相。
```

当前已落地的文件边界：

```text
packages/shared/src/types/agent-loop.ts
packages/shared/src/types/runtime-event.ts
apps/sidecar/src/services/agent-runtime/kernel/agent-runtime-kernel.ts
apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts
apps/sidecar/src/services/agent-runtime/tools/tool-registry.ts
apps/sidecar/src/services/agent-runtime/tools/tool-resolver.ts
apps/sidecar/src/services/agent-runtime/tools/tool-execution-gateway.ts
apps/sidecar/src/services/agent-runtime/interruption/ask-user-question-session.ts
apps/sidecar/src/services/agent-runtime/interruption/tool-permission-session.ts
apps/sidecar/src/services/agent-runtime/service-runtime/service-runtime.ts
apps/sidecar/src/services/agent-runtime/service-runtime/auto-title-job.ts
apps/web/src/hooks/runtime-event-state.ts
apps/web/src/components/agent/runtime-event-message-projection.ts
```
