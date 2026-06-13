# Lume 插件平台完善设计

Date: 2026-06-13
Status: Draft for implementation planning
Scope: 插件运行时闭环、插件市场、技能市场迁移、双格式 manifest、权限与启用作用域

## 1. 背景

Lume 当前已经有插件系统雏形：SDK 层有 `lume-plugin.json` manifest、Codex manifest 适配器、权限匹配工具和插件管理器；Sidecar 层有插件扫描、插件权限拦截器、插件列表 RPC；前端有已安装插件入口。近期提交也已经围绕 Codex 兼容插件系统推进。

但现有链路仍不完整：

- 发现和权限部分已经认识 `lume-plugin.json`，真实 Agent loader 仍主要走 command-only `plugin.json`。
- SDK `PluginManager`、Sidecar `SidecarPluginManager`、tool runtime 扫描、plugin skill reader 各自扫描不同目录。
- 插件权限拦截器按所有插件顺序拦截所有工具调用，没有精确绑定能力来源。
- Codex 兼容适配器存在，但没有成为运行时的统一规范化入口。
- 当前技能市场只围绕 workspace skill 安装，无法表达插件这种带权限和运行时能力的资产。

本设计将当前“插件雏形”收敛成一个完整但保守的插件平台。

## 2. 目标

- 建立统一插件解析层，支持 `lume-plugin.json` 和 `.codex-plugin/plugin.json` 双格式原生识别。
- 将插件运行时闭环补齐，让插件声明的 skills、hooks、MCP servers、command tools 能进入 Agent runtime。
- 把现有技能市场升级为插件市场，支持同时安装插件和技能。
- 保持插件和技能的数据结构独立，市场入口统一但安装、启用和运行时模型分离。
- 支持本地目录、GitHub 仓库和 marketplace 索引三类来源。
- 支持全局默认启用和 workspace 覆盖的双层作用域。
- 建立安装时权限知情和首次敏感运行确认机制。
- 保持保守执行模型：插件首版不加载任意 JS/TS 模块代码。

## 3. 非目标

- 不支持插件注入前端 UI。
- 不支持插件启动任意长期后台服务；插件声明的 MCP server 只能由 Lume 现有 MCP manager 托管启动和停止，不能绕过该生命周期。
- 不支持插件任意执行 `index.js`、`entry` 或 TS 模块。
- 不实现完整 marketplace 发布生态，例如评分、签名、开发者后台、自动审核。
- 不把技能强行改造成插件；技能仍是轻量内容资产。
- 不一次性重做 MCP 设置、技能编辑器和权限设置页面，只做与插件平台必要的接入。

## 4. 核心原则

### 4.1 统一入口，独立资产

“插件市场”是统一发现和安装入口，但插件和技能使用不同结构。

- 插件是能力包和权限主体。
- 技能是内容资产，安装到 workspace skills。

市场 catalog 可以返回 discriminated union，但内部模型、详情页、安装流程和运行时行为必须分开。

### 4.2 声明式保守平台

插件首版只允许通过 manifest 声明能力：

- skills
- hooks 配置
- MCP servers
- command tools

插件不加载任意 JS 模块，不开放前端扩展，不开放任意后台服务扩展。MCP server 是唯一允许的长生命周期能力，但必须由 Lume MCP manager 托管，随会话、reload、禁用和卸载停止。未来如需支持受控模块能力，应在 normalized plugin 上新增 capability，而不是绕过现有权限模型。

### 4.3 Normalize Once, Consume Everywhere

无论源格式是 Lume 还是 Codex，运行时、市场、权限、UI 都只消费统一的 normalized model。双格式支持停留在 normalize 层，不能让运行时长期维护两套插件模型。

## 5. 数据模型

### 5.1 市场项目

市场 catalog 返回两类项目：

```ts
type MarketCatalogItem =
  | { kind: "skill"; skill: SkillMarketItem }
  | { kind: "plugin"; plugin: PluginMarketItem };
```

`SkillMarketItem` 基本沿用现有 `SkillCatalogItem`，继续服务 workspace skill 安装：

```ts
interface SkillMarketItem {
  id: string;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  version?: string;
  sourceType: SkillSourceType;
  trustLevel: TrustLevel;
  installState: InstallState;
}
```

`PluginMarketItem` 单独建模：

```ts
interface PluginMarketItem {
  id: string;
  pluginId: string;
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  sourceType: PluginSourceType;
  trustLevel: TrustLevel;
  installState: InstallState;
  enableState: PluginEnableState;
  capabilities: PluginCapabilitySummary;
  permissions: PluginPermissionSummary;
}
```

插件市场摘要结构：

```ts
interface PluginCapabilitySummary {
  skillCount: number;
  hookEvents: string[];
  mcpServerNames: string[];
  commandToolNames: string[];
}

interface PluginPermissionSummary {
  filesystemRead: string[];
  filesystemWrite: string[];
  networkOutbound: string[];
  mcpRegister: boolean;
  shellAllow: boolean;
  toolAllow: string[];
  toolAsk: string[];
  toolDeny: string[];
  hookEvents: string[];
  riskLabels: Array<"shell" | "network" | "write" | "mcp" | "high-risk-tool">;
}
```

共享枚举：

