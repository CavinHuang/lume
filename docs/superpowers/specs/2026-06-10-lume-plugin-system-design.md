# Lume 插件系统设计

Date: 2026-06-10  
Status: Approved for implementation planning  
Scope: 插件 manifest 格式、Codex 适配器、权限系统、安装/加载生命周期

## 1. 设计目标

- 为 Lume 建立原生插件系统，复用已有 Skills、Hooks、MCP 基础设施
- 安装后 Codex 插件完全透明，用户感知为"Lume 插件"
- 设计阶段定稿权限系统，包括字段定义、默认值、运行时执行逻辑

## 2. 架构概览

```
Codex 插件仓库（.codex-plugin/plugin.json）
        │
        ▼  CodexAdapter（安装时一次性转换）
Lume 插件（lume-plugin.json）
        │
        ▼  PluginManager 加载
┌─────────────────────────────────────────────────────┐
│  已有 Lume 基础设施                                  │
│  registerSkill / HookRegistry / McpClientManager    │
│  CanUseToolFn / PermissionMode / PermissionUpdate   │
└─────────────────────────────────────────────────────┘
```

**设计决策：** Lume 原生格式 + Codex 适配器层。适配器在安装时单向转换，之后所有生命周期走 Lume 原生路径。安装后不保留来源标记。

## 3. Lume 原生 Manifest 格式

文件：`lume-plugin.json`，位于插件根目录。

```json
{
  "schema": "lume-plugin/v1",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者",
  "displayName": "展示名称",
  "category": "Productivity",
  "skills": ["./skills/"],
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./mcp.json",
  "permissions": { ... },
  "lume": {
    "hooksOnly": false,
    "exclusivePermissions": false
  }
}
```

### 3.1 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | string | 是 | 固定值 `"lume-plugin/v1"` |
| `name` | string | 是 | kebab-case，ASCII 字母数字+`_`+`-`，最长 64 字符 |
| `version` | string | 是 | semver |
| `description` | string | 否 | 插件描述 |
| `author` | string | 否 | 作者 |
| `displayName` | string | 否 | 展示名称，用于 UI 和 context 注入前缀 |
| `category` | string | 否 | 分类标签 |
| `skills` | string[] | 否 | 技能目录路径列表，相对于插件根目录 |
| `hooks` | string | 否 | hooks 配置文件路径 |
| `mcpServers` | string | 否 | MCP 配置文件路径 |
| `permissions` | object | 否 | 权限声明，见第 4 节 |
| `lume.hooksOnly` | boolean | 否 | 仅加载 hooks，跳过 skills 和 MCP |
| `lume.exclusivePermissions` | boolean | 否 | 权限仅在插件范围内生效，不影响全局 |

## 4. 权限系统

### 4.1 字段定义

```json
{
  "permissions": {
    "filesystem": {
      "read": ["./data/**", "./skills/**"],
      "write": ["./data/**"]
    },
    "network": {
      "outbound": ["api.example.com", "*.cdn.example.com"]
    },
    "mcpServers": {
      "register": true
    },
    "shell": {
      "allow": false
    },
    "tools": {
      "allow": ["FileRead", "Glob", "Grep"],
      "deny": ["FileWrite", "FileEdit"],
      "ask": ["WebFetch", "WebSearch"]
    },
    "hooks": {
      "events": ["PreToolUse", "SessionStart", "Stop"]
    }
  }
}
```

### 4.2 六个权限类别

**`filesystem`** — 文件系统访问

| 子字段 | 类型 | 说明 |
|---|---|---|
| `read` | `string[]` (glob) | 可读取的路径，支持相对路径（相对插件根目录）和绝对路径 |
| `write` | `string[]` (glob) | 可写入的路径 |

匹配时机：`FileRead`/`FileWrite`/`FileEdit`/`Glob`/`Grep`/`NotebookEdit` 工具调用时，对操作路径做 glob 匹配。

**`network`** — 网络访问

| 子字段 | 类型 | 说明 |
|---|---|---|
| `outbound` | `string[]` | 允许连接的主机名，支持 `*.example.com` 通配符 |

匹配时机：`WebFetch`/`WebSearch`/MCP 远程连接时，对目标主机名做匹配。

**`mcpServers`** — MCP Server 注册

| 子字段 | 类型 | 说明 |
|---|---|---|
| `register` | `boolean` | `true` 允许插件注册 MCP server；`false` 忽略 manifest 中的 `mcpServers` 字段 |

