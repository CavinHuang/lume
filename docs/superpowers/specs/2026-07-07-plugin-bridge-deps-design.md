# 插件桥接依赖显示与安装向导 — 设计

- 日期：2026-07-07
- 状态：已批准（待实现计划）
- 关联仓库：`lume`（主仓 schema/IPC/UI）、`lume-plugins`（chrome/obsidian 清单）
- 关联设计：
  - `2026-06-13-lume-plugin-platform-design.md`（插件平台总览）
  - `2026-07-05-plugin-marketplace-metadata-design.md`（marketplace 元数据与 setup[]）
  - `2026-07-04-plugin-detail-readme-setup-tabs-design.md`（详情页 Setup Tabs）
  - `2026-07-05-plugin-interaction-flow-design.md`（插件交互流程）

## 1. 背景与动机

Lume 的部分插件依赖「桥接包」才能工作——这些桥接包是插件与外部应用（Chrome、Obsidian）之间的粘合层，形态各异：

| 插件 | 桥接包形态 | 获取方式 | 目标位置 |
|---|---|---|---|
| `lume-chrome` | MV3 浏览器扩展（`lume-browser-extension-v4.zip`） | 插件包内 | Chrome `chrome://extensions` 加载已解压 |
| `lume-chrome` | Rust Native Host 二进制 | 需 `cargo build --release` | OS 的 NativeMessagingHosts 目录 |
| `obsidian-bridge` | Obsidian 社区插件（`dist/main.js`） | 插件包内 | `<Vault>/.obsidian/plugins/obsidian-bridge/` |
| `obsidian-bridge` | Obsidian 端 `manifest.json` | GitHub Release（不在包内） | 同上目录 |

当前用户安装这类插件后，只能自行阅读散落在插件目录里的 README，凭直觉把桥接包弄到本地、装进目标应用。缺少：
1. 在插件页面**显式标识**「这是个依赖桥接的插件」；
2. 把桥接包**导出/下载到本地**的一站式入口；
3. **步骤化安装教程**，逐步引导并验证每一步完成。

## 2. 现状分析（读码后修正）

`buildPluginSetupItems`（`apps/web/src/components/skills/plugin-detail-state.ts:89`）**已经消费 `marketplace.setup[]`**：`buildExplicitSetupItems`（`:147`）优先返回清单声明的步骤，只有 setup[] 为空才回落到 permissions 推断。所以「声明为主 + 推断兜底」的数据源策略基础版**已实现**。

真正的缺口：
- `PluginMarketplaceSetupStep`（`packages/sdk/src/plugins/manifest.ts:62`）只有 `{id, title, description, kind}` 四个字段——**没有产物路径、外部下载源、目标应用、校验方式**，UI 只能渲染文本，无法提供「导出/下载/检测」操作按钮。
- `setupStepStatus`（`plugin-detail-state.ts:160`）按 kind 硬编码推断状态（`browser-auth`/`pairing-code`/`local-service`/`mcp`/`custom` 一律返回 `'attention'`），**无真实运行时校验**。
- 插件 tarball 安装时已整体落到 `~/.lume/plugins/<id>/<ver>/`，桥接产物已在本地，但**无导出/打开入口**；包外产物（Rust 二进制、Release 资产）**无下载入口**。
- 无全屏分步向导，安装后引导缺失。

安装/权限审查/审计链路（`install-market-item`、`PluginMarketService`、`plugin-state-store`）已完整闭环，本设计**复用**而非改动它们。

## 3. 目标与非目标

### 目标
1. 插件卡片对依赖桥接的插件显示「🔌 需桥接」徽章。
2. 点「安装」打开**全屏分步向导**，第 1 步完成 Lume 插件安装（含权限审查），后续步骤逐个引导桥接产物。
3. 每步可：**导出**包内产物到本地、**下载**包外产物（外部源）、**检测**桥接是否就绪、查看**教程**。
4. 软校验：检测通过自动打勾，未通过允许手动标记完成，不阻塞下一步。

### 非目标（YAGNI）
- 不自动安装到 Chrome/Obsidian（技术不可行/不安全，仅引导）。
- 不在 Lume 内执行 `cargo build`（仅给出命令与前置条件）。
- 不持久化向导进度（关闭重来；后续可加）。
- 不改动现有详情页 Setup Tab（向导是并行新入口，Setup Tab 保留）。
- 不覆盖 IM/IDE 等其他桥接类型（MVP 仅 chrome + obsidian 两个）。