```ts
type InstallState = "not-installed" | "installed" | "update-available";
type TrustLevel = "trusted" | "review-required" | "blocked-by-default";
type PluginEnableState =
  | "global-enabled"
  | "workspace-enabled"
  | "disabled"
  | "not-installed"
  | "needs-review";
```

### 5.2 NormalizedPlugin

`NormalizedPlugin` 是运行时唯一插件表示：

```ts
interface NormalizedPlugin {
  pluginId: string;
  name: string;
  version: string;
  root: string;
  manifestFormat: "lume" | "codex" | "legacy";
  displayName?: string;
  description?: string;
  capabilities: PluginManifestCapabilities;
  permissions: PluginPermissions;
  diagnostics: PluginDiagnostic[];
}
```

Normalizer 输出的能力结构只包含 manifest 内的声明和安全解析后的路径，不读取 hooks/MCP 文件，也不创建 runtime objects：

```ts
interface PluginManifestCapabilities {
  skills: PluginSkillContribution[];
  hooksConfigPath?: string;
  mcpServersConfigPath?: string;
  commandTools: CommandToolContribution[];
}
```

`PluginCapabilityResolver` 再把 `PluginManifestCapabilities` 转成 runtime capabilities：

```ts
interface PluginRuntimeCapabilities {
  skills: PluginSkillContribution[];
  hooks?: PluginHooksContribution;
  mcpServers: Record<string, McpServerConfig>;
  commandTools: ToolDefinition[];
}
```

每个 runtime contribution 必须带 `pluginId` 和 `version`。这用于权限、审计、诊断和 UI 展示。

### 5.3 安装记录

插件安装记录保存到 Sidecar 管理的统一插件状态文件，不写入 `lume.config`。记录以 `pluginId` 为键，内部可以保存多个已安装版本、一个 active version，以及外部发现源的 review state：

```ts
interface PluginInstallRecord {
  pluginId: string;
  activeVersion?: string;
  versions: Record<string, PluginInstalledVersion>;
  external?: Record<string, PluginExternalState>;
  approvalsByHash: Record<string, PluginApprovalBundle>;
}

interface PluginInstalledVersion {
  pluginId: string;
  version: string;
  source: PluginSourceRef;
  installedRoot: string;
  installedAt: string;
  trustedAt?: string;
  permissionsAcceptedAt?: string;
  permissionsHash?: string;
  sensitiveApprovals: Record<string, SensitiveApprovalRecord>;
}

interface PluginExternalState {
  sourceKey: string;
  permissionsHash?: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: Record<string, SensitiveApprovalRecord>;
}

interface PluginApprovalBundle {
  permissionsHash: string;
  permissionsAcceptedAt?: string;
  sensitiveApprovals: Record<string, SensitiveApprovalRecord>;
}
```

`permissionsHash` 根据 normalized permissions 和 sensitive capabilities 生成。插件更新后如果新版本 hash 改变，新版本进入 `needs-review`，不会成为 active version，直到用户重新确认。旧 active version 保持有效。

对 workspace-local、configured directories、legacy roots 这类 discovered-but-not-installed 插件，review 状态保存在同一 `PluginInstallRecord.external[sourceKey]` 下，`sourceKey` 使用 stable source identity：`<sourceType>:<realpath plugin root>`。这类插件没有 copied install version 或 active version，但仍必须有 permissions hash、review timestamp 和 sensitive approvals。没有 review state 的 discovered plugin 可以出现在列表中，但不能加载 runtime 能力。

Approval 复用以 `pluginId + permissionsHash` 为准。安装、更新或外部发现源产生相同 `permissionsHash` 时，registry 必须从 `PluginInstallRecord.approvalsByHash[permissionsHash]` 读取已接受权限和 sensitive approvals，并可同步拷贝到对应 version/external state 作为缓存。不同 version 但相同 hash 不需要重新 review。

### 5.4 配置作用域

扩展 `lume.config.plugins`：

```ts
plugins: {
  global?: {
    enabled: string[];
    disabled: string[];
  };
  workspaces?: Record<string, {
    enabled?: string[];
    disabled?: string[];
  }>;
  directories: string[];
  marketSources: PluginMarketSourceRef[];
}
```

`lume.config.plugins` 只保存用户意图：启用状态、额外目录、市场源。安装记录、active version、permission review、audit log 等可变运行状态全部保存在 Sidecar 插件状态文件，避免 config 并发写入和运行时状态混杂。

兼容现有配置：

- 旧 `plugins.enabled` 映射到 `plugins.global.enabled`。
- 旧 `plugins.directories` 继续作为额外发现目录。
- 旧 skill market metadata 保留，后续由新 market service 的 skill 分支读取。

## 6. 架构组件

### 6.1 PluginManifestNormalizer

位置：SDK。

职责：

- 识别 Lume manifest 和 Codex manifest。
- 校验 name、version、路径、权限结构。
- 将 `.codex-plugin/plugin.json` 映射为 Lume normalized manifest。
- 推断默认权限。
- 输出 `NormalizedPlugin` 或带诊断的失败结果。

不负责：

- 安装文件。
- 扫描全局目录。
- 写配置。
- 创建 runtime tool。

### 6.2 PluginRegistry

位置：Sidecar。

职责：

