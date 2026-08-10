# Link 视图对齐 wanta Connections 设计

- 日期：2026-08-10
- 分支：`worktree-feat-link-view-wanta-parity`
- 状态：设计已批准，待编写实施计划
- 对齐参照：`D:\workspace\projects\ai-projects\wanta` 的 `Connections` 页（`src/routes/Connections/`）

## 1. 背景与动机

Lume 的"连接器"页面（`apps/web/src/components/link/LinkView.tsx`）与同源上游 wanta 的 `Connections` 页存在显著 UI 差距。本设计将该页面的展示（布局、图标、配置控件、状态指示、品牌 logo）全面对齐 wanta，同时保留 Lume 的架构约束与既有优势。

### 现状差异（探索结论）

| 维度 | Lume 现状 | wanta 目标 |
|---|---|---|
| 主结构 | Tabs 三栏（应用目录 / 我的连接 / 运行记录） | Split-view master-detail（左目录 + 右详情面板） |
| 详情呈现 | 弹窗 `ProviderDialog` | 右侧内联面板（带滑入动画） |
| 导航图标 | `PlugZap`（lucide） | `Plug`（lucide） |
| 筛选控件 | 搜索 Input + 分类 Select + 状态 Select（三独立控件） | SearchField + ToggleGroup 单选（全部/已连接/免配置/需处理 + 动态分类 + 溢出菜单，ResizeObserver 自适应） |
| 状态指示 | 文本为主 | 彩色光晕圆点（绿光晕=已连接 / 黄=需处理）+ Badge |
| 品牌 logo | lobehub(9) + img + 首字母 | 远程 iconUrl + 首字母 |

### Logo 来源调查结论（关键事实）

- **wanta 的 SaaS logo 绝大部分来自云端后端** `connector.oomol.com`（服务端注入远程 iconUrl），wanta 仓库内仅 19 个本地 SVG。
- **Lume 的后端是本地 OpenConnector 运行时**（sidecar, 127.0.0.1），与 wanta 云端不是同一后端，**拿不到 oomol 的远程 logo 池**。
- **OpenConnector 仓库（`oomol-lab/open-connector` v1.3.3，1201 个 provider）故意不内置任何品牌 logo**——`ProviderDefinition.iconUrl` 类型注释明确写 "third-party brand rights remain with their owners"，实测 1201 个 provider 的 `definition.ts` 中 0 个设置 iconUrl。
- **`@lobehub/icons`（Lume 已依赖 ^5.4.0，实际 v5.5.4，306 个图标）是 AI/开发者品牌库**，覆盖 github/notion/figma/vercel/openai/anthropic/cloudflare/google 等，但**不覆盖**通用 SaaS（slack/stripe/twilio/dropbox/gmail/outlook）与中国企业 IM（钉钉/飞书/企微）。

因此，要达到 wanta 级别的 logo 覆盖率，需引入广覆盖图标库（见 §6）。

## 2. 目标与非目标

### 目标
- link 页面布局、图标、配置控件、状态指示、品牌 logo 全面对齐 wanta。
- 保留 Lume 的 React 18 + base-ui + tab 路由架构与现有优势（lobehub AI 品牌 logo）。
- 保持所有既有功能正确性（虚拟化、OAuth 流、跨页通信）。

### 非目标
- 不引入 i18n 基建（跟随 Lume 硬编码中文现状）。
- 不迁移运行记录 IPC/数据层（仅移除其 UI）。
- 不复刻 wanta 的 OOMOL 云模式（Lume 无云连接器形态）。

## 3. 关键决策

| # | 决策项 | 选择 |
|---|---|---|
| D1 | 布局架构 | **全面对齐 wanta**：Tabs → Split-view 双栏，详情从弹窗改右侧面板 |
| D2 | 运行记录 | **仅移除 UI，保留 IPC/数据层** |
| D3 | 品牌 logo 渲染 | **保留 lobehub 作为 AI/dev 品牌增强层** |
| D4 | SaaS logo 来源 | **分层组合**：lobehub(扩) → simple-icons(新) → iconUrl → 首字母 |

## 4. 布局架构

### 实现策略：就地实现双栏，不抽通用 SplitView 原语

理由（YAGNI）：只有 link 页一个消费者，抽 `split-view.tsx` 通用原语是投机性抽象。用 Lume 现有 `lume-panel`/`lume-subpanel` CSS 类 + CSS Grid 在 link 页内部组合 wanta 的双栏结构。

### 结构