### 成功标准
- 安装 `lume-chrome` 后，向导能导出 `lume-browser-extension-v4.zip`、给出 Rust Native Host 构建命令（含 `LUME_EXTENSION_ID` 等环境变量说明）、检测扩展是否已加载。
- 安装 `obsidian-bridge` 后，向导能导出 `dist/main.js`、提供从 Release 下载 `manifest.json` 的链接、检测本地 HTTP（`127.0.0.1:43112`）是否在监听。
- `example-hello` / `test-codex`（无桥接）不显示徽章、不进向导，走原安装流程。

## 4. 决策记录

经 4 轮澄清确定的架构方向：

| 决策 | 选择 | 理由 |
|---|---|---|
| 下载语义 | 包内导出 + 包外源链接（按产物类型分别处理） | 产物形态各异，需分别覆盖 |
| UI 形态 | 市场卡片徽章 + 全屏分步向导 | 沉浸式引导，适合首次安装 |
| 向导边界 | 整合一键向导（第 1 步装 Lume 插件） | 体验最顺，一键到底 |
| 数据来源 | 声明式（扩展 setup[]） | 精确、可扩展、新桥接插件只写清单 |

待确认设计点（已默认采纳）：
1. schema 新增 5 字段（artifact/download/build/targetApp/verify）——采纳。
2. Rust Native Host 只给命令、不自动执行——采纳。
3. 向导进度不持久化——采纳。
4. 现有 Setup Tab 保留不动，向导作为并行新入口——采纳。

## 5. 详细设计

### 5.1 数据模型：扩展 setup step schema

`packages/sdk/src/plugins/manifest.ts:62` 的 `PluginMarketplaceSetupStep` 新增**全部可选**字段（向后兼容）：

```ts
export interface PluginMarketplaceSetupStep {
  id: string;
  title: string;
  description: string;
  kind?: PluginMarketplaceSetupKind;
  // —— 新增：桥接产物信息 ——
  artifact?: {
    path: string;           // 相对插件根，走 validatePluginPath，如 "./lume-browser-extension-v4.zip"
    kind: 'chrome-extension' | 'obsidian-plugin' | 'native-binary' | 'node-bundle' | 'file';
  };
  download?: {
    url: string;            // 必须 https
    filename?: string;
    sha256?: string;        // 可选完整性校验
  };
  build?: {
    command: string;        // 如 "cargo build --release"
    cwd?: string;           // 相对插件根，走 validatePluginPath
    env?: Record<string, string>;
    prerequisites?: string; // 如 "需要本机已安装 Rust 工具链"
  };
  targetApp?: {
    kind: 'chrome' | 'obsidian' | 'system-path';
    installHint?: string;   // 如 "<Vault>/.obsidian/plugins/obsidian-bridge/"
  };
  verify?: {
    method: 'tcp-port' | 'chrome-extension' | 'http-get' | 'none';
    detail?: string;        // tcp-port: "127.0.0.1:43112"; chrome-extension: 扩展 id; http-get: url
  };
}
```

配套改动：
- `MARKETPLACE_SETUP_KINDS`（`manifest.ts:105`）不变。
- `normalizeMarketplace`（`manifest.ts:200-223`）的 setup 解析块扩展：解析上述新字段；`artifact.path` 与 `build.cwd` 走 `validatePluginPath`；`download.url` 校验以 `https://` 开头，否则丢弃该字段并记 warning。
- `packages/shared/src/types/plugin-market.ts` 的 `PluginMarketItem`（及其 setup step 序列化类型）同步带新字段，供 sidecar → renderer 传递。

### 5.2 后端：sidecar 新增 3 个 IPC

`packages/shared/src/types/agent.ts:1425-1446` 的 channel 列表新增；handler 加在 `apps/sidecar/src/rpc/agent-handlers.ts:1072-1134`；实现放新建 `apps/sidecar/src/services/plugins/plugin-bridge-service.ts`（单一职责，`PluginMarketService` 已较大，不再堆叠）。