- 成为插件安装、发现、启用状态解析的唯一入口。
- 扫描统一插件仓库、workspace 插件目录和配置的额外目录。
- 识别 `lume-plugin.json` 和 `.codex-plugin/plugin.json`。
- 读取和写入 `PluginInstallRecord`。
- 根据全局和 workspace 配置输出当前 workspace 的 effective plugins。
- 提供 install、uninstall、enable、disable、reload、list、inspect API。

需要替代或收敛：

- `SidecarPluginManager` 的直接扫描。
- `ToolRuntime.resolveCommandPluginSpecs()` 的插件目录扫描。
- plugin skill reader 对 `~/.lume/plugins` 的裸扫。
- RPC `LIST_PLUGINS` 的独立扫描逻辑。

### 6.3 PluginCapabilityResolver

位置：Sidecar。

职责：

- 将 `NormalizedPlugin` 转成运行时能力。
- 读取 plugin skill roots 并生成 namespaced skill references。
- 读取 hooks 文件并按 `permissions.hooks.events` 过滤。
- 读取 `NormalizedPlugin.capabilities.mcpServersConfigPath` 指向的 MCP config，并按 `permissions.mcpServers.register` 决定是否注册。
- 读取 command tools 并转换成 `ToolDefinition`。
- 给所有能力注入 `runtimeMetadata.source = "plugin"` 和 `pluginId`。
- 输出 capability diagnostics。

### 6.4 PluginRuntimeBridge

位置：Sidecar agent runtime。

职责：

- Agent 初始化时读取当前 workspace 的 effective plugins。
- 将插件 command tools 作为 plugin tool group 传入 `ToolRuntime.build()`。
- 将插件 MCP servers 合并进现有 MCP server config。
- 将插件 hooks 注册进现有 hook registry。
- 将插件 skills 注入 skill activation 和 settings 列表。
- 支持 `/reload-plugins` 刷新 registry、capability resolver、MCP、hooks 和 tools。

`PluginRuntimeBridge` 取代 “command-only plugin spec” 作为 runtime 接入点。SDK loader 的 legacy command plugin 支持可以保留，但不能再作为新插件平台的主路径。

### 6.5 PluginMarketService

位置：Sidecar。

职责：

- 替代或包裹现有 `skills-market-service`。
- 返回插件和技能两类 catalog item。
- 负责 marketplace source 读取、GitHub inspect、本地 inspect。
- 对 skill install 分流到现有 workspace skill service。
- 对 plugin install 分流到 `PluginRegistry`。
- 提供 detail/review API，安装前必须重新读取实际 manifest 或 `SKILL.md`。

## 7. 运行时数据流

```text
local dir / GitHub repo / marketplace index
        -> PluginMarketService inspect
        -> PluginRegistry install or discover
        -> PluginManifestNormalizer
        -> NormalizedPlugin
        -> PluginCapabilityResolver
        -> PluginRuntimeBridge
        -> Agent runtime: skills + hooks + MCP + command tools
        -> PluginPermissionRuntime gates sensitive use
```

运行时只消费 `NormalizedPlugin` 和 resolved capabilities。不能让 runtime 根据文件名分支处理 Lume/Codex 两种格式。

## 8. 权限模型

### 8.1 确认时机

权限确认分两个时间点：

1. 安装或启用时确认权限声明。
2. 首次敏感运行时确认具体敏感能力。

安装或启用确认展示：

- skills 数量。
- hooks 事件。
- MCP servers。
- command tools。
- 文件读写范围。
- 网络域名。
- shell hooks 或 command tools。
- 高风险工具声明。

首次敏感运行确认覆盖：

- shell command hooks。
- command tools 执行。
- MCP server 注册或启动。
- 非白名单网络访问。
- 插件目录外写文件。
- 高风险内置工具调用。

“非白名单网络访问”指目标 host 未命中 `permissions.network.outbound`。“高风险内置工具”首版固定为 `Bash`、`FileWrite`、`FileEdit`、`NotebookEdit`、`EnterWorktree`、`ExitWorktree`、`AgentTool`、`SendMessage`。

Enforcement boundary:

- 对 Lume-mediated tools，例如 `WebFetch`、`WebSearch`、`FileWrite`、`FileEdit`、`NotebookEdit`，PluginPermissionRuntime 可以在调用前硬拦截 host/path。
- 对 command tools、shell hooks 和本地 command MCP servers，Lume 不做 syscall sandbox，不尝试拦截子进程内部网络或文件访问。它们按完整执行配置做启动级审批；一旦允许启动，内部副作用视为用户已批准的 subprocess risk。
- 对 remote MCP servers，Lume 可以在连接前按 remote URL host 做硬拦截。
- 对本地 MCP server 暴露出的 MCP tools，执行时仍带 `pluginId` 和 server/tool name，按 MCP tool sensitive key 走首次确认；但 server 子进程内部副作用仍属于启动级审批范围。
- 首版不承诺 OS sandbox。UI 必须把 command tools、shell hooks、本地 MCP 标为“unmediated subprocess”风险。

确认结果可记忆到 workspace 或 global，并写入 `PluginInstallRecord.approvalsByHash[permissionsHash]`，同时缓存到对应 version 或 external state。

### 8.2 来源绑定

