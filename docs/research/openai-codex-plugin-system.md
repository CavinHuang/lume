# OpenAI Codex 插件系统设计分析

> 基于 [官方文档](https://developers.openai.com/codex/plugins)、[Build Plugins](https://developers.openai.com/codex/plugins/build)、[Skills 文档](https://developers.openai.com/codex/skills) 和 [GitHub 仓库](https://github.com/openai/codex) 整理，日期：2026-06-09

---

## 1. 核心设计理念

Codex 插件是一个**可分发的打包单元**，将三类能力捆绑在一起：

| 组件 | 作用 |
|---|---|
| **Skills（技能）** | 可复用的工作流指令，用 Markdown 编写，告诉 Codex 如何执行特定任务 |
| **Apps（应用集成）** | 连接外部工具（GitHub、Slack、Gmail、Google Drive 等）的认证和操作 |
| **MCP Servers** | 通过 Model Context Protocol 提供额外工具或共享信息的本地/远程服务 |

**关键设计思想**：Skills 是"工作流的编写格式"，Plugins 是"可安装的分发单元"。先在单个 repo 用 Skill 迭代，成熟后打包成 Plugin 分享。

---

## 2. 插件目录结构

```
my-plugin/
├── .codex-plugin/
│   └── plugin.json          # 必需：插件清单（manifest）
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md         # 技能定义（必需：name + description + 指令）
│       ├── scripts/         # 可选：可执行脚本
│       ├── references/      # 可选：参考文档
│       ├── assets/          # 可选：模板资源
│       └── agents/
│           └── openai.yaml  # 可选：UI 元数据、调用策略、工具依赖
├── hooks/
│   └── hooks.json           # 可选：生命周期钩子
├── .app.json                # 可选：应用/连接器映射
├── .mcp.json                # 可选：MCP 服务器配置
└── assets/                  # 可选：图标、Logo、截图
```

---

## 3. Plugin Manifest（`plugin.json`）完整字段

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Bundle reusable skills and app integrations.",
  "author": {
    "name": "Your team",
    "email": "team@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://example.com/plugins/my-plugin",
  "repository": "https://github.com/example/my-plugin",
  "license": "MIT",
  "keywords": ["research", "crm"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "Reusable skills and apps",
    "longDescription": "Distribute skills and app integrations together.",
    "developerName": "Your team",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": [
      "Use My Plugin to summarize new CRM notes.",
      "Use My Plugin to triage new customer follow-ups."
    ],
    "brandColor": "#10A37F",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "screenshots": ["./assets/screenshot-1.png"]
  }
}
```

**Manifest 三大职责**：
1. **Identify**：标识插件（name, version, description）
2. **Point to components**：指向捆绑组件（skills, apps, mcpServers, hooks）
3. **Install-surface metadata**：安装界面展示信息（interface 对象）

**路径规则**：
- 所有路径相对于插件根目录，以 `./` 开头
- 视觉资源放在 `./assets/` 下
- 只有 `plugin.json` 放在 `.codex-plugin/` 目录内

---

## 4. Skills（技能系统）

Skill 是 Markdown 文件，使用**渐进式披露（Progressive Disclosure）**管理上下文：

```markdown
---
name: skill-name
description: 何时触发此技能的精确描述
---

Codex 应遵循的具体指令步骤。
```

### 4.1 激活方式

- **显式调用**：`/skills` 列表选择，或 `$skill-name` 直接引用
- **隐式调用**：Codex 根据用户任务匹配 `description` 自动选择

### 4.2 作用域层级

| 作用域 | 路径 | 用途 |
|---|---|---|
| `REPO` | `$CWD/.agents/skills` | 当前目录级，适用于特定模块/微服务 |
| `REPO` | `$CWD/../.agents/skills` | 父目录级 |
| `REPO` | `$REPO_ROOT/.agents/skills` | 仓库根级，所有人共享 |
| `USER` | `$HOME/.agents/skills` | 用户个人级，跨仓库通用 |
| `ADMIN` | `/etc/codex/skills` | 机器级共享 |
| `SYSTEM` | 内置 | OpenAI 预装（如 skill-creator, plan） |

### 4.3 上下文预算

- 技能列表约占模型上下文窗口的 **2%**（未知窗口大小时上限 8000 字符）
- 超出时会缩短描述，甚至省略部分技能
- 选中技能后仍会加载完整的 `SKILL.md` 指令

### 4.4 UI 元数据配置（`agents/openai.yaml`）

```yaml
interface:
  display_name: "Optional user-facing name"
  short_description: "Optional user-facing description"
  icon_small: "./assets/small-logo.svg"
  icon_large: "./assets/large-logo.png"
  brand_color: "#3B82F6"
  default_prompt: "Optional surrounding prompt to use the skill with"

