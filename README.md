<div align="center">
<img src="assets/lume-logo.png" width="180" height="180" alt="Lume Logo" />

# Lume

**本地 AI 工作台 — 有记忆、有主见、有工具能力。**

你的数据在你手上，你的助手为你工作。

</div>

---

## 为什么是 Lume

市面上的 AI 产品大多是这样的：打开浏览器 → 登录 → 对话 → 关闭 → 下次打开，一切从零开始。它不记得你昨天在做什么，不知道你的技术栈偏好，不能帮你操作文件系统，更不会在你睡觉的时候推进任何事。

Lume 不一样。它运行在你的电脑上，有持久记忆，有完整工具集，有性格鲜明的角色团队。它不是更好的聊天框——它是一个真正参与你工作流的伙伴。

**如果你想要的是一个会记住你、理解你、能动手干活的本地 AI 工作台，Lume 就是为此而生。**

---

## 设计理念

### 本地优先，数据属于你

这不是一句口号，而是架构层面的选择。Lume 的所有数据——记忆、对话历史、项目上下文、技能配置——都存在你本地的 `~/.lume/` 目录下。

Markdown 是真源，向量索引只是缓存。这意味着什么？你可以随时打开终端：

```bash
cat ~/.lume/memories/*.md
```

用纯文本读到 Lume 记住的关于你的一切。没有黑箱，没有云端数据库，没有"数据可能被用于训练"的焦虑。你的记忆就是一堆 Markdown 文件，你可以 grep 它、备份它、迁移它、甚至手动编辑它。

### 记忆是经验，不是数据库

大多数 AI 的"记忆"是最近几轮对话的上下文窗口。Lume 的记忆系统是结构化的、有层次的、像人的经验一样运作的。

Lume 区分六种记忆类型：

| 类型 | 含义 | 示例 |
|------|------|------|
| **fact** | 事实 | 用户的技术栈是 TypeScript + React |
| **preference** | 偏好 | 偏好简洁回复，不要废话 |
| **decision** | 决策 | 项目选了 Electron 作为桌面壳 |
| **lesson** | 教训 | 上次 CI 跑挂是因为忘了配置发布 token |
| **episode** | 场景 | 昨晚一起 review 了那块渲染性能代码 |
| **milestone** | 里程碑 | v0.1.0 发布了 |

这些记忆有三个层级——全局（global）、工作区（workspace）、线程（thread），在新对话中自然浮现。当 Lume 发现你又在纠结同一个技术选型时，它会主动提醒你上次为什么做了那个决定。

**记忆冲突不会被静默覆盖。** 两条矛盾的记忆会并存，由你来决定保留哪条。这很关键——因为不是所有信息都能用"最后写入者胜"来处理。

### 有主见的助手

Lume 不是中立的问答机器。它有自己的判断、偏好和风格。

你问它该选哪个方案，它会直接告诉你推荐哪个，为什么。你在代码里做了它认为有问题的设计，它会指出来。它在回复中会流露出自己的品味——不是因为被指示要"表现得有个性"，而是因为它的记忆里存着你过去的项目决策、你的技术偏好、你对某些方案的态度。

一个真正有用的助手不应该什么都对你说"好的，都可以"。它应该有立场。

### 工具不是装饰

很多 AI 产品号称"有工具调用能力"，实际上只接了 3 个玩具级 API。Lume 有一个完整的工具集——这不是营销话术，而是因为它真的需要这些工具来参与你的工作：

- **文件系统**：Read / Write / Edit / Glob / Grep / ls — 完整的文件操作
- **代码执行**：Bash，带超时控制和后台运行
- **LSP 代码智能**：go-to-definition、find-references、hover — 真正的代码理解
- **Office 文档**：docx / pptx / xlsx / pdf 的创建、编辑、格式转换、OOXML 解包修复
- **Web**：搜索、网页抓取、中文互联网搜索
- **图片生成**：文生图、参考图改风格、多模型对比
- **MCP 协议**：标准 Model Context Protocol 客户端，连接任何 MCP 服务器

这些工具不是展示用的列表。它们是 Lume 的手——没有这些手，"参与工作流"就是一句空话。

### 自我进化

Lume 的 Skill 系统不是静态的。它会分析使用中的失败模式，自动优化提示词，保留完整的版本历史，随时可以回滚。

这意味着 Lume 在变好——不是通过云端推送更新，而是通过你本地的使用模式学习。用得越多，它越懂你要什么。

### 上下文感知

Lume 知道你在哪、在做什么：

- **工作区上下文**：自动加载项目的 `AGENTS.md` 和 `.context/` 目录，理解项目约定
- **线程上下文**：每个对话线程有独立的临时记忆和文件目录
- **余光系统**：对话中穿插侧向观察——不是必须回答的信息，而是真正有价值的关联和洞察