```
LinkView (根: flex h-full flex-col)
├─ !online → Placeholder 卡片（对齐 wanta SelfHostedConnectionsPlaceholder）
│            Plug 图标 + "连接器需要本机 OpenConnector Link 运行时"
│            + [打开 Link 运行时设置] 按钮 → 跳设置页
└─ online → SplitView 双栏
    ├─ 左栏 (ListPane)
    │   ├─ LinkToolbar：SearchField + ToggleGroup 筛选
    │   └─ 虚拟化 provider 网格 → ProviderCard × N（带状态点/徽章）
    └─ 右栏 (DetailPane, provider 选中时显示)
        ├─ 头部：ProviderIcon(lg) + 标题 + 状态 Badge + 描述 + 关闭按钮
        ├─ 连接区：连接按钮 + 认证 ToggleGroup + LinkAccountsList
        └─ 详情 dl：认证/分类/服务/版本
   未选中 provider 时左栏占满；选中时 grid-template-columns 过渡 + 右栏 slide-in-from-right-2 动画（用 tw-animate-css，已装）

   ConnectDialog（凭据/OAuth 表单）/ DisconnectDialog（断开确认）仍走弹窗。
```

## 5. 文件拆分

当前 `LinkView.tsx` 850+ 行单文件 + 内联 ProviderDialog。按 wanta 结构拆分（落到 Lume 命名）：

| 文件 | 对应 wanta | 职责 |
|---|---|---|
| `LinkView.tsx`（重写） | `ConnectionsPanel` | 双栏 shell + online/placeholder 分支 + 状态/IPC 编排 |
| `LinkCatalog.tsx`（新） | `ConnectionCatalog` | 左栏：工具栏 + 虚拟化网格（保留 useVirtualizer + ResizeObserver 列数计算） |
| `LinkToolbar.tsx`（新） | `ConnectionListToolbar` | SearchField + ToggleGroup 筛选 |
| `ProviderCard.tsx`（重写） | `ProviderCard` | 网格卡片：icon + 名称 + meta + 状态点/徽章 + 选中态左装饰条 |
| `LinkDetailPane.tsx`（新） | `ConnectionProviderDetailPane` | 右栏：头部 + 连接操作 + 账户列表 + 详情 dl |
| `LinkAccountsList.tsx`（新） | `ConnectionAccountsList` | 已连接账户卡片（别名编辑 + 重连/断开） |
| `LinkConnectDialog.tsx`（新） | `ConnectDialog` | 凭据/OAuth 表单（从现 ProviderDialog 抽出表单部分） |
| `ProviderIcon.tsx`（扩展） | `ProviderIcon` | 扩展多档 logo 链（见 §6） |
| `lib/provider-icon.ts`（扩展） | — | 扩 lobehub 映射 + simple-icons 归一化 |

**删除**：现 `LinkView.tsx` 里的 runs 相关 UI（运行记录 Tab、run 列表、run-detail Dialog、runs 状态变量）。**保留** `lib/desktop-api/link.ts` 的 runs IPC 函数与 `LinkRunSummary`/`LinkRunDetail`/`LinkRunPage` 类型（非目标 D2）。

## 6. 品牌 Logo 渲染链（D3 + D4）

### 多档兜底链

```
ProviderIcon(service, displayName, iconUrl)
  ① lobehub 命中（扩 AI/dev 品牌）   → lobehub Mono SVG（可着色）
  ② simple-icons 命中（3000+ SaaS）  → 品牌 SVG path（可用品牌 hex）
  ③ iconUrl 存在（运行时若有）        → <img>
  ④ 兜底                              → 首字母色块（与 wanta 一致）
```

### lobehub 层（扩展现有）
- 现有 `LOBEHUB_SERVICES` 仅 9 个（github/notion/microsoft/figma/vercel/openai/anthropic/cohere/perplexity）。
- 扩展到覆盖 lobehub 库内所有出现在 OpenConnector 目录中的 AI/dev 品牌（mistral/groq/deepseek/qwen/gemini/...）。
- 保留深路径直连 `@lobehub/icons/es/<Icon>/components/Mono`（绕开 React 19 `use()` 兼容问题，见 ProviderIcon.tsx 顶部注释）。
- lobehub 在重叠品牌上优先于 simple-icons（可着色 SVG 组件更优）。