| IPC Channel | 输入 | 行为 | 返回 |
|---|---|---|---|
| `agent:export-plugin-artifact` | `{pluginId, version, artifactPath, destDir?}` | 复制 `~/.lume/plugins/<id>/<ver>/<artifactPath>` 到 destDir；destDir 缺省时写入用户下载目录，返回 savedPath 供 UI「在文件夹中显示」 | `{ savedPath }` |
| `agent:download-bridge-asset` | `{url, filename, sha256?}` | 下载到用户下载目录，校验 sha256（若提供） | `{ savedPath, verified }` |
| `agent:check-bridge-status` | `{pluginId, version, verify:{method, detail}}` | `tcp-port` 试连；`chrome-extension` 扫描各 OS 的 Chrome `Extensions/<id>` 目录（移植 `lume-plugins` 的 `check-extension-installed.mjs` 逻辑）；`http-get` 探活 | `{ ok: boolean, detail }` |

安全约束：
- `check-bridge-status` 的 `tcp-port` / `http-get` 仅允许 `127.0.0.1` / `localhost`（与现有 `permissions.network.outbound` 语义一致）。
- `download-bridge-asset` 强制 https，可选 sha256 完整性校验。
- 导出/下载写文件经现有权限/确认机制；不在插件 sandbox 外执行任意代码。

### 5.3 前端：向导 + 卡片徽章

**新增** `apps/web/src/components/skills/BridgeInstallWizard.tsx`（全屏 Dialog 或 Sheet）：

```
┌─ 安装向导: Obsidian Bridge ──────────────────┐
│ ●───●───○───○   步骤 2/4                     │
│ 安装  社区插件  HTTP服务  配对码               │
│ ┌─────────────────────────────────────────┐ │
│ │ ② 安装 Obsidian 社区插件                 │ │
│ │ 把 main.js + manifest.json 放入         │ │
│ │ <Vault>/.obsidian/plugins/obsidian-bridge/ │
│ │ ▸ 展开详细教程（markdown，折叠）        │ │
│ │ [导出 main.js] [下载 manifest.json]     │ │
│ │ [在文件夹中显示]                         │ │
│ │ ○ 未检测到  [检测] / [手动标记完成]      │ │
│ └─────────────────────────────────────────┘ │
│ [上一步]                       [下一步]      │
└──────────────────────────────────────────────┘
```

- **步骤来源**：清单 `marketplace.setup[]`。第 1 步固定为「Lume 插件安装」，调 `install-market-item`（含权限审查流程）；后续步骤为桥接产物。若插件已安装（`installState === 'installed'`），第 1 步显示「已安装」并自动进入下一步。
- **每步操作按钮按字段渲染**：`artifact` → [导出][在文件夹中显示]；`download` → [下载]；`build` → [复制构建命令] + 显示 `prerequisites`；`verify` → [检测] + 状态指示。`description` 与 `targetApp.installHint` 作教程文案。
- **MarketCard 改造**（`apps/web/src/components/skills/SkillsMarketView.tsx:613-680`）：若 `marketplace.setup` 非空，卡片角标显示「🔌 需桥接」徽章；「安装」按钮直接打开向导（而非原 inline 安装）。无 setup 的插件走原流程。
- **buildPluginSetupItems 改造**（`plugin-detail-state.ts`）：返回的 `PluginSetupItem` 携带 artifact/download/targetApp/verify，详情页 Setup Tab 与向导共用。`setupStepStatus` 接入真实 `verify` 结果（异步检测），不再一律 `'attention'`。

### 5.4 lume-plugins 仓库改动

为 chrome / obsidian 清单的 `marketplace.setup[]` 补结构化字段：

```jsonc
// plugins/lume-chrome/lume-plugin.json（节选）
{ "id": "install-extension", "kind": "install",
  "title": "安装 Chrome 扩展", "description": "...",
  "artifact": { "path": "./lume-browser-extension-v4.zip", "kind": "chrome-extension" },
  "targetApp": { "kind": "chrome", "installHint": "chrome://extensions → 加载已解压的扩展程序" },
  "verify": { "method": "chrome-extension", "detail": "<extension-id>" } },
{ "id": "build-native-host", "kind": "local-service",
  "title": "编译并注册 Native Host", "description": "...",
  "build": { "command": "cargo build --release", "cwd": "./native-host",
             "prerequisites": "需要本机已安装 Rust 工具链",
             "env": { "LUME_EXTENSION_ID": "<id>", "LUME_CHROME_HOST_PATH": "<path>", "LUME_APP_SERVER_URL": "<url>" } } }

// plugins/obsidian-bridge/lume-plugin.json（节选）
{ "id": "install-obsidian-plugin", "kind": "install",
  "title": "安装 Obsidian 社区插件", "description": "...",
  "artifact": { "path": "./dist/main.js", "kind": "obsidian-plugin" },
  "download": { "url": "https://github.com/CavinHuang/lume-plugins/releases/download/obsidian-bridge-v0.1.2/manifest.json", "filename": "manifest.json" },
  "targetApp": { "kind": "obsidian", "installHint": "<Vault>/.obsidian/plugins/obsidian-bridge/" } },
{ "id": "verify-http", "kind": "local-service",
  "title": "确认本地 HTTP 服务", "description": "...",
  "verify": { "method": "tcp-port", "detail": "127.0.0.1:43112" } }
```

