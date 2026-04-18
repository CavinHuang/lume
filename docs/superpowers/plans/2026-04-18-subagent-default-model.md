# Subagent 默认模型设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为设置页增加统一的“子 Agent 默认模型”配置，未设置时继承当前对话模型，并去掉内置 subagent 的硬编码模型假设。

**Architecture:** 在 `lume-config` 中新增 `models.subagent.defaultModelRef`。Web 设置页用现有渠道模型列表提供“继承当前对话模型 / 指定 provider/model”选择。Sidecar 在包装 `AgentTool` 时统一解析显式 `model` 或设置中的默认模型，必要时覆盖 provider/apiType/model；否则继承父对话模型。

**Tech Stack:** React, TypeScript, Jotai, Zod, Bun test, sidecar runtime-core

---

## File Structure

### 修改
- `packages/shared/src/types/lume-config.ts` — 新增 subagent 模型配置类型
- `apps/sidecar/src/services/system/lume-config-service.ts` — 归一化/合并 `models.subagent`
- `apps/sidecar/src/services/system/lume-config-service.test.ts` — 配置读写回归测试
- `apps/sidecar/src/rpc/schemas.ts` — 允许更新 `models.subagent.defaultModelRef`
- `apps/web/src/lib/desktop-api/lume-config.ts` — 增加子 Agent 默认模型读写 helper
- `apps/web/src/components/settings/AgentSettings.tsx` — 增加子 Agent 默认模型设置 UI
- `apps/sidecar/src/services/pi-agent/runtime-core/run.ts` — 解析子 Agent 默认模型并注入 provider/model override
- `apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts` — 子 Agent 默认模型优先级测试
- `apps/sidecar/src/services/agent/agent-prompt-builder.ts` — 去掉内置 subagent 的固定 haiku 元数据与相关文案
- `apps/sidecar/src/services/agent/agent-prompt-builder.test.ts` — 调整内置 agent / prompt 断言

### 验证
- `bun test apps/sidecar/src/services/system/lume-config-service.test.ts`
- `bun test apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts`
- `bun test apps/sidecar/src/services/agent/agent-prompt-builder.test.ts`
- `bun run --filter @lume/web build`

---

### Task 1: 配置类型与 RPC 支持

**Files:**
- Modify: `packages/shared/src/types/lume-config.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.test.ts`
- Modify: `apps/sidecar/src/rpc/schemas.ts`

- [ ] 为 `models.subagent.defaultModelRef` 写失败测试
- [ ] 运行测试确认失败
- [ ] 实现 shared type / normalization / schema
- [ ] 运行测试确认通过

### Task 2: Sidecar 解析子 Agent 模型优先级

**Files:**
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts`

- [ ] 为“显式 model > subagent 默认模型 > 继承父对话模型”写失败测试
- [ ] 运行测试确认失败
- [ ] 实现 provider/model override 解析
- [ ] 运行测试确认通过

### Task 3: 设置页增加子 Agent 默认模型

**Files:**
- Modify: `apps/web/src/lib/desktop-api/lume-config.ts`
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`

- [ ] 复用现有渠道模型列表，增加“继承当前对话模型”选项
- [ ] 保存到 `models.subagent.defaultModelRef`
- [ ] 未设置时显示继承态
- [ ] 跑 `@lume/web build`

### Task 4: 去掉误导性的硬编码 haiku 文案

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`
- Modify: `apps/sidecar/src/services/agent/agent-prompt-builder.test.ts`

- [ ] 先改测试，去掉对内置 `haiku` 的依赖
- [ ] 更新 built-in agent metadata 和 prompt 文案
- [ ] 跑测试确认通过

### Task 5: 收尾验证

**Files:** 无新增修改

- [ ] 运行本计划列出的全部验证命令
- [ ] 检查 diff，确认没有引入新的源码生成物或无关改动
