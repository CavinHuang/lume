# Permission Mode Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent 设置页中的权限模式卡片补充图标和视觉强调，让不同模式的语义更直观。

**Architecture:** 抽出权限模式元数据为纯 TypeScript 状态文件，先用测试锁定每个模式的 icon/tone/tag，再在 `AgentSettings.tsx` 中用图标底板和状态 badge 渲染卡片。

**Tech Stack:** React, TypeScript, Bun test, lucide-react, Tailwind CSS

---

### Task 1: 锁定权限模式视觉元数据

**Files:**
- Create: `apps/web/src/components/settings/agent-settings-state.test.ts`
- Create: `apps/web/src/components/settings/agent-settings-state.ts`

- [ ] 写失败测试，断言四个权限模式都有 icon/tone/emphasis
- [ ] 运行测试确认失败
- [ ] 实现状态文件
- [ ] 运行测试确认通过

### Task 2: 更新 AgentSettings 权限模式卡片

**Files:**
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`

- [ ] 引入 icon tile + emphasis badge + 更明确的选中态
- [ ] 保持原有单选语义与交互不变
- [ ] 运行 `@lume/web build`