**`shell`** — Shell 命令执行

| 子字段 | 类型 | 说明 |
|---|---|---|
| `allow` | `boolean` | `false`（默认）时，插件 hook 中的 shell 命令被阻断 |

默认 deny。插件若需执行 shell hook，必须显式声明 `"allow": true`。

**`tools`** — 工具调用权限

| 子字段 | 类型 | 说明 |
|---|---|---|
| `allow` | `string[]` | 允许直接调用的工具名，无需用户确认 |
| `deny` | `string[]` | 禁止调用的工具名 |
| `ask` | `string[]` | 每次调用需要用户确认 |

三个列表取并集覆盖所有工具。未列出的工具走全局 `PermissionMode` 默认行为（通常为 `ask`）。

优先级：`deny` > `allow` > `ask` > 全局默认。

**`hooks`** — Hook 事件范围

| 子字段 | 类型 | 说明 |
|---|---|---|
| `events` | `string[]` | 插件可以注册的事件列表 |

未声明的事件自动排除。不影响全局 hook 注册。

### 4.3 默认权限（未声明 permissions 字段时）

| 类别 | 默认值 |
|---|---|
| `filesystem.read` | `["./**"]`（仅插件自身目录） |
| `filesystem.write` | `["./data/**"]` |
| `network.outbound` | `[]`（全部 ask） |
| `mcpServers.register` | `false` |
| `shell.allow` | `false` |
| `tools` | 全部走全局默认（ask） |
| `hooks.events` | 空（不注册任何 hook） |

### 4.4 Codex 适配宽松默认

Codex 插件通过适配器转换时，自动生成以下 permissions：

| 类别 | 默认值 |
|---|---|
| `filesystem.read` | `["./**"]` |
| `filesystem.write` | `["./data/**"]` |
| `network.outbound` | `[]` |
| `mcpServers.register` | `true`（Codex 插件通常声明 MCP servers） |
| `shell.allow` | `true`（Codex hooks 依赖 shell 命令） |
| `tools.allow` | 非危险工具白名单（`FileRead`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TaskList`, `TaskGet`, `AskUserQuestion`, `Config` 等） |
| `tools.deny` | 危险工具黑名单（`Bash`, `FileWrite`, `FileEdit`, `NotebookEdit`, `EnterWorktree`, `ExitWorktree`, `AgentTool`, `SendMessage`） |
| `tools.ask` | 未覆盖的剩余工具 |
| `hooks.events` | Codex 声明的事件映射到 Lume 等价事件 |

### 4.5 运行时执行流程

```
插件调用工具
    │
    ▼
PluginPermissionInterceptor（插件级别）
    │
    ├─ tools.deny 命中  → deny（阻断，附带插件名称）
    ├─ tools.allow 命中 → allow
    ├─ tools.ask 命中   → ask（弹用户确认，显示插件来源）
    └─ 未匹配           → 走全局 PermissionMode
    │
    ▼ （如果是文件操作）
路径 glob 匹配
    │
    ├─ filesystem.read/write 命中 → allow
    └─ 不匹配 → ask
