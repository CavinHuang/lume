# Prompt V2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Lume 的 agent prompt 重构为更强 agent 内核 + 更清晰 persona/guardrails 的分层体系，同时保留 companion 定位。

**Architecture:** 维持 `agent-prompt-builder.ts` 作为 runtime 内核拼装器，将执行协议、主动汇报、delegation、guardrails 收敛到 builder；将人格、自我认知与 companion 设定收敛到 workspace 模板。避免引入 Alma 的单文件巨型 prompt，继续沿用 Lume 的 workspace file injection 机制。

**Tech Stack:** TypeScript, Bun test, workspace bootstrap templates, sidecar prompt builder

---

### Task 1: Prompt Builder Kernel Upgrade

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`
- Test: `apps/sidecar/src/services/agent/agent-prompt-builder.test.ts`

- [ ] **Step 1: Write failing tests for new prompt sections**

Add tests for:
- `## Agentic Execution`
- `## Commitment Enforcement`
- `## Proactive Updates`
- `## Delegation Policy`
- `## Persona and Reality Guardrails`
- minimal mode retains runtime/tooling but omits full kernel sections

- [ ] **Step 2: Run test to verify failure**

Run: `bun test apps/sidecar/src/services/agent/agent-prompt-builder.test.ts`
Expected: FAIL because new sections do not exist yet

- [ ] **Step 3: Implement prompt builder changes**

Update full prompt assembly to inject the new sections while preserving:
- identity first line
- plan mode protocol
- memory/browser/automation sections
- subagent minimal prompt behavior

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/sidecar/src/services/agent/agent-prompt-builder.test.ts`
Expected: PASS

### Task 2: Workspace Persona Template Upgrade

**Files:**
- Modify: `templates/workspace/SOUL.md`
- Modify: `templates/workspace/AGENTS.md`
- Modify: `templates/workspace/IDENTITY.md`
- Modify: `templates/workspace/BOOTSTRAP.md`
- Modify: `templates/workspace/USER.md`
- Modify: `templates/workspace/SOUL.dev.md`
- Modify: `templates/workspace/AGENTS.dev.md`
- Modify: `templates/workspace/IDENTITY.dev.md`
- Modify: `templates/workspace/USER.dev.md`
- Optional Modify: `templates/workspace/TOOLS.md`
- Test: `apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts`

- [ ] **Step 1: Write failing tests for template expectations if needed**

If template-level assertions are needed, add minimal checks through `readTemplateContent(...)` for updated headings/sections only.

- [ ] **Step 2: Run targeted test to verify failure**

Run: `bun test apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts`
Expected: FAIL only if new assertions are added

- [ ] **Step 3: Update workspace templates**

Rewrite templates so they reflect:
- stronger subjecthood / companion tone
- identity + self-recognition + appearance placeholders
- bootstrap onboarding for persona setup
- AGENTS guardrails for external/public/high-risk contexts

- [ ] **Step 4: Run relevant tests**

Run: `bun test apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts`
Expected: PASS

### Task 3: End-to-End Prompt Verification

**Files:**
- Modify: `docs/plans/2026-03-27-lume-agent-prompt-v2-migration.md` (only if implementation notes need sync)

- [ ] **Step 1: Run prompt-builder and bootstrap tests together**

Run: `bun test apps/sidecar/src/services/agent/agent-prompt-builder.test.ts apps/sidecar/src/services/system/workspace-bootstrap-service.test.ts`
Expected: PASS

- [ ] **Step 2: Run sidecar typecheck**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: PASS

- [ ] **Step 3: Run sidecar build**

Run: `bun run --filter @lume/sidecar build`
Expected: PASS

- [ ] **Step 4: Report residual risks**

Document whether any remaining gaps are product-policy gaps rather than implementation bugs.
