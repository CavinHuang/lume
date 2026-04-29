# Lume Agent Runtime 能力补足实现记录

## Summary

Lume 不迁移到 `openai-agents-js`。本轮实现只借鉴其 Runner、RunState、Interruption、Guardrail、Trace 等运行时抽象，并保留 Lume 的本地优先、多供应商、MCP、Skill、Memory、Subagent 和 Automation 约束。

本轮优先落地可恢复与可观测基础设施，不承诺完整 cold-start resume。进程重启后的自动续跑需要 Runner 保存可恢复 turn 状态后再做。

## Cleanup Plan

- 删除生产路径写 `systemPrompt.md` 的调试行为，避免把 prompt debug 泄漏到 workspace。
- 将现有 `runtime-tool-safety` 收敛进 guardrail runner，而不是并行维护两套安全判断。
- 保留现有 IPC 与 SDKMessage UI 消费路径；只新增最小 `SDKMessage -> LumeRunEvent` adapter 作为后续 UI 迁移边界，不接入 UI 主路径。
- 旧 permission / AskUser bridge 直接写 interruption store，不新增一层只做翻译的桥接。

## Implemented Changes

- Added file-backed RunState storage under runtime-core session directories:
  - `sessions/{threadId}/runs/{runId}.json`
  - `sessions/{threadId}/runs/{runId}.items.jsonl`
- Added file-backed Trace storage:
  - `sessions/{threadId}/traces/{traceId}.json`
- Added `LumeRunner` as the runtime lifecycle owner for current attempt observability, runtime session creation, abort registration, query stream consumption, finalization, and session disposal.
- Moved channel/model/workspace preparation into a dedicated attempt prepare factory so `runRuntimeCoreAttempt()` stays focused on orchestration.
- Added runtime trace spans for run, context assembly, memory retrieval, tool calls, and approvals.
- Added basic trace redaction for secret-like tool inputs and output previews.
- Added persistent interruption records for tool approval and AskUserQuestion:
  - `sessions/{threadId}/interruptions/{interruptionId}.json`
- Added minimal guardrail framework and migrated runtime tool safety into builtin tool input guardrails.
- Added builtin guardrails for file write workspace boundaries and sensitive memory writes.
- Added minimal structured plan store and markdown/front matter/`PlanStateTracker` step mapping for later Plan UI/runtime integration.
- Added context budget and moved existing system/dynamic/memory prompt assembly into `ContextAssembler`.
- Added minimal `LumeRunEvent` types and `SDKMessage` adapter for later UI migration.
- Added sidecar `agent:run:event` emission and a narrow web listener path for assistant/tool/interruption/run terminal events while keeping raw `SDKMessage` persistence.
- Added continuation checkpoint storage and `ResumeService` result states for cold-start resume preparation. This records durable resume intent, but only resumes when a registered continuation runner is available.
- Added `PlanWriteTool` in plan mode and plan approval interruption persistence.
- Added parent RunState subagent items and trace spans for subagent lifecycle events.
- Added explicit background subagent execution path that returns immediately and persists completion through the existing subagent registry/announcement flow.
- Added `AutomationRunInput` and persisted automation high-risk tool approvals as `automation_approval` interruptions while reusing the existing tool-permission UI request shape.
- Added trace redaction tiers:
  - `safe_summary`
  - `diagnostic`
  - `raw_internal`
- Removed production `systemPrompt.md` writes from runtime session creation.

## Non-goals

- No OpenAI SDK migration.
- No new dependencies.
- No external tracing exporter or OTEL integration.
- No full UI event replacement yet; raw `SDKMessage` remains the source of transcript compatibility.
- No full post-restart execution resume yet.
- No recovery of in-flight shell/process tools after restart.
- No complex handoff UI or control-transfer implementation yet.
- No automation dashboard rewrite yet.

## Later Roadmap

- Full post-restart execution resume after turn continuation state is explicitly persisted.
- Broader UI migration from raw `SDKMessage` rendering to `LumeRunEvent`.
- Handoff control-transfer support and richer background subagent management UI.
- Trace tree UI backed by `safe_summary` by default, with diagnostic/raw access gated to internal/debug surfaces.