```

**拦截器优先级：** 插件权限拦截器在全局 `CanUseToolFn` 之前执行。`deny` 直接阻断，不进入后续流程。全局 `PermissionMode`（如 `bypassPermissions`）可以覆盖插件级别设置。

### 4.6 跨插件工具调用

MCP servers 注册到全局池。所有插件的工具在注册层面合并（同名 server 先注册者优先）。运行时不做插件级别的工具隔离 — 如果模型知道某个工具存在（通过 context 注入），就可以调用它。

Context 注入控制可见性：只有被 `@plugin-name` 提及的插件的 tools 才会出现在模型上下文中。

## 5. Codex 适配器

### 5.1 字段映射表

| Codex 字段 | Lume 字段 | 处理 |
|---|---|---|
| `name` | `name` | 直接映射 |
| `version` | `version` | 直接映射 |
| `description` | `description` | 直接映射 |
| `author` | `author` | 直接映射 |
| `skills` | `skills` | 字符串 → 数组包装 `[value]` |
| `hooks` | `hooks` | 直接映射，事件列表做兼容检查 |
| `mcpServers` | `mcpServers` | 直接映射 |
| `interface.displayName` | `displayName` | 从 interface 对象中提取 |
| `interface.category` | `category` | 从 interface 对象中提取 |
| _(无)_ | `schema` | 适配器注入 `"lume-plugin/v1"` |
| _(无)_ | `permissions` | 适配器根据 Codex 插件类型生成宽松默认 |
| _(无)_ | `lume` | 适配器注入 `{ "hooksOnly": false }` |

### 5.2 事件兼容处理

Codex 10 个事件全部是 Lume 事件的子集，直接映射：

| Codex 事件 | Lume 事件 |
|---|---|
| `PreToolUse` | `PreToolUse` |
| `PostToolUse` | `PostToolUse` |
| `PermissionRequest` | `PermissionRequest` |
| `PreCompact` | `PreCompact` |
| `PostCompact` | `PostCompact` |
| `SessionStart` | `SessionStart` |
| `UserPromptSubmit` | `UserPromptSubmit` |
| `SubagentStart` | `SubagentStart` |
| `SubagentStop` | `SubagentStop` |
| `Stop` | `Stop` |

Lume 有但 Codex 没有的事件在 Codex 插件中为空，不影响全局 hook 注册。

### 5.3 转换流程

```
1. 读取 .codex-plugin/plugin.json
2. 路径安全校验（禁止 ParentDir 穿越）
3. 字段映射 + 类型转换
4. 注入 schema 和 permissions
5. 写入 lume-plugin.json（同目录或缓存目录）
6. 交给 PluginManager 走 Lume 原生加载路径
```

### 5.4 路径安全

沿用 Codex 的路径安全模型：

- 所有路径必须以 `./` 开头
- 逐组件检查禁止 `ParentDir`（`..`）
- 最终解析为 `AbsolutePathBuf`，验证在插件根目录内

## 6. 安装与加载流程

```
lume plugin add <plugin-name>[@<marketplace-name>]
        │
        ▼
1. 解析 PluginId（双命名空间）
2. 从 marketplace 获取源信息
3. 下载/复制插件文件到 ~/.lume/plugins/cache/<name>/<version>/
4. CodexAdapter 转换（如果需要）
5. 写入 lume-plugin.json
6. PluginManager 加载
   ├─ 解析 manifest
   ├─ 注册 Skills（调用 registerSkill）
   ├─ 加载 Hooks（注册到 HookRegistry）
   ├─ 连接 MCP Servers（McpClientManager）
   └─ 构建 PluginLoadOutcome
```

## 7. 插件能力汇总

```typescript
interface LumePlugin {
  configName: string        // "plugin-name"
  root: string              // 插件根目录绝对路径
  enabled: boolean
  skills: SkillDefinition[]
  hooks: HookDefinition[]
  mcpServers: McpServerConfig[]
  permissions: PluginPermissions
}
```

## 8. 非目标

- 不实现 Codex 的 App-Server Protocol v2（Lume 已有 sidecar RPC）
- 不实现 marketplace 远程目录系统（Phase 2）
- 不实现插件分享/导出功能（Phase 2）
- 不实现插件版本管理/回滚（Phase 2）
- 不实现插件开发脚手架工具（Phase 2）

## 9. 实现阶段划分

### Phase 1：核心基础设施

1. `LumePluginManifest` 类型定义 + JSON 序列化
2. `CodexPluginAdapter` — 字段映射 + 权限推断
3. `PluginPermission` 类型定义 + glob 路径匹配
4. `PluginPermissionInterceptor` — canUseTool 钩子集成
5. `PluginManager` — manifest 加载、Skills/Hooks/MCP 注册
6. CLI 命令：`lume plugin add/list/remove`
7. 磁盘布局：`~/.lume/plugins/cache/` + `~/.lume/plugins/data/`

### Phase 2：生态能力

- Marketplace 系统
- 插件发现/浏览 UI
- 插件更新/版本管理
- 权限持久化（用户对插件的权限修改记忆）

## 10. 与现有系统的集成点

| Lume 已有能力 | 集成方式 |
|---|---|
| `registerSkill/getAllSkills` | PluginManager 调用注册 |
| `HookRegistry` + 25 事件 | PluginManager 注册，事件过滤 |
| `McpClientManager` | PluginManager 连接 MCP servers |
| `CanUseToolFn` | PluginPermissionInterceptor 在全局拦截器前执行 |
| `PermissionMode` | 全局模式覆盖插件级别 |
| `PermissionUpdate` | 插件可通过 hook 发出权限修改请求 |
| Sidecar RPC | 插件工具在 sidecar 进程内执行 |