注：占位符（`<extension-id>`、`<Vault>`、Release URL 等）在清单里写为可读说明，向导据 `targetApp.kind` 渲染对应引导；`<extension-id>` 等运行期才确定的值由用户在教程中按提示填入或由检测步骤推断。

### 5.5 错误处理与校验策略

- **软校验**：每步可 [检测]，通过 → 绿勾；未通过 → 显示原因 + 允许 [手动标记完成]，不阻塞下一步。
- **导出失败**（产物不存在）：提示「产物缺失，可能插件版本不匹配」+ 链接到插件目录。
- **下载失败**（网络/校验不通过）：可重试 + 显示原始 url 让用户手动下载。
- **build 步骤**：仅 [复制构建命令]，不在 Lume 内执行。

## 6. 测试策略

测试运行器用 `bun:test`（参考 `AgentView.test.tsx` 的 fake DOM 模式）。

- **schema 解析**（`manifest.ts`）：新字段解析 + 向后兼容（旧 step 无新字段不报错）；`artifact.path`/`build.cwd` 非法路径拒绝；`download.url` 非 https 丢弃并 warning。
- **sidecar IPC**（`plugin-bridge-service.ts`）：`export-plugin-artifact`（mock fs）、`download-bridge-asset`（mock 网络 + sha256）、`check-bridge-status`（mock tcp/扫描）单元测试。
- **buildPluginSetupItems**：消费新字段渲染按钮与状态。
- **向导组件**：fake DOM，覆盖步骤切换、导出/下载/检测按钮触发、软校验状态流转。
- **端到端**：chrome + obsidian 两个桥接插件完整向导流程；example-hello/test-codex 不进向导。

## 7. 实现顺序（供 writing-plans 参考）

按依赖关系分阶段，每阶段可独立验证：

1. **SDK schema**：扩展 `PluginMarketplaceSetupStep` + `normalizeMarketplace` 解析（`manifest.ts`）。→ 验证：旧清单不报错、新字段可解析。
2. **shared 类型**：`PluginMarketItem` 序列化带新字段 + 3 个新 IPC channel 类型（`agent.ts`、`plugin-market.ts`）。
3. **sidecar**：`plugin-bridge-service.ts` + 3 个 handler（`agent-handlers.ts`）。→ 验证：单元测试通过。
4. **web state**：`buildPluginSetupItems` 扩展携带新字段。→ 验证：状态推断接入 verify。
5. **web 向导**：`BridgeInstallWizard.tsx` + `MarketCard` 徽章 + 安装按钮接入。→ 验证：组件测试 + 手动走查。
6. **lume-plugins**：chrome/obsidian 清单补字段。→ 验证：向导端到端可走通。
7. **测试补全**：端到端用例。

## 8. 风险与权衡

- **chrome-extension 检测的跨平台差异**：各 OS 的 Chrome Extensions 目录路径不同，需移植 `lume-plugins` 的扫描逻辑并覆盖 Win/Mac/Linux。MVP 可先做当前 OS（Windows）。
- **包外 Release URL 维护**：`download.url` 硬编码版本号，插件升级时需同步；后续可考虑相对路径或 latest 别名。
- **向导与现有 Setup Tab 的信息重复**：两者都展示 setup 步骤，但向导带操作能力、Setup Tab 仅展示。可接受，后续若混乱再合并。
- **导出无原生「另存为」对话框**：MVP 导出固定写用户下载目录 + 「在文件夹中显示」，不弹原生对话框（需 desktop main 额外 IPC，增加复杂度）。后续可增强。