---

## 核心特性

### 🧠 持久记忆系统

多层记忆架构，Markdown 真源 + 本地向量索引双重检索：

- **三层作用域**：global（跨工作区）、workspace（项目级）、thread（单次对话）
- **六种记忆类型**：fact / preference / decision / lesson / episode / milestone
- **结构化提取**：对话中自动识别并归类记忆
- **冲突保护**：矛盾记忆并存，由用户决定取舍
- **自然召回**：新对话中自动浮现相关记忆，不需要手动 @

### 🎭 NPC 角色团队

每个专业 Skill 背后都有一个有性格、有名字、有工作偏好的角色。他们不是换皮——每个角色都有独立的写作风格、思考方式和专业领域：

| 角色 | 英文名 | 职能 | 风格 |
|------|--------|------|------|
| **祁远** | Felix Qi | 开发者 | 需求先行、骨架验证、边界条件优先 |
| **江岚** | Rowan Jiang | 作家 | 结构优先、多版本交付、场景适配 |
| **唐栩** | Mason Tang | 分析师 | 定义先行、Python 可复现、三层结论 |
| **顾砚** | Milo Gu | 调研员 | 多源交叉验证、自动归档、结构化整合 |
| **白洛** | Lio Bai | 画师 | 提示词工程、风格一致性、多方向选择 |
| **林澄** | Nora Lin | 设计师 | 从设计到代码一手搞定 |
| **温序** | Wren Wen | 小说家 | 冷启动建档、有状态续写、伏笔追踪 |
| **许澄** | Clara Xu | 翻译官 | 自然流畅、术语管理、文化适配 |
| **宋澈** | Miles Song | 配音师 | 口播节奏、标注系统、多风格适配 |
| **阮知** | — | 文档工程师 | OOXML 全流程、格式转换、PDF 操作 |
| **纪衡** | — | 量化分析师 | 技术面分析、大盘研判 |

Lume 作为主线程协调者，理解任务需求后把工作分发给最合适的角色。当你需要写文章时，江岚接手；需要代码审查时，祁远上场；需要市场调研时，顾砚出动。

### ⚡ 27+ Skills 系统

开箱即用的专家团队，每个 Skill 是一个独立的 `SKILL.md` 提示词模板：

| 类别 | Skills |
|------|--------|
| **开发** | `agent-developer` · `code-review` · `explain-code` · `executing-plans` · `writing-plans` |
| **写作** | `agent-writer` · `agent-novelist` · `agent-translator` · `agent-voice` |
| **分析** | `agent-analyst` · `agent-quant` · `agent-researcher` |
| **创作** | `agent-artist` · `agent-designer` · `agent-docsmith` · `image-gen` |
| **知识** | `agent-wiki` · `brainstorming` · `find-skills` |
| **系统** | `lume-self-evolution` · `skill-creator` · `system-info` · `ui-stylist` |

所有 Skill 支持**热加载**——修改或添加 `SKILL.md` 即可即时生效，无需重启。配合自我进化机制，Skill 会越用越精准。

### 🔧 完整工具集

不是 3 个玩具 API，而是真正能干活的工具矩阵：

| 领域 | 工具 |
|------|------|
| **文件系统** | Read · Write · Edit · Glob · Grep · ls |
| **代码执行** | Bash（超时控制 + 后台运行） |
| **代码智能** | LSP — go-to-definition · find-references · hover · documentSymbol |
| **Agent 编排** | Agent（并行调度、子代理、隔离上下文） |
| **Office 文档** | docx / pptx / xlsx / pdf 创建与编辑 · OOXML 解包 / 打包 / 校验 / 修复 · 格式转换 |
| **记忆系统** | memory.search · memory.remember |
| **Web** | WebSearch · WebFetch · guanlan_search（中文互联网搜索） |
| **图片** | 文生图 · 参考图改风格 · 垫图 · 多模型对比 |
| **自动化** | automation_set · routine_read / trigger / update |
| **MCP** | 标准 Model Context Protocol 客户端 |

### 🛠️ 工具管理

精细化的工具治理，不是"全开"或"全关"的二选一：

- **可视化工具面板**：在设置页查看、搜索、启禁用所有工具
- **风险分级**：每个工具标注 `safe` / `moderate` / `destructive`
- **策略匹配**：按工作区和场景动态控制工具可用性
- **别名归一化**：`Read` / `read_file` / `cat` 自动映射到同一工具

### ⏰ 自动化与调度

Lume 可以在你不在的时候替你工作：

