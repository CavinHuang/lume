# Lume Agent Runtime 能力补足实现记录

## Summary

Lume 不迁移到 `openai-agents-js`。本轮实现只借鉴其 Runner、RunState、Interruption、Guardrail、Trace 等运行时抽象，并保留 Lume 的本地优先、多供应商、MCP、Skill、Memory、Subagent 和 Automation 约束。

本轮优先落地可恢复与可观测基础设施。cold-start resume 只对已经有合成 tool result 的 checkpoint 走真实续跑；纯工具审批、运行中的 shell/process 等不可安全重放的状态会明确返回 `not_resumable`。

## Cleanup Plan

- 删除生产路径写 `systemPrompt.md` 的调试行为，避免把 prompt debug 泄漏到 workspace。
- 将现有 `runtime-tool-safety` 收敛进 guardrail runner，而不是并行维护两套安全判断。
- 保留 runtime 内部 SDKMessage transcript/debug 存储；UI 历史与 live 渲染都走 `LumeRunEvent`。
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
- Added `LumeRunEvent` types. SDK stream is normalized once into RunItems; UI events are projected from those RunItems.
- Added sidecar `agent:run:event` live emission for assistant/tool/interruption/run terminal events.
- Added frontend `LumeRunEvent` state cache so the web app consumes structured runtime events for live and persisted rendering.
- Switched main-thread live rendering to `LumeRunEvent`:
  - runtime observer emits RunEvents from recorded RunItems before UI handler dispatch
  - sidecar no longer sends main-thread raw `agent:stream:event` to web
  - web no longer builds synthetic assistant SDK messages for live output
  - raw SDK stream is no longer an IPC surface
- Tightened web component boundaries after the switch:
  - `AgentView` and `AgentHeader` no longer depend on SDKMessage state
  - `AgentMessages` renders only `LumeRunEvent` projections
  - header tool-step counting now uses `tool_call_started` RunEvents
- Added continuation checkpoint storage and `ResumeService` result states for cold-start resume preparation. This records durable resume intent, but only resumes when a registered continuation runner is available.
- Added AskUserQuestion cold-start continuation:
  - AskUser interruption resolves into a synthetic tool result checkpoint
  - `agent:resume-run` can rebuild a hidden continuation message and continue through `sendAgentMessage`
  - unresolved tool approvals without tool result are reported as `not_resumable` instead of pretending to resume
- Added tool-approval cold-start replan continuation:
  - approval/rejection resolves into a `before_model_call` checkpoint
  - recovery explicitly tells the model the original tool was not replayed
  - execute tools are still not process-restored; they must be re-issued or replanned
- Added `PlanWriteTool` in plan mode and plan approval interruption persistence.
- Added plan approval as a first-class pending interactive item:
  - `agent:get-pending-interactive` returns `planApprovals`
  - `agent:submit-plan-approval` resolves the persistent interruption
  - `PlanStore` updates to `approved` / `cancelled`
- Added parent RunState subagent items and trace spans for subagent lifecycle events.
- Added explicit background subagent execution path that returns immediately and persists completion through the existing subagent registry/announcement flow.
- Added `subagent_updated` and `handoff_updated` `LumeRunEvent` projections from persisted RunItems so reload-safe history includes these runtime facts.
- Added `AutomationRunInput` and persisted automation high-risk tool approvals as `automation_approval` interruptions while reusing the existing tool-permission UI request shape.
- Added automation run status `waiting_for_approval`; high-risk automation approvals are durable and the automation run records a paused outcome instead of hanging on a live resolver.
- Added trace redaction tiers:
  - `safe_summary`
  - `diagnostic`
  - `raw_internal`
- Added runtime-state IPC boundaries:
  - `agent:resume-run`
  - `agent:list-run-states`
  - `agent:get-thread-run-events`
  - `agent:get-run-trace`
  - `agent:list-structured-plans`
- Added run-state summary projection for UI/debug consumers, including continuation checkpoint summaries and interruption/item counts without exposing full generated item payloads.
- Added RunState/RunItems to `LumeRunEvent` projection for reload-safe history rendering without raw SDK transcript reads.
- Added default `safe_summary` trace projection for UI-facing trace reads.
- Added structured plan projection from `PlanStore` without forcing historical markdown plan migration.
- Added internal handoff recording API that persists a `handoff` run item and trace span without changing current conversation control flow.
- Added typed web desktop API wrappers for resume, trace reads, and structured plan reads.
- Added PlanPanel structured-plan fallback so existing Plan UI can render `PlanStore` data when legacy `PlanStateTracker` state is absent.
- Added PlanPanel approval actions for structured plans that are waiting on `plan_approval`; approval reuses the existing best-effort `resume-run` path.
- Added TracePanel and side-panel trace entry. UI reads `safe_summary` traces by default.
- Added TracePanel redaction-level switch. UI-facing trace reads only support `safe_summary` and `diagnostic`; `raw_internal` remains sidecar-internal only.
- Added TracePanel run selector backed by `agent:list-run-states`, so users can inspect historical runs instead of only the latest trace.
- Added TracePanel live event preview backed by the frontend `LumeRunEvent` cache. This is intentionally a debug/status projection, not a replacement for message rendering yet.
- Added TracePanel span tree projection based on `parentId`, with orphan spans kept as root rows for robustness.
- Added best-effort `resume-run` calls after tool approval and AskUserQuestion answers. `not_resumable` remains non-fatal and does not claim execution resumed.
- Added debug logging for non-resumed `resume-run` results so resume boundaries are visible without user-facing false success.
- Added automation approval metadata (`automationJobId` / `automationTrigger`) to high-risk tool permission requests.
- Added Automation management page pending-approval banner for `automation_approval` interruptions, joined with known job names when available.
- Removed production `systemPrompt.md` writes from runtime session creation.
- Removed agent-specific `agent:stream:complete` / `agent:stream:error` notifications; completion and failure now flow through terminal `LumeRunEvent` records.

## Non-goals

- No OpenAI SDK migration.
- No new dependencies.
- No external tracing exporter or OTEL integration.
- Web UI no longer consumes raw `SDKMessage`; runtime internals may still persist SDK messages for transcript/debug purposes.
- Removed `agent:stream:event` / `LEGACY_STREAM_EVENT` and `agent:get-thread-sdk-messages` from the public UI boundary.
- No full post-restart execution resume for every tool yet. `agent:resume-run` returns explicit `not_resumable` unless a valid checkpoint, synthetic result, and continuation runner exist.
- Plan approval can clear the persistent interruption and mark the plan approved, but full execution continuation still depends on the runner/resume capability available for that run.
- No recovery of in-flight shell/process tools after restart.
- No complex handoff UI or control-transfer implementation yet.
- No full automation dashboard rewrite yet; the current page surfaces pending approvals and run records can show `waiting_for_approval`.
- Raw trace is intentionally sidecar-internal only and should not be exposed through UI-facing RPC.

## Later Roadmap

- Broader post-restart execution resume after more tool types can produce safe synthetic results or explicit retry plans.
- Handoff control-transfer support and richer background subagent management UI.
- Full handoff control-transfer UI and safe post-restart continuation runners remain the main runtime roadmap items.