现有权限拦截必须从“所有插件依次拦截所有工具”改成“按能力来源拦截”。

规则：

- 插件贡献的 tool、hook、MCP 调用必须携带 `pluginId`。
- `PluginPermissionRuntime` 只检查该 `pluginId` 对应权限。
- 普通用户发起的内置工具调用不受无关插件权限影响。
- 插件 hard deny 不能被 `bypassPermissions` 绕过。
- `bypassPermissions` 只能减少交互确认，不能扩大 manifest 权限边界。

### 8.3 诊断和审计

新增 `PluginAuditLog`，记录：

- 安装、卸载、启用、禁用。
- 权限确认。
- 首次敏感运行确认。
- 被拒绝的能力调用。
- manifest 变化导致的 `needs-review`。
- MCP 启动失败、hooks 过滤、command tool 无效等诊断。

诊断和审计事件使用以下结构：

```ts
interface PluginDiagnostic {
  pluginId?: string;
  version?: string;
  severity: "info" | "warning" | "error";
  code:
    | "ignored_manifest"
    | "legacy_manifest"
    | "invalid_manifest"
    | "unsafe_path"
    | "unsupported_field"
    | "duplicate_plugin_ignored"
    | "permission_review_required"
    | "capability_filtered"
    | "mcp_start_failed"
    | "command_tool_invalid"
    | "orphaned_install";
  message: string;
  path?: string;
}

interface PluginAuditEvent {
  id: string;
  pluginId: string;
  version?: string;
  workspaceSlug?: string;
  type:
    | "install"
    | "uninstall"
    | "enable"
    | "disable"
    | "permission_accept"
    | "sensitive_approval"
    | "sensitive_denial"
    | "needs_review"
    | "capability_blocked"
    | "diagnostic_recorded"
    | "mcp_start_failed"
    | "hook_filtered"
    | "command_tool_invalid";
  createdAt: string;
  summary: string;
  metadata?: Record<string, unknown>;
}
```

## 9. 启用作用域

有效启用状态按以下优先级解析：

1. workspace 显式禁用。
2. workspace 显式启用。
3. 全局显式禁用。
4. 全局显式启用。
5. 默认禁用。

新安装插件默认只进入 installed，不自动启用。安装完成后 UI 提供：

- 为当前 workspace 启用。
- 全局启用。
- 暂不启用。

如果插件处于 `needs-review`，即使配置启用，首版 runtime 也必须完全跳过该插件的所有能力，并在 UI、plugin list 和 runtime diagnostics 中显示“权限变化待确认”。不做半加载，避免用户误判插件是否生效。

## 10. 插件市场 UI

现有“技能市场”升级为“插件市场”。页面可以保留在当前 skills/settings 区域，但信息架构调整：

- `插件`
- `技能`
- `已安装`
- `来源`

插件卡片展示：

- 名称、版本、来源、信任等级。
- 能力摘要。
- 权限风险标签。
- 安装状态。
- 当前 workspace 和 global 启用状态。

插件详情展示：

- manifest 格式：Lume 或 Codex。
- capabilities：skills、hooks、MCP、command tools。
- permissions：文件、网络、shell、tools、hooks。
- 启用位置：global、workspace、disabled。
- 诊断：manifest 错误、权限待确认、MCP 失败、hooks 被过滤。
- 审计摘要。

技能区域复用现有技能市场交互，避免把技能安装流程改得过重。

## 11. 安装流程

### 11.1 插件安装

1. 用户选择 marketplace、GitHub 或本地目录。
2. Sidecar inspect，不立即安装。
3. `PluginManifestNormalizer` 识别 Lume 或 Codex manifest。
4. UI 展示能力和权限 review。
5. 用户确认后复制或拉取到统一插件仓库。
6. 写入 `PluginInstallRecord`。
7. 默认不启用。
8. 用户选择启用范围。

marketplace 索引只作为候选信息来源。安装时必须重新读取实际 manifest 并校验，不能信任索引中的权限或能力摘要。

### 11.2 技能安装

技能安装继续使用现有 workspace skill 机制：

- built-in skill 复制到 workspace。
- GitHub skill 走现有 review 和 install。
- local skill 记录来源 metadata。
- market-managed skill 继续禁止直接在 settings 里编辑或删除其受控内容。

### 11.3 来源支持

首版支持：

- 本地单插件目录。
- 本地单技能目录。
- 本地包含多个插件和技能的目录。
- GitHub 仓库根目录插件。
- GitHub 仓库子目录插件。
- GitHub 仓库多个 skill 目录。
- marketplace JSON index，包含 plugin 和 skill 条目。

## 12. 迁移策略

### 12.1 API 迁移

新增市场 API。现有 `LIST_PLUGINS` 保留为兼容别名，内部委托到 `PluginRegistry.list()`；新插件市场相关接口使用 `MARKET` 命名：

- `GET_MARKET_CATALOG`
- `GET_MARKET_DETAIL`
- `INSPECT_MARKET_SOURCE`
- `INSTALL_MARKET_ITEM`
- `UPDATE_PLUGIN`
- `UNINSTALL_PLUGIN`
- `SET_PLUGIN_ENABLEMENT`
- `SET_PLUGIN_ACTIVE_VERSION`
- `GET_PLUGIN_AUDIT_LOG`

