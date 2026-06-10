# Codex CLI 插件机制设计与实现分析

> 调研日期：2026-06-10  
> 参考来源：OpenAI 官方文档、`openai/codex` GitHub 仓库源码

---

## 目录

1. [概览](#1-概览)
2. [仓库结构与核心模块](#2-仓库结构与核心模块)
3. [插件清单（Manifest）格式](#3-插件清单manifest格式)
4. [插件标识符系统](#4-插件标识符系统)
5. [插件构成的四要素](#5-插件构成的四要素)
6. [插件加载流程](#6-插件加载流程)
7. [运行时表示：LoadedPlugin](#7-运行时表示loadedplugin)
8. [Marketplace 市场系统](#8-marketplace-市场系统)
9. [插件 Store（磁盘布局）](#9-插件-store磁盘布局)
10. [插件管理器（PluginsManager）](#10-插件管理器pluginsmanager)
11. [CLI 命令](#11-cli-命令)
12. [插件注入模型上下文](#12-插件注入模型上下文)
13. [Hooks 生命周期系统](#13-hooks-生命周期系统)
14. [App-Server Protocol（v2 API）](#14-app-server-protocolv2-api)
15. [配置系统](#15-配置系统)
16. [架构总结与数据流](#16-架构总结与数据流)

---

## 1. 概览

Codex CLI 拥有一个**多层次、可扩展的插件系统**，作为可复用能力（Skills）、外部应用集成（Apps）和 MCP 服务器的**统一安装分发单元**。

系统围绕三个核心概念组织：

| 概念 | 说明 |
|---|---|
| **Plugins（插件）** | 打包 Skills、Hooks、MCP Servers、Apps 的可复用单元 |
| **Marketplaces（市场）** | JSON 目录，声明可用插件及其安装策略 |
| **Hooks（钩子）** | 生命周期事件处理器，可拦截并修改 Agent 行为 |

> 插件系统深度集成了 **Codex App Server Protocol v2**，对插件、市场提供了完整的 CRUD API。

---

## 2. 仓库结构与核心模块

**GitHub 仓库：** `https://github.com/openai/codex`

核心代码目录（Rust monorepo，工作空间名 `codex-rs`）：

| 目录 | 职责 |
|---|---|
| `codex-rs/plugin/src/` | 核心类型：`PluginId`、`LoadedPlugin`、`PluginLoadOutcome` |
| `codex-rs/core-plugins/src/` | 插件管理：Manifest 加载、Marketplace 解析、Store、Manager、远程 Bundle、分享 |
| `codex-rs/core/src/plugins/` | 核心集成：可发现插件、注入模型上下文、渲染、提及语法 |
| `codex-rs/hooks/src/` | Hook 引擎：发现、分发、命令执行器、事件、Schema |
| `codex-rs/cli/src/plugin_cmd.rs` | CLI 命令：`codex plugin add/list/remove` |
| `codex-rs/cli/src/marketplace_cmd.rs` | CLI 命令：`codex plugin marketplace add/list/upgrade/remove` |
| `codex-rs/app-server-protocol/` | TypeScript + JSON Schema 类型定义（v2 API） |
| `codex-rs/app-server/src/request_processors/plugins.rs` | App Server 插件操作的请求处理器 |
| `codex-rs/utils/plugins/src/` | 共享工具：插件命名空间解析、提及语法、MCP 连接器 |
| `codex-rs/skills/src/assets/samples/plugin-creator/` | `@plugin-creator` Skill — 脚手架新插件 |

---

## 3. 插件清单（Manifest）格式

每个插件必须在根目录下包含 `.codex-plugin/plugin.json` 清单文件（也兼容 `.claude-plugin/plugin.json`）：

```jsonc
{
  "name": "plugin-name",              // kebab-case，必填
  "version": "1.2.0",                 // semver
  "description": "插件描述",
  "keywords": ["api-key", "dev-tools"],
  "author": "Author Name",
  "homepage": "https://...",
  "repository": "https://...",
  "license": "MIT",

  // 组件引用路径（相对插件根目录，必须以 ./ 开头）
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",

  // 安装表面的展示元数据
  "interface": {
    "displayName": "插件展示名称",
    "shortDescription": "简短描述",
    "longDescription": "详细描述",
    "category": "Productivity",       // 分类
    "capabilities": ["Interactive", "Write"],
    "brandColor": "#3B82F6",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "screenshots": ["./assets/screenshot1.png"],
    "developerName": "OpenAI",
    "websiteURL": "https://openai.com/",
    "privacyPolicyURL": "https://...",
    "termsOfServiceURL": "https://..."
  }
}
```

**关键约束：**
- 所有路径必须相对插件根目录，且以 `./` 开头
- 路径不得超出插件目录边界（安全沙箱）
- `name` 仅允许 ASCII 字母、数字、`_`、`-`，最长 64 字符

> 源码：`codex-rs/core-plugins/src/manifest.rs` → `load_plugin_manifest()`

---

## 4. 插件标识符系统

插件使用**双命名空间**标识符：

```
<plugin-name>@<marketplace-name>
```

例如：`linear@openai-curated`、`my-plugin@personal`

### Rust 实现（`codex-rs/plugin/src/plugin_id.rs`）

```rust
pub struct PluginId {
    pub plugin_name: String,
    pub marketplace_name: String,
}

impl PluginId {
    pub fn parse(plugin_key: &str) -> Result<Self, PluginIdError> {
        // 从最后一个 '@' 处分割
        let Some((plugin_name, marketplace_name)) = plugin_key.rsplit_once('@') else {
            return Err(PluginIdError::MissingAtSign);
        };
        // 两段都必须非空，且仅包含 ASCII 字母、数字、_、-
    }

    pub fn as_key(&self) -> String {
        format!("{}@{}", self.plugin_name, self.marketplace_name)
    }
}
```

**验证规则：**
- 两段都必须非空
- 仅允许 ASCII alphanumeric + `_` + `-`
- 插件名最大长度 64 字符

---

## 5. 插件构成的四要素

一个插件可以包含最多四种组件类型：

### 5.1 Skills（技能）

- 位于 `skills/<skill-name>/SKILL.md`
- 每个 Skill 是包含 `name` 和 `description` frontmatter 的 Markdown 文件 + 指令内容
- 来自插件的 Skill 会用插件的 display name 作为前缀进行命名空间隔离（如 `MyPlugin:my-skill`）
- 系统通过向上查找祖先目录中的 `.codex-plugin/plugin.json` 来发现 Skill

### 5.2 Hooks（钩子）

- 位于 `hooks/hooks.json`，或直接内联在 manifest 中
- 接收环境变量 `PLUGIN_ROOT` 和 `PLUGIN_DATA`（以及兼容别名 `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`）
- 支持 **10 个生命周期事件**：

```rust
pub const HOOK_EVENT_NAMES: [&str; 10] = [
    "PreToolUse", "PermissionRequest", "PostToolUse",
    "PreCompact", "PostCompact",
    "SessionStart", "UserPromptSubmit",
    "SubagentStart", "SubagentStop", "Stop",
];
```

- Hook 作为外部命令执行，通过 JSON 输出控制行为（阻塞/放行/修改输入）
- 详见 [第 13 节](#13-hooks-生命周期系统)

### 5.3 MCP Servers

- 配置文件：`.mcp.json`（支持直接 server map 或包裹在 `mcpServers` 对象中）
- 安装后，用户可通过 `config.toml` 控制每个 bundled server 的启用/禁用
- 支持 tool-level 审批策略（auto/prompt/approve）

### 5.4 Apps（应用连接器）

- 配置文件：`.app.json`
- 定义与外部服务的连接映射（GitHub、Slack、Google Drive 等）

### 能力汇总类型

```rust
pub struct PluginCapabilitySummary {
    pub config_name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub has_skills: bool,
    pub mcp_server_names: Vec<String>,
    pub app_connector_ids: Vec<AppConnectorId>,
}
```

---

## 6. 插件加载流程

```
Marketplace JSON (local / Git / remote)
        │
        ▼
PluginsManager.resolve_marketplaces()
        │
        ▼
PluginsManager.load_plugins()
        │
        ▼
PluginLoadOutcome  ──┬── Skill roots ──→ Skill loader ──→ 注入模型上下文
                     ├── MCP servers ──→ MCP 连接管理器
                     ├── App connectors ──→ 连接器系统
                     └── Hook sources ──→ Hooks 引擎
```

1. **解析 Marketplaces** — 从本地路径、Git 仓库或远程目录加载 marketplace JSON
2. **加载插件** — 根据 marketplace 中声明的 source 从插件 Store 读取插件文件
3. **解析 Manifest** — 调用 `load_plugin_manifest()` 读取 `.codex-plugin/plugin.json`
4. **收集组件** — 扫描 skills/、hooks/、.mcp.json、.app.json
5. **聚合输出** — 产生 `PluginLoadOutcome`，包含所有已加载插件的合并能力

---

## 7. 运行时表示：LoadedPlugin

插件从磁盘加载后，在运行时表示为：

```rust
pub struct LoadedPlugin<M> {
    pub config_name: String,              // "plugin-name@marketplace-name"
    pub manifest_name: Option<String>,
    pub manifest_description: Option<String>,
    pub root: AbsolutePathBuf,            // 插件在磁盘上的根路径
    pub enabled: bool,
    pub skill_roots: Vec<AbsolutePathBuf>,
    pub disabled_skill_paths: HashSet<AbsolutePathBuf>,
    pub has_enabled_skills: bool,
    pub mcp_servers: HashMap<String, M>,  // M = McpServerConfig
    pub apps: Vec<AppConnectorId>,
    pub hook_sources: Vec<PluginHookSource>,
    pub hook_load_warnings: Vec<String>,
    pub error: Option<String>,
}
```

`PluginLoadOutcome<M>` 聚合所有已加载插件，提供：

| 方法 | 说明 |
|---|---|
| `effective_skill_roots()` | 所有活跃插件的合并 Skill 目录 |
| `effective_mcp_servers()` | 所有插件的合并 MCP 服务器配置 |
| `effective_apps()` | 所有插件的合并 App 连接器 ID |
| `effective_plugin_hook_sources()` | 所有插件的 Hook 定义 |

---

## 8. Marketplace 市场系统

Marketplace 是 JSON 目录，声明可用插件及其安装/认证策略。

### 8.1 文件位置

```
<marketplace-root>/.agents/plugins/marketplace.json    # 新标准位置
<marketplace-root>/.claude-plugin/marketplace.json     # 兼容位置
```

支持三种来源类型：

| 来源 | 配置示例 |
|---|---|
| **本地路径** | `~/.agents/plugins/marketplace.json`（个人）、`.agents/plugins/marketplace.json`（项目） |
| **Git 仓库** | `owner/repo`、HTTPS URL、SSH URL，支持 sparse checkout |
| **远程目录** | OpenAI 官方精选（`REMOTE_GLOBAL_MARKETPLACE_NAME`） |

### 8.2 Marketplace JSON 结构

```jsonc
{
  "name": "openai-curated",
  "interface": {
    "displayName": "ChatGPT 官方精选"
  },
  "plugins": [
    {
      "name": "linear",
      "source": {
        "source": "local",           // 或 "git" / "remote"
        "path": "./plugins/linear"   // Git 支持 path/ref_name/sha
      },
      "policy": {
        "installation": "AVAILABLE",       // 或 NOT_AVAILABLE / INSTALLED_BY_DEFAULT
        "authentication": "ON_INSTALL"     // 或 ON_USE
      },
      "category": "Productivity"
    }
  ]
}
```

### 8.3 安装策略枚举

```rust
pub enum MarketplacePluginInstallPolicy {
    NotAvailable,           // 用户不可安装
    Available,              // 可安装（默认）
    InstalledByDefault,     // 随 Codex 默认安装
}

pub enum MarketplacePluginAuthPolicy {
    OnInstall,  // 安装时认证（默认）
    OnUse,      // 首次使用时认证
}
```

---

## 9. 插件 Store（磁盘布局）

插件安装后存储在用户目录下的固定位置：

```
~/.codex/plugins/cache/<marketplace-name>/<plugin-name>/<version>/
~/.codex/plugins/data/<plugin-name>-<marketplace-name>/
```

- **cache 目录**：插件文件的实际存储
- **data 目录**：插件的运行时数据（如 Hook 缓存、认证状态）
- 本地插件的版本为 `local`
- 系统通过 semver 排序选择"活跃版本"，支持 `local` 软链接目标

---

## 10. 插件管理器（PluginsManager）

`PluginsManager`（`codex-rs/core-plugins/src/manager.rs`）是插件系统的中央编排器：

| 职责 | 说明 |
|---|---|
| 加载插件 | 从已配置的市场加载所有插件 |
| 安装/卸载 | 管理插件的生命周期 |
| 同步/升级 | 管理 Git marketplace 快照的更新 |
| Store 管理 | 管理插件在磁盘上的存储 |
| 策略执行 | 处理 `INSTALLED_BY_DEFAULT` 等策略 |
| 跟踪详情 | 维护插件的 Skills、Hooks、MCP Servers、Apps 信息 |

---

## 11. CLI 命令

### 插件管理

```bash
codex plugin add <PLUGIN[@MARKETPLACE]>          # 安装插件
codex plugin list [--marketplace NAME] [--available] [--json]  # 列出插件
codex plugin remove <PLUGIN[@MARKETPLACE]>       # 卸载插件
```

### Marketplace 管理

```bash
codex plugin marketplace add <SOURCE>            # 添加市场
# SOURCE 可以是：本地路径、Git URL (owner/repo 或完整 URL)
codex plugin marketplace list [--json]           # 列出市场
codex plugin marketplace upgrade [NAME]          # 刷新 Git 市场快照
codex plugin marketplace remove <NAME>           # 移除市场
```

**示例：**

```bash
# 安装插件
codex plugin add sample@debug
codex plugin add sample --marketplace debug

# 添加 Git 市场
codex plugin marketplace add owner/repo --ref main
codex plugin marketplace add https://github.com/owner/repo --sparse plugins/foo
```

---

## 12. 插件注入模型上下文

当用户在对话中通过 `@` 语法显式提及插件时，其能力被注入为系统消息：

```rust
// codex-rs/core/src/plugins/injection.rs
pub(crate) fn build_plugin_injections(
    mentioned_plugins: &[PluginCapabilitySummary],
    mcp_tools: &[ToolInfo],
    available_connectors: &[connectors::AppInfo],
) -> Vec<ResponseItem> {
    // 渲染类似以下的指令：
    // "Capabilities from the `PluginName` plugin:
    //  - Skills from this plugin are prefixed with `PluginName:`.
    //  - MCP servers from this plugin available in this session: `server1`, `server2`.
    //  - Apps from this plugin available in this session: `github`.
    //  Use these plugin-associated capabilities to help solve the task."
}
```

**提及语法：** 插件使用 `@` 作为提及标记（`codex-rs/utils/plugins/src/mention_syntax.rs`）

```rust
pub const PLUGIN_TEXT_MENTION_SIGIL: char = '@';
```

此外，系统还通过 `request_plugin_install` 工具在适当时机**主动建议用户安装插件**。

---

## 13. Hooks 生命周期系统

Hooks 是独立的扩展机制，实现为单独的 crate（`codex-rs/hooks/`）。

### 架构

```
Hook 发现（扫描配置层 + 插件 Hook 源）
        │
        ▼
ClaudeHooksEngine（运行 ConfiguredHandler 实例）
        │
        ▼
CommandShell（外部命令执行 + JSON 输出解析）
        │
        ▼
Typed Outcome（per-event 类型化结果）
```

### 10 个生命周期事件

| 事件 | 触发时机 | 可执行操作 |
|---|---|---|
| `PreToolUse` | Tool 执行前 | 阻塞 / 放行 / 修改输入 |
| `PostToolUse` | Tool 执行后 | 添加反馈/上下文 |
| `PermissionRequest` | 权限请求时 | 批准 / 拒绝 |
| `PreCompact` | 上下文压缩前 | 修改 / 注入 |
| `PostCompact` | 上下文压缩后 | 修改 / 注入 |
| `SessionStart` | 会话启动 | 初始化 / 注入 |
| `UserPromptSubmit` | 用户提交 Prompt | 拦截 / 修改 |
| `SubagentStart` | 子 Agent 启动 | 注入 / 监控 |
| `SubagentStop` | 子 Agent 停止 | 清理 / 总结 |
| `Stop` | 会话停止 | 清理 / 持久化 |

### Hook 输出契约

```rust
// 阻塞工具执行
// 方式 1: 退出码 2 + stderr 包含阻塞原因
// 方式 2: 退出码 0 + JSON: { "permissionDecision": "deny" }

// 允许并修改工具输入
// 退出码 0 + JSON: { "permissionDecision": "allow", "updatedInput": {...} }

// 非 JSON stdout 被忽略（静默）
```

---

## 14. App-Server Protocol（v2 API）

插件系统通过 App Server Protocol 对外暴露完整 API，类型定义使用 TypeScript（通过 `ts-rs` 从 Rust 自动生成）。

### 核心 API 操作

| 操作 | 请求类型 | 响应类型 |
|---|---|---|
| 列出插件 | `PluginListParams` | `PluginListResponse` |
| 读取插件详情 | `PluginReadParams` | `PluginReadResponse` |
| 安装插件 | `PluginInstallParams` | `PluginInstallResponse` |
| 卸载插件 | `PluginUninstallParams` | `PluginUninstallResponse` |
| 添加市场 | `MarketplaceAddParams` | `MarketplaceAddResponse` |
| 列出市场 | (无) | `MarketplaceListResponse` |
| 升级市场 | `MarketplaceUpgradeParams` | `MarketplaceUpgradeResponse` |
| 移除市场 | `MarketplaceRemoveParams` | `MarketplaceRemoveRemoveResponse` |
| 分享插件 | `PluginShare*` 系列 | `PluginShare*` 系列（save/update/list/checkout/delete） |

---

## 15. 配置系统

### 15.1 插件配置（`~/.codex/config.toml`）

```toml
# 启用/禁用插件
[plugins."plugin-name@marketplace-name"]
enabled = true

# 插件 MCP 服务器精细化控制
[plugins."plugin-name@marketplace-name".mcp_servers."server-name"]
enabled = true
enabled_tools = ["tool1", "tool2"]
disabled_tools = ["tool3"]
default_tools_approval_mode = "prompt"

# 单个 Tool 的审批策略覆盖
[plugins."plugin-name@marketplace-name".mcp_servers."server-name".tools."tool-name"]
approval_mode = "approve"
```

### 15.2 自定义市场配置

```toml
[marketplaces."my-marketplace"]
source_type = "local"  # 或 "git"
source = "/path/to/marketplace"
```

### 15.3 Hooks 配置

```toml
# 启用 Hooks 功能
features.hooks = true

# 定义生命周期 Hook
[hooks.PreToolUse]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/path/to/hook_script.py"
timeout = 30
statusMessage = "Checking..."
```

### 15.4 Skills 配置

```toml
[skills.config]
[[skills.config]]
enabled = true
path = "/path/to/skill/folder"
```

---

## 16. 架构总结与数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Marketplace Sources                          │
│   ┌──────────┐  ┌─────────────┐  ┌──────────────────────────────┐  │
│   │ 本地路径  │  │ Git 仓库    │  │ 远程目录 (OpenAI 精选)        │  │
│   └────┬─────┘  └──────┬──────┘  └──────────────┬───────────────┘  │
│        │               │                        │                   │
└────────┼───────────────┼────────────────────────┼───────────────────┘
         │               │                        │
         ▼               ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     PluginsManager                                  │
│                                                                     │
│  1. resolve_marketplaces()  →  Marketplace 条目                      │
│  2. load_plugins()          →  PluginLoadOutcome                    │
│  3. manage lifecycle (sync/upgrade/store)                            │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
┌─────────────────┐ ┌─────────────┐ ┌──────────────────┐
│   Skill Roots    │ │ MCP Servers │ │  App Connectors  │
│   (技能注入)      │ │ (工具扩展)   │ │  (外部集成)       │
└────────┬────────┘ └──────┬──────┘ └────────┬─────────┘
         │                 │                    │
         ▼                 ▼                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Agent Runtime                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Model Context│  │ Tool Executor│  │ Hooks Engine          │  │
│  │ (Skills注入) │  │ (MCP Tools)  │  │ (10个生命周期事件)     │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 关键设计模式总结

| 模式 | 说明 |
|---|---|
| **双命名空间 ID** | `<plugin>@<marketplace>` 避免命名冲突，支持多源插件 |
| **Manifest 驱动** | 一个 JSON 文件声明所有组件，降低配置复杂度 |
| **分层配置** | User / Project / Session / Plugin 多层配置叠加 |
| **能力聚合** | `PluginLoadOutcome` 将所有插件能力合并后统一注入运行时 |
| **显式提及激活** | `@plugin-name` 语法让模型按需激活插件能力 |
| **外部命令 Hook** | 通过 stdout/stderr/exit code 控制 Agent 行为的沙箱机制 |
| **市场策略** | 支持 NOT_AVAILABLE / AVAILABLE / INSTALLED_BY_DEFAULT 三级策略 |
| **App Server v2** | 完整的 JSON-RPC API 支持 GUI/IDE 集成 |

---

## 附：插件创建工具

Codex 内置 `@plugin-creator` Skill，提供脚手架工具：

```bash
# 快速创建基础插件
python3 scripts/create_basic_plugin.py my-plugin --with-marketplace

# 完整插件（含所有组件）
python3 scripts/create_basic_plugin.py my-plugin \
  --with-skills --with-hooks --with-scripts \
  --with-assets --with-mcp --with-apps --with-marketplace

# 验证插件
python3 scripts/validate_plugin.py <plugin-path>

# 更新 cachebuster（本地开发）
python3 scripts/update_plugin_cachebuster.py <plugin-path>

# 重新安装
codex plugin add my-plugin@personal
```

---

## 参考链接

- 官方插件概览：https://developers.openai.com/codex/plugins
- 构建插件指南：https://developers.openai.com/codex/plugins/build
- 配置参考：https://developers.openai.com/codex/config-reference
- GitHub 仓库：https://github.com/openai/codex