policy:
  allow_implicit_invocation: false  # 设为 false 时只能显式调用

dependencies:
  tools:
    - type: "mcp"
      value: "openaiDeveloperDocs"
      description: "OpenAI Docs MCP server"
      transport: "streamable_http"
      url: "https://developers.openai.com/mcp"
```

### 4.5 快速创建工具

- `$skill-creator`：内置技能创建器，交互式引导
- `$skill-installer`：从仓库安装技能，如 `$skill-installer linear`

---

## 5. MCP Server 配置

### 5.1 插件捆绑格式

`.mcp.json` 支持两种格式：

**直接格式**：
```json
{
  "docs": {
    "command": "docs-mcp",
    "args": ["--stdio"]
  }
}
```

**包装格式**：
```json
{
  "mcp_servers": {
    "docs": {
      "command": "docs-mcp",
      "args": ["--stdio"]
    }
  }
}
```

### 5.2 安装后用户级配置

用户可在 `~/.codex/config.toml` 中细粒度控制每个插件的 MCP 服务器：

```toml
[plugins."my-plugin".mcp_servers.docs]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["search"]

[plugins."my-plugin".mcp_servers.docs.tools.search]
approval_mode = "approve"
```

### 5.3 全局 MCP 配置

MCP 配置存储在 `~/.codex/config.toml`。CLI 命令：
- `codex mcp add`：添加 stdio 类型 MCP 服务器
- HTTP/streamable 类型需直接编辑 `config.toml`

---

## 6. 生命周期钩子（Hooks）

### 6.1 默认钩子文件

`hooks/hooks.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${PLUGIN_ROOT}/hooks/session_start.py",
            "statusMessage": "Loading plugin context"
          }
        ]
      }
    ]
  }
}
```

### 6.2 安全机制

- 安装/启用插件**不会**自动信任其钩子
- 插件钩子属于 non-managed hooks，用户需手动审核并信任
- 环境变量：`PLUGIN_ROOT`（插件根目录）、`PLUGIN_DATA`（可写数据目录）
- 兼容变量：`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`

### 6.3 Manifest 中配置钩子

`hooks` 字段可以是单个路径、路径数组、内联对象或内联对象数组：

```json
{
  "name": "repo-policy",
  "hooks": ["./hooks/session.json", "./hooks/tools.json"]
}
```

---

## 7. Marketplace（分发市场）

### 7.1 市场文件位置

| 类型 | 路径 |
|---|---|
| 仓库级 | `$REPO_ROOT/.agents/plugins/marketplace.json` |
| 兼容 Claude | `$REPO_ROOT/.claude-plugin/marketplace.json` |
| 个人级 | `~/.agents/plugins/marketplace.json` |

### 7.2 市场文件格式

```json
{
  "name": "local-example-plugins",
  "interface": {
    "displayName": "Local Example Plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/my-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

### 7.3 分发源类型

| 类型 | source 值 | 说明 |
|---|---|---|
| 本地目录 | `"local"` | `path` 指向本地目录 |
| Git 子目录 | `"git-subdir"` | `url` + `path` + `ref` |
| Git 仓库根 | `"url"` | 直接指向仓库 |
| GitHub 简写 | — | `owner/repo` 或 `owner/repo@ref` |

Git-backed 示例：

```json
{
  "name": "remote-helper",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/example/codex-plugins.git",
    "path": "./plugins/remote-helper",
    "ref": "main"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Productivity"
}
```

### 7.4 CLI 管理

```bash
# 添加市场源
codex plugin marketplace add owner/repo
codex plugin marketplace add owner/repo --ref main
codex plugin marketplace add https://github.com/example/plugins.git --sparse .agents/plugins
codex plugin marketplace add ./local-marketplace-root

# 管理
codex plugin marketplace list
codex plugin marketplace upgrade
codex plugin marketplace upgrade marketplace-name
codex plugin marketplace remove marketplace-name
```

### 7.5 安装位置

插件安装到：`~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`

本地插件版本号为 `local`，Codex 从缓存路径加载。

### 7.6 插件启用/禁用

在 `~/.codex/config.toml` 中控制：

```toml
[plugins."gmail@openai-curated"]
enabled = false
```

### 7.7 Workspace 分享

在 Codex App 中可以分享插件给 workspace 成员：
1. 打开 Plugins → Created by you
2. 选择 Share，添加成员/组或复制分享链接

管理员可通过 `requirements.toml` 禁用分享：`plugin_sharing = false`

---

## 8. 插件能做什么——总结

| 能力 | 说明 |
|---|---|
| **扩展工作流** | 通过 Skills 定义特定任务的标准操作步骤 |
| **连接外部服务** | 通过 Apps 接入 GitHub/Slack/Gmail/Google Drive/Linear 等 |
| **提供工具** | 通过捆绑的 MCP Server 暴露自定义工具给 Codex 调用 |
| **自动化初始化** | 通过 Hooks 在会话启动、工具调用等时机执行脚本 |
| **团队标准化** | 打包后通过 Marketplace 分发，团队成员一键安装 |
| **跨平台可用** | 同时支持 Codex App、CLI、VS Code 扩展 |
| **细粒度权限控制** | 每个插件的 MCP 服务器、工具都可以单独启用/禁用/审批 |

### 已有的官方插件示例（20+）

- **Codex Security**：扫描授权代码，确认漏洞，准备修复
- **Gmail**：读取和管理 Gmail 邮件
- **Google Drive**：跨 Drive、Docs、Sheets、Slides 工作
- **Slack**：总结频道或起草回复
- **GitHub**：PR 管理、Issue 跟踪
- **Linear**：项目管理
- **Build Web App**：捆绑 Stripe + Supabase + Vercel MCP 服务器 + 部署技能

---

## 9. 与 Claude Code / Gemini CLI 的对比

据 [The New Stack](https://thenewstack.io/openais-codex-gets-plugins/) 报道，三家主要 AI 编码助手的插件架构高度相似：

| 特性 | Codex | Claude Code | Gemini CLI |
|---|---|---|---|
| 包内容 | Skills + MCP + Apps + Hooks | Skills + MCP + Hooks + Slash Commands | MCP + Commands + Skills + Hooks |
| 清单格式 | `.codex-plugin/plugin.json` | YAML frontmatter | 类似 manifest |
| 市场 | 官方目录 + Repo/个人市场 | 内置市场 + Repo/个人市场 | GitHub/内置注册表 |
| 跨工具复用 | 支持 `@plugin-creator` 迁移 | 支持 | 支持 |
| 兼容性 | 支持 `.claude-plugin/` 路径 | 原生 | — |

Codex 明确提到可以从其他生态系统的插件迁移过来，并兼容 `.claude-plugin/marketplace.json` 路径，显示出三家在插件格式上的趋同。

---

## 10. 快速创建流程

### 使用 `@plugin-creator`

最快速的方式，自动生成脚手架：

```
@plugin-creator
```

它会：
1. 生成 `.codex-plugin/plugin.json` 清单
2. 可选生成本地 marketplace 条目用于测试
3. 已有插件文件夹也可以用来连接到本地市场

### 手动创建最小插件

```bash
# 1. 创建目录结构
mkdir -p my-first-plugin/.codex-plugin
mkdir -p my-first-plugin/skills/hello

# 2. 编写 manifest
cat > my-first-plugin/.codex-plugin/plugin.json << 'EOF'
{
  "name": "my-first-plugin",
  "version": "1.0.0",
  "description": "Reusable greeting workflow",
  "skills": "./skills/"
}
EOF

# 3. 编写技能
cat > my-first-plugin/skills/hello/SKILL.md << 'EOF'
---
name: hello
description: Greet the user with a friendly message.
---

Greet the user warmly and ask how you can help.
EOF

# 4. 添加到市场（repo 或个人）
# 编辑 $REPO_ROOT/.agents/plugins/marketplace.json 或 ~/.agents/plugins/marketplace.json
```

---

## Sources

- [Plugins – Codex | OpenAI Developers](https://developers.openai.com/codex/plugins)
- [Build plugins – Codex | OpenAI Developers](https://developers.openai.com/codex/plugins/build)
- [Agent Skills – Codex | OpenAI Developers](https://developers.openai.com/codex/skills)
- [Model Context Protocol – Codex | OpenAI Developers](https://developers.openai.com/codex/mcp)
- [Hooks – Codex | OpenAI Developers](https://developers.openai.com/codex/hooks)
- [OpenAI's Codex gets plugins - The New Stack](https://thenewstack.io/openais-codex-gets-plugins/)
- [openai/codex - GitHub](https://github.com/openai/codex)
- [openai/codex-plugin-cc - GitHub](https://github.com/openai/codex-plugin-cc)