现有 skill market API 暂时保留，内部委托到 `PluginMarketService` 的 skill 分支。前端逐步迁移，避免一次性破坏已有技能设置页。

### 12.2 文件布局兼容

支持现有：

- `~/.lume/plugins/<name>/lume-plugin.json`
- `.lume/plugins` workspace-local 插件目录。
- legacy `plugin.json` command-only 插件。

SDK `cache/<name>/<version>` 布局由 registry 兼容读取或迁移到统一仓库。统一仓库路径由 Sidecar 定义，SDK 不再自行决定运行时安装位置。

### 12.3 Legacy command plugin

legacy `plugin.json` command-only 插件继续支持，但标记诊断：

- 可运行。
- 不作为新插件推荐格式。
- 如果存在 module entry，继续忽略。
- UI 显示为 legacy plugin。

## 13. 测试计划

### 13.1 SDK

- Lume manifest normalize。
- Codex manifest normalize。
- 默认权限推断。
- 路径安全校验。
- 权限 hash 稳定性。

### 13.2 Sidecar registry

- 全局目录扫描。
- workspace-local 目录扫描。
- 额外目录扫描。
- 双格式 manifest 识别。
- 全局和 workspace 启用覆盖。
- 安装记录读写。
- 版本选择。
- `needs-review` 状态。

### 13.3 Capability resolver

- plugin skills 转成 namespaced skill references。
- hooks 按 event permission 过滤。
- `mcpServers.register = false` 时不注册 MCP。
- command tools 转成 `ToolDefinition` 并保留 `pluginId`。
- invalid contribution 产生 diagnostics，不拖垮整个 registry。

### 13.4 Runtime bridge

- Agent 初始化加载 effective plugins。
- `/reload-plugins` 刷新 tools、MCP、hooks、skills。
- MCP status 可显示插件来源。
- skill activation 支持 `$plugin:skill`。
- legacy command plugin 仍可执行。

### 13.5 权限

- 插件 hard deny 不被 bypass 绕过。
- 插件权限只拦截对应 `pluginId` 的能力。
- 首次敏感运行触发确认。
- 记忆确认后不重复打断。
- permissions hash 改变进入 `needs-review`。

### 13.6 市场和 UI state

- catalog 同时返回插件和技能，结构分开。
- skill install 走现有 workspace skill 分支。
- plugin install 走 registry 分支。
- 插件启用/禁用状态解析正确。
- 插件详情能展示能力、权限、诊断。

## 14. 分阶段验收

这个设计覆盖多个模块，但实施计划必须按可交付阶段拆分。每个阶段都要保持旧技能市场和 legacy command plugin 可用。

### 14.1 Phase 1: Normalize + Registry

范围：

- 新增 normalizer 和 normalized 类型。
- 支持 Lume、Codex、legacy command 三类 manifest 输入。
- 新增 Sidecar `PluginRegistry`，替代 list plugins 和插件目录扫描。
- 保留旧 `plugins.enabled/directories` 兼容读取。

验收：

- 兼容接口 `LIST_PLUGINS` 返回 normalized plugin diagnostics，并由 `PluginRegistry.list()` 提供数据。
- 同一插件重复出现时按第 16.5 节优先级选择唯一 effective candidate。
- 不接入 runtime 能力加载，不改变 Agent tool 行为。

### 14.2 Phase 2: Permission Foundation

范围：

- 所有 plugin capability contribution 都带 `pluginId` 和 `version`。
- 新增 `PluginPermissionRuntime` 的来源绑定骨架。
- 实现 hard deny、`needs-review` skip、permissions hash 校验。
- 敏感能力在未实现首次确认 UI 前必须默认 block，并产生 diagnostic。

验收：

- 普通内置工具不受无关插件权限影响。
- `needs-review` 插件完全不加载。
- command tools、MCP、shell hooks 在没有 approval 时不会执行或启动。

### 14.3 Phase 3: Runtime Capabilities

范围：

- 新增 `PluginCapabilityResolver`。
- 接入 skills、hooks、MCP servers、command tools。
- `/reload-plugins` 刷新 registry、capabilities、MCP、hooks、tools。

验收：

- `lume-plugin.json` 和 `.codex-plugin/plugin.json` 的声明能力都能进入 Agent runtime。
- legacy command plugin 仍可运行。
- 插件敏感能力经过 Phase 2 permission foundation gate。

### 14.4 Phase 4: Permission Runtime UX

范围：

- 安装/启用权限 review 落地。
- 首次敏感运行确认 UI 和记忆策略落地。
- 审计日志覆盖用户确认、拒绝和 needs-review。

验收：

- 插件 hard deny 不被 `bypassPermissions` 绕过。
- permissions hash 扩大或敏感能力变化后插件进入 `needs-review`。
- 用户允许 workspace 或 global scope 后，敏感能力不重复打断。

### 14.5 Phase 5: Market Backend

范围：

- 新增 `PluginMarketService`。
- 新 market API 返回插件和技能两类结构。
- skill 分支委托现有 skill market/install。
- plugin 分支接入 inspect/install/update/uninstall。

验收：

- 旧 skill market API 仍可用。
- marketplace index、GitHub、本地目录都能 inspect。
- 安装失败不会留下 partially installed 插件。