- **定时任务**：cron 表达式 + 预设频率（hourly / daily / weekly / monthly）
- **日程系统**：每天自动生成个性化日程，支持手动触发和调整
- **自动执行**：到点自动运行，结果推送到指定渠道

### 📚 微信读书集成

不是简单的同步，而是完整的阅读工作流：

- **数据接入**：书架同步、划线获取、想法/评论、阅读统计
- **智能笔记**：种子笔记 + 深度笔记两阶段生成管线
- **三源路由**：中文古诗词（今日诗词 API）→ 西方公版（Gutenberg）→ 现代书籍（微信读书）
- **进度追踪**：自动推进，完成后自动标记并选下一本
- **分享卡片**：一键生成精美读书笔记卡片

### 💬 IM 集成

通过 OpenClaw ILINK 协议接入微信，让 Lume 走进你的日常沟通：

- **微信对话**：在微信里直接和 Lume 对话
- **媒体发送**：发送生成的图片、文档、分析结果
- **消息路由**：微信消息自动绑定到工作区线程，上下文无缝衔接

### 🔌 多模型支持

通过 OpenAI 兼容接口，接入你选择的模型：

> OpenAI · Anthropic · Google Gemini · DeepSeek · 智谱 (GLM) · 通义千问 · 阶跃星辰 · 豆包 · Moonshot · 以及任何 OpenAI 兼容 API endpoint

支持为不同任务配置不同模型——用最强的模型做推理，用快的模型做日常对话。

### 🔍 上下文感知

- **工作区上下文**：自动加载 `AGENTS.md`、`.context/` 目录
- **线程上下文**：独立临时记忆和文件目录
- **余光系统**：对话中穿插侧向观察和关联洞察

---

## 架构概览

```
Lume
├── apps/
│   ├── desktop/              # Electron 桌面应用
│   ├── web/                  # Vite + React 前端
│   └── sidecar/              # Electron 子进程核心（Agent runtime + 工具 + 记忆 + IM）
├── packages/
│   ├── sdk/                  # @lume/agent-sdk — 可嵌入的 Agent SDK
│   ├── natives/              # @lume/natives — Rust N-API 性能模块加载器
│   ├── shared/               # 跨端共享类型和工具
│   └── ui/                   # 共享 UI 组件库
├── crates/
│   ├── lume-ast/             # Rust AST 摘要能力
│   └── lume-natives/         # 输出 .node 动态库，不是桌面 runtime
└── plugins/                  # 外部插件
```

**技术栈**：Electron 42.5.1 · React · TypeScript · Bun（包管理与构建）· Rust N-API（仅用于构建 `.node` 性能模块）

所有数据存储在 `~/.lume/` 目录下——记忆、对话、工作区配置、技能定义，全部是你可以直接读写的本地文件。

---

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 20
- [Bun](https://bun.sh/) >= 1.0
- [Rust](https://www.rust-lang.org/) stable（仅构建桌面 native 能力时需要）

### 安装

```bash
git clone https://github.com/CavinHuang/lume.git
cd lume
bun install
```

### 开发模式

```bash
# 同时启动前端 + 桌面端
bun dev
```

### 构建桌面应用

```bash
bun build:desktop
```

桌面版运行时仍只有 Electron。Rust 能力会构建为 `apps/desktop/resources/natives/<platform>-<arch>/lume-natives.node`，由 Electron UtilityProcess sidecar 通过 `LUME_NATIVES_PATH` 加载。

---

## Agent SDK

Lume 的 Agent 引擎已作为独立 SDK 开源，可以嵌入你自己的应用：

```typescript
import { AgentEngine } from '@lume/agent-sdk';

const engine = new AgentEngine({
  provider: 'openai',
  model: 'gpt-4o',
  tools: [/* your tools */],
});

const result = await engine.run('Analyze this codebase and summarize the architecture...');
```

完整的 Agent 循环——工具调用、上下文管理、流式输出——全在进程内完成，不需要本地 CLI。可以部署到任何地方：云端、Serverless、Docker、CI/CD。

---

## 配置

全局配置入口：`~/.lume/lume.yaml`

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

---

## 贡献

欢迎贡献！请阅读 [AGENTS.md](./AGENTS.md) 了解工作协议和提交规范。

Commit 遵循以下格式：

```
✨ feat(web): 添加流式工具执行器
🐛 fix(sidecar): 修复子代理串行执行问题
♻️ refactor(sdk): 重构 provider 类型定义
```

---

## License

[MIT](./LICENSE)

---

<div align="center">

**Lume — 本地优先，记忆持久，属于你。**

[⭐ Star](https://github.com/CavinHuang/lume) · [🐛 Issues](https://github.com/CavinHuang/lume/issues) · [💬 Discussions](https://github.com/CavinHuang/lume/discussions)

</div>
