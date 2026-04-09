# P1-1: tool-builder Skill

## 状态

✅ 已完成（代码已存在，2026-04-09 回写状态）

默认 Skill 已存在于 [apps/sidecar/default-skills/tool-builder/SKILL.md](/E:/projects/ai-projects/lume/apps/sidecar/default-skills/tool-builder/SKILL.md)，内容已适配 `~/.lume/chat-tools.json`、`customTools` 结构与现有 HTTP 工具执行链路。

## 差距分析

### Proma 的实现

Proma 在 `apps/electron/default-skills/tool-builder/SKILL.md` 中提供了完整的 tool-builder Skill，允许用户通过对话交互创建自定义 HTTP API 工具。

**核心流程**：
1. 用户描述需求（如"我需要一个查天气的工具"）
2. Agent 引导用户确认 API 端点、参数、认证方式
3. 生成工具配置 JSON，写入 `~/.proma/chat-tools.json`
4. 测试调用，验证响应格式
5. 配置结果路径提取（如 `data.results[0].content`）

**工具配置结构**（写入 chat-tools.json）：
- name / description / parameters 定义
- HTTP method (GET/POST)
- URL 模板（支持参数插值）
- 请求体模板
- API Key / Auth 配置
- 结果路径提取规则

### Lume 的现状

- ✅ **已有 HTTP 工具执行基础设施**：`apps/sidecar/src/services/chat/chat-tool-http-executor.ts`
  - 支持模板化 URL 和请求体
  - 支持凭证和变量插值
  - 支持结果路径提取
  - 实现了超时和错误处理
- ✅ **已有工具管理框架**：`chat-tool-definition-service.ts` + `chat-tool-execution-service.ts`
  - 工具发现、启用/禁用
  - 自定义 HTTP 工具执行
- ❌ **没有 tool-builder Skill**（用户无法通过对话创建自定义工具）

## 修改方案

### 步骤 1: 创建 tool-builder Skill 文件

**文件**: `apps/sidecar/default-skills/tool-builder/SKILL.md`

基于 Proma 的 tool-builder Skill 适配 Lume 架构。主要差异点：

| 维度 | Proma | Lume 适配 |
|------|-------|-----------|
| 配置文件路径 | `~/.proma/chat-tools.json` | `~/.lume/chat-tools.json` |
| 工具执行器 | Electron 主进程 | `chat-tool-http-executor.ts` |
| 工具注册 | `chat-tool-config.ts` | `chat-tool-definition-service.ts` |

**Skill 核心内容**：
```markdown
---
name: tool-builder
description: 交互式创建自定义 HTTP API 工具，让你的助手能调用外部 API
trigger: 当用户想创建新工具、添加 API 集成、或说"帮我做个工具"时
---

# Tool Builder — 自定义 HTTP 工具创建器

## 创建流程

### 第 1 步：需求收集
通过 AskUserQuestion 引导用户明确：
- 工具用途（一句话描述）
- API 端点和认证方式
- 输入参数
- 期望的输出格式

### 第 2 步：配置生成
生成工具配置 JSON，结构：
{
  "id": "工具唯一标识",
  "name": "工具显示名",
  "description": "工具描述",
  "params": [...],
  "executorType": "http",
  "httpConfig": {
    "method": "GET|POST",
    "urlTemplate": "https://api.example.com/v1/{{param}}",
    "bodyTemplate": "...",
    "headers": {...},
    "resultPath": "data.results"
  }
}

### 第 3 步：写入配置
将工具配置追加到 ~/.lume/chat-tools.json

### 第 4 步：测试验证
调用新工具进行测试，确认响应正常

### 第 5 步：凭证配置
引导用户配置 API Key 等凭证信息
```

### 步骤 2: 确认 Lume 的 chat-tools.json 结构

需要读取 `chat-tool-definition-service.ts` 和 `chat-tool-http-executor.ts` 确认：
- 自定义工具的 JSON 结构
- 工具注册和加载机制
- httpConfig 字段格式

确保 Skill 中生成的配置与 Lume 已有执行器兼容。

## 验证方法

1. 启动 Agent 会话，说"帮我创建一个查天气的工具"
2. 观察 Agent 是否按照 Skill 流程引导创建
3. 确认生成的配置写入 `~/.lume/chat-tools.json`
4. 在 Chat 模式中调用新创建的工具，验证执行正常

## 工作量估计

约 2 小时，主要时间在适配 Lume 的工具配置格式和编写 Skill 内容。
