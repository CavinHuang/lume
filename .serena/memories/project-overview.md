# Lume 项目概览

## 项目性质
AI 桌面应用（Tauri + React），类似 Claude Code 的桌面端。包含 Chat 模式和 Agent 模式。

## Monorepo 结构
- `apps/web` — React 前端（Vite + React + TailwindCSS + Jotai 状态管理）
- `apps/desktop` — Tauri 桌面壳
- `apps/sidecar` — 后端 sidecar 进程
- `packages/shared` — 共享类型和逻辑
- `packages/ui` — 共享 UI 组件

## 技术栈
- 包管理: bun (bun workspaces)
- 前端框架: React 18 + Vite
- 状态管理: Jotai
- 样式: TailwindCSS + shadcn/ui
- Markdown 渲染: Streamdown (streaming markdown)
- 桌面: Tauri v2

## 关键开发命令
- `bun run dev` — 同时启动 web 和 desktop
- `bun run build` — 全量构建
- `bun run typecheck` — TypeScript 类型检查

## Agent 模式关键文件
- `apps/web/components/agent/AgentView.tsx` — 主视图，负责状态、通道、streaming
- `apps/web/components/agent/AgentMessages.tsx` — 消息列表渲染
- `apps/web/components/agent/ToolActivityItem.tsx` — 工具调用 UI（ActivityRow, ToolActivityList, ToolActivityTree）
- `apps/web/components/agent/EventTimeline.tsx` — 将 timeline events 转换为分段渲染
- `apps/web/components/ai-elements/message.tsx` — 基础消息组件（MessageResponse, UserMessageContent 等）
- `apps/web/atoms/` — Jotai atoms，含 agent streaming 状态
