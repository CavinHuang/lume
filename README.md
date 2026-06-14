<div align="center">
<img src="assets/lume-logo.png" width="180" height="180" alt="Lume Logo" />


# Lume

**你的本地 AI 工作台。持久、有记忆、真正属于你。**

[English](#english) · [中文](#中文)

</div>

---

<a id="中文"></a>

## Lume 是什么

Lume 是一个运行在你电脑上的 AI 助手——不只是在浏览器里聊天，而是有持久记忆、有主动行为、有真正工具调用能力的本地工作台。

它记得你昨天聊了什么、你偏好什么、你正在做什么项目。它可以在你睡觉的时候帮你整理知识库、推进阅读进度、执行定时任务。它不只是回答问题，而是真正参与你的工作流。

**核心原则：本地优先，数据属于你。**
---

## 设计理念

### 本地优先

你的数据——记忆、对话、项目上下文——全部存在你的电脑上。Markdown 是真源，向量索引只是缓存。你可以随时 `cat ~/.lume/memories/*.md` 读到 Lume 记住的一切。不需要信任任何云端。

### 记忆不是数据库，是经验

Lume 的记忆系统不是冷冰冰的 KV 存储。它区分**事实**（你叫什么、用什么技术栈）、**偏好**（你喜欢简洁的回复还是详尽的分析）、**决策**（项目为什么选了方案 A 而不是 B）、**教训**（上次哪里搞砸了）。这些记忆会在新对话里自然浮现，像一个人记住了你们上次的聊天。

记忆冲突不会自动覆盖——两条矛盾的记忆会并存，由你决定保留哪条。

### 有主见的助手

Lume 不是中立的问答机器。它有自己的判断、偏好和风格。你问它该选哪个方案，它会直接告诉你推荐哪个、为什么。它会在你写的代码有问题时主动指出，会在你的设计有更好的路径时给出建议。

### 工具不是装饰

很多 AI 产品号称"有工具"，实际上只给了 3 个玩具级 API。Lume 有完整的工具集——文件系统、代码执行、Office 文档处理、LSP 代码智能、浏览器自动化、MCP 协议客户端。这些工具不是展示用的，它们是 Lume 参与你工作流的手。

### 自我进化

Lume 的 Skill 系统会分析使用中的失败模式，自动优化提示词，保留版本历史可回滚。它在变好——不是通过云端更新，而是通过本地学习。



## 特性

### 🧠 持久记忆

- **对话记忆**：跨会话记忆，基于 Markdown 真源 + 本地向量索引双重检索
- **事实/偏好/决策追踪**：自动从对话中提取结构化记忆（fact / preference / decision）
- **冲突由你决定**：记忆冲突不会静默覆盖，需要你手动处理
- **记忆搜索**：随时召回之前聊过的任何话题

### 🤖 27 个内置 Skill

开箱即用的专家团队，按需加载：

| 类别 | Skill |
|------|-------|
| **开发** | `agent-developer`（祁远）、`agent-explorer`、`agent-planner`、`code-review`、`explain-code` |
| **写作** | `agent-writer`（江岚）、`agent-novelist`（温序）、`agent-translator`（许澄）、`agent-voice`（宋澈） |
| **分析** | `agent-analyst`（唐栩）、`agent-quant`（纪衡）、`agent-researcher`（顾砚） |
| **创作** | `agent-artist`（白洛）、`agent-designer`（林澄）、`agent-docsmith`（阮知）、`image-gen` |
| **知识** | `agent-wiki`、`brainstorming`、`writing-plans`、`executing-plans` |
| **系统** | `lume-self-evolution`、`skill-creator`、`tool-builder`、`system-info`、`ui-stylist`、`find-skills` |

每个 Skill 都是独立的 `SKILL.md` 文件，支持自我进化——系统会分析使用中的失败并自动优化提示词，保留版本历史可回滚。

### 🔧 真正的工具调用

不是玩具级的 3 个工具，而是完整的本地工具集：

- **文件系统**：`Read`、`Write`、`Edit`、`Glob`、`Grep`、`ls`
- **代码执行**：`Bash`（带超时和后台运行）
- **Agent 编排**：`Agent`（支持并行、隔离、子代理）
- **Office 文档**：`docx_create`、`xlsx_create`、`pptx_create`、`pdf_create`、`office_unpack/pack/validate/convert`
- **记忆系统**：`memory.search`、`memory.remember`
- **Web**：`WebSearch`、`WebFetch`、`guanlan_search`
- **阅读**：微信读书集成（书架、划线、想法、统计）
- **自动化**：`automation_set`、`routine_read/trigger/update`
- **MCP**：标准 Model Context Protocol 客户端，连接任何 MCP 服务器
- **LSP**：代码智能（go-to-definition、find-references、hover）

### ⏰ 自动化 & 日程

- **定时任务**：支持 cron 表达式和预设频率（hourly / daily / weekly / monthly）
- **21 个模板**：一键创建常见自动化（每日总结、周报生成、代码审查等）
- **日程系统**：每天自动生成个性化日程，支持手动触发和调整

### 📚 阅读系统

- **微信读书深度集成**：书架、划线、想法、阅读统计
- **智能笔记生成**：种子笔记 + 深度笔记两阶段管线
- **三源书籍路由**：中文古诗词（今日诗词 API）→ 西方公版（Gutenberg）→ 现代书籍（微信读书）
- **阅读进度追踪**：自动推进，完成时自动标记


### 💬 IM 集成

- **微信连接**：通过 OpenClaw ILINK 协议接入微信，在微信里直接和 Lume 对话
- **图片/文件发送**：支持通过微信发送生成的图片、文档、分析结果
- **消息路由**：微信消息自动绑定到工作区线程，上下文无缝衔接

### 🎭 NPC 角色团队

每个 Skill 背后都有一个有性格、有名字的角色：

> **祁远**（开发者）· **江岚**（作家）· **唐栩**（分析师）· **顾砚**（调研员）· **白洛**（画师）· **林澄**（设计师）· **温序**（小说家）· **许澄**（翻译官）· **宋澈**（配音师）· **阮知**（文档工程师）· **纪衡**（量化分析师）· **Felix** · **Milo** · **Clara** · **Nora** · **Wren** · **Mason** · **Lio** · **Rowan** · **Miles**

他们不只是名字——每个角色都有独立的写作风格、工作偏好和专业领域。当你需要写文章时会交给江岚，需要代码审查时会交给祁远。Lume 作为主线程协调，把任务分发给最合适的角色。

### 🛠️ 工具管理

- **可视化工具面板**：在设置页查看、搜索、启禁用所有工具
- **风险分级**：每个工具标注风险等级（safe / moderate / destructive）
- **策略匹配**：按工作区和场景动态控制工具可用性
- **别名归一化**：`Read` / `read_file` / `cat` 自动映射到同一工具

### 🔍 上下文感知

Lume 知道你在哪、在做什么：

- **工作区上下文**：自动加载项目的 `AGENTS.md`、`.context/` 目录
- **线程上下文**：每个对话线程有独立的临时记忆和文件目录
- **余光系统**：对话中穿插侧向观察和关联——不是必须的信息，而是真正有价值的洞察

### 🔌 多模型支持

通过 OpenAI 兼容接口支持多家模型提供商：

> OpenAI · Anthropic · DeepSeek · 智谱 (GLM) · 通义千问 · Google Gemini · 阶跃星辰 · 豆包 · Moonshot · 以及任何 OpenAI 兼容 API

---

## 架构

```
Lume
├── apps/
│   ├── desktop/          # Tauri 桌面端 (Rust)
│   ├── web/              # Vite + React 前端
│   └── sidecar/          # Bun 运行时（Agent 引擎 + 工具 + 记忆）
├── packages/
│   ├── sdk/              # @lume/agent-sdk — 开源 Agent SDK
│   ├── shared/           # 跨端共享类型和工具
│   ├── ui/               # 共享 UI 组件库
│   └── natives/          # Tauri 原生桥接
├── crates/               # Rust crates
│   ├── lume-ast/         # Markdown AST 处理
│   ├── lume-logger/      # 结构化日志
│   └── lume-natives/     # Tauri 原生命令
└── plugins/              # 外部插件
```

**技术栈**：Tauri 2 · React · TypeScript · Bun · Rust

---

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 20
- [Bun](https://bun.sh/) >= 1.0
- [Rust](https://www.rust-lang.org/tools/install) (for Tauri desktop)
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

### 安装

```bash
git clone https://github.com/CavinHuang/lume.git
cd lume
bun install
```

### 开发

```bash
# 启动前端开发服务器
bun dev

# 启动 Tauri 桌面端开发模式
bun tauri dev
```

### 构建

```bash
bun tauri build
```

---

## @lume/agent-sdk

Lume 的 Agent 引擎已作为独立 SDK 开源：

```typescript
import { AgentEngine } from '@lume/agent-sdk';

const engine = new AgentEngine({
  provider: 'openai',
  model: 'gpt-4o',
  tools: [/* your tools */],
});

const result = await engine.run('Analyze this codebase...');
```

完整的 Agent 循环——工具调用、上下文管理、流式输出——全在进程内完成，不需要本地 CLI。可以部署到任何地方：云端、Serverless、Docker、CI/CD。

---

## 配置

Lume 的全局配置入口：`~/.lume/lume.yaml`

```yaml
# 模型配置
models:
  default: openai/gpt-4o
  
# 工作区
workspaces:
  my-project:
    path: ~/projects/my-project
    context: .context/

# MCP 服务器
mcp:
  my-server:
    command: npx
    args: ["-y", "my-mcp-server"]
```

## 贡献

欢迎贡献！请阅读 [AGENTS.md](./AGENTS.md) 了解提交规范和工作协议。

### Commit 规范

所有 commit 遵循 Lore 协议：

```
✨ feat(web): 添加流式工具执行器
🐛 fix(sidecar): 修复子代理串行执行问题
♻️ refactor(sdk): 重构 provider 类型定义
```

---

## 致谢

Lume 的设计受到了许多优秀项目的启发：

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 工具调用和 Agent 编排的参考实现
- [Tauri](https://tauri.app/) — 优秀的跨平台桌面应用框架
- [OpenAI](https://openai.com/) / [Anthropic](https://www.anthropic.com/) / [智谱](https://www.zhipuai.cn/) — 模型提供商

---

<div align="center">

**Lume — 本地优先，记忆持久，属于你。**

[⭐ Star](https://github.com/CavinHuang/lume) · [🐛 Issue](https://github.com/CavinHuang/lume/issues) · [💬 Discussion](https://github.com/CavinHuang/lume/discussions)

</div>