### 14.6 Phase 6: Market UI

范围：

- 前端将“技能市场”升级为“插件市场”。
- 插件/技能分区显示。
- 插件 review、安装、启用、禁用、卸载、needs-review UI。

验收：

- 技能安装体验不回归。
- 插件详情展示能力、权限、诊断、启用状态。
- 权限变化待确认时用户能重新 review 并恢复启用。

## 15. 风险与缓解

- 风险：范围过大，跨 SDK、Sidecar、Web、Shared。
  缓解：实施按 registry、runtime、market、UI 分阶段，每阶段保持可运行。
- 风险：权限来源绑定改动影响全局工具审批。
  缓解：只对带 `pluginId` 的能力启用插件权限 runtime，普通工具沿用现有 PermissionEngine。
- 风险：Codex 双格式支持导致运行时分叉。
  缓解：双格式只在 normalizer 层处理，runtime 只消费 normalized model。
- 风险：插件市场和技能市场混淆。
  缓解：市场入口统一，插件和技能结构、详情和安装动作分开。
- 风险：MCP 和 command tools 安全边界不清。
  缓解：安装时权限知情、首次敏感运行确认、audit log、hard deny 不可 bypass。

## 16. 必要合约

本节定义实施计划不能自行发明的核心合约。

### 16.1 Source 类型

```ts
type PluginSourceType = "local" | "github" | "subscribed-market" | "legacy";

type PluginSourceRef =
  | { type: "local"; path: string }
  | { type: "github"; owner: string; repo: string; ref: string; subdir?: string; url: string }
  | { type: "subscribed-market"; sourceId: string; itemId: string; resolved: PluginSourceRef }
  | { type: "legacy"; path: string };

interface PluginMarketSourceRef {
  id: string;
  name: string;
  kind: "local-index" | "remote-index";
  url?: string;
  path?: string;
  enabled: boolean;
}
```

`subscribed-market.resolved` 必须在安装时解析成 `local` 或 `github`。运行时和 registry 不从 marketplace index 直接加载插件。

### 16.2 Market API 合约

新 API 使用统一错误 envelope：

```ts
interface MarketError {
  code:
    | "source_not_found"
    | "network_failed"
    | "invalid_manifest"
    | "invalid_skill"
    | "permission_review_required"
    | "permission_review_cancelled"
    | "install_failed"
    | "uninstall_blocked"
    | "not_installed"
    | "already_installed";
  message: string;
  diagnostics?: PluginDiagnostic[];
}
```

主要请求和响应：

```ts
interface GetMarketCatalogInput {
  workspaceSlug: string;
  includeBlockedSources?: boolean;
}

interface GetMarketCatalogResult {
  plugins: PluginMarketItem[];
  skills: SkillMarketItem[];
  diagnostics: PluginDiagnostic[];
}

interface GetMarketDetailInput {
  workspaceSlug: string;
  kind: "plugin" | "skill";
  /** Global composite id: <sourceType>:<sourceId>:<kind>:<slug> */
  itemId: string;
}

interface InspectMarketSourceInput {
  workspaceSlug: string;
  source: PluginSourceRef | { type: "market-item"; sourceId: string; itemId: string };
}

interface InspectPluginResult {
  kind: "plugin";
  normalized: NormalizedPlugin;
  permissionSummary: PluginPermissionSummary;
  permissionsHash: string;
  installState: InstallState;
  enableState: PluginEnableState;
}

interface InspectSkillResult {
  kind: "skill";
  item: SkillMarketItem;
  fileTree?: SkillFileTreeNode[];
}

interface InstallMarketItemInput {
  workspaceSlug: string;
  kind: "plugin" | "skill";
  itemId?: string;
  source?: PluginSourceRef;
  overwrite?: boolean;
  enableScope?: "none" | "workspace" | "global";
  acceptedPermissionsHash?: string;
}

interface InstallMarketItemResult {
  kind: "plugin" | "skill";
  id: string;
  version?: string;
  installed: boolean;
  enableState?: PluginEnableState;
  diagnostics?: PluginDiagnostic[];
}

interface UpdatePluginInput {
  pluginId: string;
  source?: PluginSourceRef;
  targetVersion?: string;
  acceptedPermissionsHash?: string;
  activate?: boolean;
  force?: boolean;
}

interface UpdatePluginResult {
  pluginId: string;
  installedVersion: string;
  activeVersion: string;
  activated: boolean;
  needsReview: boolean;
  diagnostics?: PluginDiagnostic[];
}

interface SetPluginEnablementInput {
  workspaceSlug?: string;
  pluginId: string;
  version?: string;
  force?: boolean;
  scope: "global" | "workspace";
  enabled: boolean;
}

interface SetPluginActiveVersionInput {
  pluginId: string;
  version: string;
  acceptedPermissionsHash?: string;
  force?: boolean;
}

interface SetPluginEnablementResult {
  pluginId: string;
  version?: string;
  scope: "global" | "workspace";
  enabled: boolean;
  enableState: PluginEnableState;
  needsReview: boolean;
  diagnostics?: PluginDiagnostic[];
}

interface SetPluginActiveVersionResult {
  pluginId: string;
  previousActiveVersion?: string;
  activeVersion: string;
  needsReview: boolean;
  diagnostics?: PluginDiagnostic[];
}

interface UninstallPluginInput {
  pluginId: string;
  version?: string;
  force?: boolean;
}

interface UninstallPluginResult {
  pluginId: string;
  removedVersions: string[];
  disabledScopes: Array<{ scope: "global" | "workspace"; workspaceSlug?: string }>;
  blockedScopes?: Array<{ scope: "global" | "workspace"; workspaceSlug?: string }>;
  diagnostics?: PluginDiagnostic[];
}

interface GetMarketDetailResult {
  item: MarketCatalogItem;
  inspect?: InspectPluginResult | InspectSkillResult;
  diagnostics: PluginDiagnostic[];
}

interface GetPluginAuditLogInput {
  pluginId: string;
  workspaceSlug?: string;
  limit?: number;
}

interface GetPluginAuditLogResult {
  events: PluginAuditEvent[];
}
```

