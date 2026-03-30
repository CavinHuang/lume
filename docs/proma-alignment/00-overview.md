# Proma → Lume P0/P1 功能对齐方案

## 总览

本方案基于对 Proma 和 Lume 两个项目源码的深入对比分析，聚焦 P0（必须对齐）和 P1（高价值对齐）功能。

## 项目架构映射

| 维度 | Proma | Lume |
|------|-------|------|
| 桌面框架 | Electron (Node.js 主进程) | Tauri (Rust) + Bun Sidecar |
| 前端 | Electron Renderer (React) | Web App (Vite + React) |
| 后端逻辑 | `apps/electron/src/main/lib/*.ts` | `apps/sidecar/src/services/` |
| 包命名 | `@proma/shared`, `@proma/core` | `@lume/shared`, `@lume/ui` |
| 配置目录 | `~/.proma/` | `~/.lume/` |
| IPC 通信 | Electron IPC | Tauri Commands + Sidecar JSON-RPC |
| Agent SDK | Claude Agent SDK (直接) | pi-agent (@mariozechner/pi-agent-core) |

## Lume 已有能力（不需要新增）

| 功能 | 状态 | 说明 |
|------|------|------|
| Chat 工具框架 | ✅ | chat-tool-definition/execution/manager 完整 |
| Chat 内置工具 | ✅ | memory_search, web_search(DuckDuckGo/Brave/Tavily), suggest_agent_mode, nano_banana |
| Chat→Agent 推荐 | ✅ | AgentModeRecommendationBanner 已实现 |
| 默认 Skills 9个 | ✅ | brainstorming/docx/xlsx/pdf/pptx/find-skills/skill-creator/writing-plans/executing-plans |
| Memory 系统 | ✅ | memory_search/get/save, 文件级记忆, 本地向量搜索 |
| SubAgent 机制 | ✅ | subagent-policy/run-registry/announce-service |
| System Prompt | ✅ | agent-prompt-builder.ts (已从 Proma 迁移并增强) |
| 工作区管理 | ✅ | agent-workspace-manager.ts |
| MCP 集成 | ✅ | 工作区级 mcp.json 配置 |
| AI 生图 | ✅ | Nano Banana (Gemini API) |
| 能力路由 | ✅ | capability-routing.ts (Lume 独有增强) |
| 自动化 | ✅ | automation service (Lume 独有) |
| Heartbeat | ✅ | heartbeat-service.ts (Lume 独有) |

## 确认的差距清单

详见各分片文档：
- `01-p0-builtin-subagents.md` — P0-1: 内置 SubAgent 定义
- `02-p0-context-knowledge.md` — P0-2: .context 目录知识管理体系
- `03-p0-uncertainty-handling.md` — P0-3: 不确定性处理策略
- `04-p1-tool-builder-skill.md` — P1-1: tool-builder Skill
- `05-p1-memory-prompt.md` — P1-2: 记忆系统 Prompt 优化
- `06-p1-skill-improvement.md` — P1-3: Skill 改进提示
- `07-execution-plan.md` — 执行计划与验证

## 实施原则

1. **遵循 Lume 现有架构** — 不引入新抽象层
2. **复用已有基础设施** — 优先修改现有文件而非新建
3. **增量可验证** — 每个阶段独立可测试
4. **向后兼容** — 不破坏现有功能