### simple-icons 层（新增）
- 新增依赖 `simple-icons`（3000+ 品牌 SVG path data，MIT）。
- service id 归一化：OpenConnector 用 snake_case（`microsoft_teams`）→ simple-icons slug（kebab-case `microsoft-teams`）。配少量手工 override 表处理不一致（如 `active_campaign`→`activecampaign`）。
- 渲染：薄 `SimpleIcon` 组件，`<svg viewBox="0 0 24 24"><path d={icon.path}/></svg>`，默认 `currentColor`，可选品牌 hex。
- **bundle 策略**（关注点，见 [[project_lume-link-openconnector-bundle]]）：倾向**构建期生成 `service→iconPath` 映射表**（脚本读 OpenConnector service 列表 + simple-icons 索引，输出仅命中的 ~400-600 条；产物小、O(1) 查找、可 tree-shake）；运行期全量索引作为简化 fallback。最终方案在实施计划定。

## 7. 组件复用 / 新建

- **复用**：`Button`、`Badge`(success/warning/secondary)、`Dialog`/`ConfirmDialog`、`Input`、`Textarea`、`Select`、`ProviderIcon`、`useVirtualizer`、`tw-animate-css`、`lume-panel`/`lume-subpanel` CSS 类。
- **新建（薄封装）**：
  - `ToggleGroup`——base-ui `@base-ui/react/toggle-group` 薄封装，单选组 + 计数 badge，放 `components/ui/toggle-group.tsx`。
  - `SearchField`——`Input` + lucide `Search` 图标，~10 行，放 `components/ui/search-field.tsx`。
- **状态点**：内联样式 + `--lume-success`/`--lume-warning`，不新建组件。

## 8. Token 映射（wanta → lume）

| wanta 视觉 | lume 落地 |
|---|---|
| `oo-text-title` | `text-base font-semibold text-[var(--lume-text-1)]` |
| `oo-text-caption` / `oo-text-muted` | `text-xs text-[var(--lume-text-3)]` |
| `oo-connection-active-dot`（绿光晕） | `bg-[var(--lume-success)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--lume-success)_18%,transparent)]` |
| attention 点 `--warning` | `bg-[var(--lume-warning)]` |
| 选中卡 `--accent-ring`+`--accent-soft` | `border-[var(--lume-focus-ring)] bg-[var(--lume-accent-soft)]` |
| 选中左装饰条 `--accent-strong` | `before:bg-[var(--lume-accent)]` |
| 断开按钮 `--oo-danger-*` | `border-[var(--lume-danger)] text-[var(--lume-danger)]` |
| 导航图标 `Plug` | 侧栏 `PlugZap` → `Plug`（lucide, size-4） |

## 9. 必须保留的不变量（重写中不可丢）

1. **虚拟化**：`useVirtualizer` 多列 + `ResizeObserver` 列数计算（catalog 1194 provider 性能关键）。
2. **OAuth 流**：`setInterval(1500ms)` 轮询 `getLinkOAuthStatus`、系统浏览器授权、`expectedRedirectUri` 回显——从 ProviderDialog 迁入 `LinkConnectDialog`。
3. **跨页通信**：`linkProviderTargetAtom`（agent 工具卡 `link-result.tsx` → 自动打开对应 provider 详情）。
4. **IPC 数据层**：`lib/desktop-api/link.ts` 全部保留（含 runs 函数）。
5. **事件订阅**：`onLinkRuntimeState` + `onLinkDataChanged`（`link:connections-changed` / `link:authorization-changed`）→ `refresh()`。

## 10. 范围假设

- **A1**：Lume 不需要 wanta 的 `OpenConnectorConnectionsPanel`（远程自托管 OpenConnector 的简化"只读 app 列表"面板）。理由：Lume 运行时是本地 OpenConnector，始终呈现完整目录 + 本地凭据配置，对应 wanta 富模式 `ConnectionsPanel`（OOMOL 模式），非简化只读面板。→ Lume 只需 2 态：online（富双栏）/ not-online（placeholder）。
- **A2**：wanta 的 OOMOL 云模式对 Lume 不适用（Lume 无云连接器形态）。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| simple-icons 增加 bundle 体积 | 构建期生成命中映射表，仅打包命中的 ~400-600 条；实施期实测体积 |
| 850 行重写引入回归 | 保留虚拟化/OAuth/跨页通信不变量；分文件增量重写；typecheck + ProviderIcon 既有测试守底 |
| lobehub 扩展映射量大 | 仅映射 OpenConnector 目录中实际出现的 service；按 lobehub 库内品牌逐个加 |
| 运行记录 UI 移除后误删数据层 | 仅删 UI 与 state，IPC/类型保留；grep 确认无悬空引用 |

## 12. 后续

- 本设计批准后，进入 `superpowers:writing-plans` 编写分步实施计划。
- 实施计划须覆盖：worktree 依赖安装、分文件增量重写顺序、token 映射验证、simple-icons 接入与 bundle 实测、typecheck、视觉对照 wanta 截图验收。