`itemId` is a global composite id: `<sourceType>:<sourceId>:<kind>:<slug>`. Local ad-hoc inspect sources use source id `inline`. This prevents collisions when multiple market sources publish the same slug.

`INSTALL_MARKET_ITEM` for plugin 必须要求 `acceptedPermissionsHash` 等于最新 inspect hash。缺失或不匹配时返回 `permission_review_required`。`UPDATE_PLUGIN` 使用同样规则；如果目标版本的 `permissionsHash` 已存在于 `approvalsByHash`，可以省略 `acceptedPermissionsHash` 并复用旧 approval。

`SetPluginEnablementInput` validation:

- `scope: "workspace"` requires `workspaceSlug`.
- `scope: "global"` must ignore `workspaceSlug`; callers should omit it.
- If `version` is present and lower than current `activeVersion`, `force` must be true.
- `SetPluginActiveVersionInput` also requires `force` for downgrade.

### 16.3 Manifest Normalize 合约

Manifest 选择规则：

1. 同一 root 同时存在 `lume-plugin.json` 和 `.codex-plugin/plugin.json` 时，优先使用 `lume-plugin.json`，为 Codex manifest 产生 `ignored_manifest` diagnostic。
2. 只有 `.codex-plugin/plugin.json` 时，按 Codex manifest normalize。
3. 只有 legacy `plugin.json` 且包含 command tools 时，按 legacy command plugin normalize，`manifestFormat` 记为 `"legacy"`，并产生 `legacy_manifest` diagnostic。
4. 无有效 manifest 时，该目录不是插件。

路径规则：

- manifest 中引用文件或目录的路径必须以 `./` 开头。
- 禁止 `..` segment。
- 解析后必须仍位于 plugin root 内。
- 对 symlink 或 realpath 逃逸 plugin root 的路径，必须忽略该 contribution 并产生 diagnostic。
- command tool 的 `cwd` 也遵守同样规则。

字段映射：

| Lume field | Normalized field |
|---|---|
| `name` | `name` and `pluginId` |
| `version` | `version` |
| `displayName` | `displayName` |
| `description` | `description` |
| `skills[]` | `capabilities.skills[].root` |
| `hooks` | `capabilities.hooks.configPath` |
| `mcpServers` | `capabilities.mcpServersConfigPath` |
| `commandTools[]` | `capabilities.commandTools[]` |
| `permissions` | `permissions` with defaults |
| `lume.hooksOnly` | capability resolver skips skills/MCP/tools when true |

| Codex field | Normalized field |
|---|---|
| `name` | `name` and `pluginId` |
| `version` | `version` |
| `interface.displayName` | `displayName` |
| `description` | `description` |
| `skills` | `capabilities.skills[].root` |
| `hooks` | `capabilities.hooks.configPath` |
| `mcpServers` | `capabilities.mcpServersConfigPath` |
| no permissions | Codex-compatible default permissions |

Command tool manifest schema:

```ts
interface CommandToolContribution {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  inputSchema?: Record<string, unknown>;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}
```

Rules:

- Lume native plugins declare command tools in `commandTools[]`.
- Legacy `plugin.json` command-only plugins map `tools[]` entries with `name` and `command` into `commandTools[]`.
- Codex plugin manifest has no native command tool field; Codex plugins can contribute tools through MCP only.
- `command`, `args`, `cwd`, `timeoutMs`, `inputSchema`, `env`, and `metadata` are all validated by normalizer for type shape; `cwd` follows plugin-root path rules.
- Capability resolver converts valid `CommandToolContribution` entries into `ToolDefinition`; invalid entries are skipped with `command_tool_invalid`.

Codex-compatible default permissions are:

- filesystem read `["./**"]`
- filesystem write `["./data/**"]`
- network outbound `[]`
- MCP register `true`
- shell allow `true`
- tools allow `["FileRead", "Glob", "Grep", "WebFetch", "WebSearch", "TaskList", "TaskGet", "AskUserQuestion", "Config"]`
- tools deny `["Bash", "FileWrite", "FileEdit", "NotebookEdit", "EnterWorktree", "ExitWorktree", "AgentTool", "SendMessage"]`
- hooks events are the Codex-declared events that Lume supports

Unsupported fields are ignored with diagnostics unless they imply executable module loading, such as `entry`; those are ignored with warning severity.

### 16.4 Permission 合约

`PluginPermissions` keeps the existing manifest shape:

```ts
interface PluginPermissions {
  filesystem?: { read?: string[]; write?: string[] };
  network?: { outbound?: string[] };
  mcpServers?: { register?: boolean };
  shell?: { allow?: boolean };
  tools?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: { events?: string[] };
}
```

Sensitive approval keys are deterministic strings:

```ts
type SensitiveCapabilityKey =
  | `commandTool:${string}`
  | `mcpServer:${string}`
  | `hook:${string}:${string}`
  | `network:${string}`
  | `filesystem:write:${string}`
  | `tool:${string}`;

interface SensitiveApprovalRecord {
  key: SensitiveCapabilityKey;
  scope: "global" | "workspace";
  workspaceSlug?: string;
  decision: "allow" | "deny";
  createdAt: string;
  permissionsHash: string;
}
```

Approval resolution:

1. workspace deny.
2. workspace allow.
3. global deny.
4. global allow.
5. no record means ask.

`permissionsHash` is computed from canonical JSON of:

- `pluginId`
- `manifestFormat`
- normalized `permissions`
- sorted capability summary: skill roots, hook events, MCP server names and command, command tool names and commands
- sorted resolved execution config:
  - command tool command, args, cwd, timeout, env keys and values or secret reference identifiers, input schema hash
  - shell hook event, matcher, command, args, cwd, timeout, env keys and values or secret reference identifiers
  - local MCP command, args, cwd, env keys and values or secret reference identifiers
  - remote MCP URL, transport type, header keys and literal values or secret reference identifiers, server name
  - filesystem and network declarations after path/host normalization

The hash excludes installation path, diagnostics, timestamps, and enablement state.

The hash also excludes `version`. A pure version bump that keeps permissions and sensitive capability summary unchanged can reuse the previous approval. Version is still stored in install records and audit events, but it is not part of review equivalence.

### 16.5 Discovery and Duplicate Precedence

Registry groups candidates by `pluginId`. Effective candidate selection is deterministic:

1. workspace-local `.lume/plugins`.
2. configured `plugins.directories` in user-specified order.
3. installed plugin store.
4. legacy global plugin root.

Within the same precedence bucket:

- version `local` wins for workspace-local and configured directories.
- installed plugin store uses `PluginInstallRecord.activeVersion`.
- directories without install records use highest semver when versioned subdirectories exist.
- ties keep first scan order and produce `duplicate_plugin_ignored` diagnostics for ignored candidates.

Enablement always refers to `pluginId`, not filesystem path. Diagnostics should expose which candidate was selected and which were ignored.

Install state for market items:

- `not-installed`: no install record for `pluginId`, and no reviewed external state for the candidate source.
- `installed`: install record exists and market item version is not newer than `activeVersion`; for external sources, reviewed external state exists for the same `sourceKey`.
- `update-available`: market item version is semver-newer than installed `activeVersion`, or external source hash/version differs from reviewed `sourceKey` state.

Effective runtime state:

| Condition | Runtime state |
|---|---|
| no install/external review state | visible only; not loaded |
| installed or reviewed external, disabled by effective config | installed; not loaded |
| enabled, permissions hash matches accepted hash | loaded |
| enabled, permissions hash differs or missing | `needs-review`; not loaded |
| duplicate candidate loses precedence | ignored with diagnostic |

### 16.6 Install, Update, Uninstall Failure Semantics

Plugin install is staged and atomic:

1. Download or copy into a temp staging directory under the plugin store.
2. Normalize and validate manifest from staging.
3. Compare `acceptedPermissionsHash`.
4. Atomically rename staging to final installed directory.
5. Write `PluginInstallRecord`.

If any step before atomic rename fails, staging is removed and no install record is written. If writing install record fails after rename, registry must either remove the installed directory or mark it orphaned with diagnostic and keep it disabled.

Permission review cancellation writes nothing and returns `permission_review_cancelled`.

Update installs a new version side by side through `UPDATE_PLUGIN`. Existing `activeVersion` remains effective until the new version passes review and either `UPDATE_PLUGIN.activate = true` or `SetPluginActiveVersionInput` succeeds. `SetPluginEnablementInput.version` is a convenience: when present, it first performs active-version switch semantics, then changes enablement. Downgrade is allowed only with explicit `version` and `force`.

Uninstall behavior:

- If plugin is enabled anywhere and `force` is false, return `uninstall_blocked` with scopes that still enable it.
- If `force` is true, disable it from all scopes, stop managed MCP servers, unregister hooks/tools/skills on next reload, then remove installed files and record.
- Uninstall must not delete configured external directories; it can only remove plugin store installs.

### 16.7 MCP Lifecycle Boundary

Plugin-declared MCP servers are allowed only as managed MCP entries:

- local command MCP servers are child processes started by the existing MCP manager;
- remote MCP servers are network connections managed by the existing MCP manager;
- both require manifest permission and first sensitive runtime confirmation;
- both stop on plugin disable, plugin uninstall, `/reload-plugins`, session shutdown, or MCP manager shutdown.

Plugins cannot start independent daemons, watchers, schedulers, HTTP servers, or background workers outside MCP manager. Command tools are one-shot executions, not services.
