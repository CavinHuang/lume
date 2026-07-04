# Plugin Detail Page README and Setup Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plugin detail modal with an independent plugin detail page that reads README content on demand and shows `README / Setup / 权限 / 诊断` horizontal tabs.

**Architecture:** Keep the marketplace catalog lightweight. `GET_MARKET_DETAIL` gains optional README payloads, while the Web `SkillsMarketView` switches between the market list and a dedicated `PluginDetailPage` sub-view. UI-only formatting and checklist logic moves into `plugin-detail-state.ts` so the large market component does not absorb more behavior.

**Tech Stack:** TypeScript, React, Bun tests, existing sidecar plugin market service, existing `@ant-design/x-markdown`, existing shadcn/global `Tabs` and `Button` UI primitives.

---

## Scope Notes

- Existing worktree contains many unrelated user changes. Do not revert them.
- This plan only touches the files listed in each task.
- No new dependencies.
- No full Chrome or Obsidian setup wizard in this slice.
- No new `lume-plugin.json` setup schema in this slice.
- Use existing UI atoms from `apps/web/src/components/ui` for tabs and buttons.

## File Structure

- Modify `packages/shared/src/types/plugin-market.ts`
  - Add a `PluginReadmePreview` type and optional `readme` field on `GetMarketDetailResult`.
- Modify `apps/sidecar/src/services/plugins/plugin-market-service.ts`
  - Read `README.md` only in detail requests.
  - Truncate README content after 256 KiB.
  - Treat missing README as non-error.
- Modify `apps/sidecar/src/services/plugins/plugin-market-service.test.ts`
  - Lock local README return and missing README tolerance.
- Create `apps/web/src/components/skills/plugin-detail-state.ts`
  - Move permission rows and plugin setup checklist state into pure helpers.
- Create `apps/web/src/components/skills/plugin-detail-state.test.ts`
  - Lock permission rows, setup items, and README metadata formatting.
- Create `apps/web/src/components/skills/PluginDetailPage.tsx`
  - Dedicated centered detail page with header actions and horizontal tabs.
- Create `apps/web/src/components/skills/PluginDetailPage.test.tsx`
  - SSR smoke test for the page structure and README markdown renderer.
- Modify `apps/web/src/components/skills/SkillsMarketView.tsx`
  - Replace the plugin modal state with an inline detail sub-view.
  - Keep skill detail modal unchanged.
  - Remove `PluginDetailDialog` after `PluginDetailPage` is wired.

---

## Task 1: Detail API README Contract

**Files:**
- Modify: `packages/shared/src/types/plugin-market.ts`
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.test.ts`
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.ts`

- [ ] **Step 1: Add failing sidecar tests**

Add these tests in `apps/sidecar/src/services/plugins/plugin-market-service.test.ts`, near the existing `getMarketDetail` test around `installs marketplace plugin items by item id after permission review`:

```ts
  test("plugin detail returns README content for local plugin sources", async () => {
    const pluginRoot = join(root, "source", "readme-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "readme-plugin",
      version: "1.0.0",
      description: "README demo"
    });
    await writeFile(join(pluginRoot, "README.md"), "# README demo\n\nUse this plugin carefully.", "utf-8");
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "readme-plugin",
          name: "README Plugin",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const detail = await makeService(root).getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:readme-plugin"
    });

    expect(detail.readme).toMatchObject({
      markdown: "# README demo\n\nUse this plugin carefully.",
      truncated: false
    });
    expect(detail.readme?.path).toEndWith("README.md");
  });

  test("plugin detail tolerates missing README", async () => {
    const pluginRoot = join(root, "source", "missing-readme-plugin");
    const indexPath = join(root, "market.json");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "missing-readme-plugin",
      version: "1.0.0"
    });
    await writeJson(indexPath, {
      items: [
        {
          kind: "plugin",
          id: "missing-readme-plugin",
          name: "Missing README Plugin",
          source: { type: "local", path: pluginRoot }
        }
      ]
    });
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        marketSources: [DISABLED_OFFICIAL_MARKET_SOURCE, { id: "local-market", name: "Local", kind: "local-index", path: indexPath, enabled: true }]
      }
    }), "utf-8");

    const detail = await makeService(root).getMarketDetail({
      workspaceSlug: "default",
      kind: "plugin",
      itemId: "local-market:missing-readme-plugin"
    });

    expect(detail.item.kind).toBe("plugin");
    expect(detail.readme).toBeUndefined();
  });
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
rtk bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "README"
```

Expected: FAIL because `detail.readme` is not returned and the shared type has no `readme` field.

- [ ] **Step 3: Add the shared README type**

In `packages/shared/src/types/plugin-market.ts`, add this interface before `GetMarketDetailResult`:

```ts
export interface PluginReadmePreview {
  markdown: string
  path?: string
  truncated?: boolean
}
```

Then update `GetMarketDetailResult`:

```ts
export interface GetMarketDetailResult {
  item: MarketCatalogItem
  inspect?: InspectMarketSourceResult
  diagnostics: AgentPluginDiagnostic[]
  readme?: PluginReadmePreview
}
```

- [ ] **Step 4: Implement README loading in the sidecar service**

In `apps/sidecar/src/services/plugins/plugin-market-service.ts`, update the type import block to include `PluginReadmePreview`:

```ts
  PluginMarketItem,
  PluginPermissionSummary,
  PluginReadmePreview,
  PluginSourceRef,
```

Add this constant near `const execFileAsync = promisify(execFile);`:

```ts
const README_MAX_BYTES = 256 * 1024;
```

Update the plugin branch in `getMarketDetail`:

```ts
    const source = await this.resolveInspectSource(parseMarketItemId(input.itemId));
    const inspected = await this.inspectPluginSource(input.workspaceSlug, source);
    const item = this.toMarketItem(inspected.normalized, input.workspaceSlug, source.type);
    const readme = await this.readPluginReadme(source);
    item.id = input.itemId;
    return {
      item: { kind: "plugin", plugin: item },
      inspect: inspected,
      diagnostics: inspected.diagnostics,
      ...(readme ? { readme } : {}),
    };
```

Add these private methods after `inspectGitHubPlugin`:

```ts
  private async readPluginReadme(source: PluginSourceRef): Promise<PluginReadmePreview | undefined> {
    try {
      if (source.type === "subscribed-market") {
        return this.readPluginReadme(source.resolved);
      }
      if (source.type === "github") {
        return await this.readGitHubReadme(source);
      }
      return this.readLocalReadme(source.path);
    } catch {
      return undefined;
    }
  }

  private readLocalReadme(pluginRoot: string): PluginReadmePreview | undefined {
    const readmePath = join(resolve(pluginRoot), "README.md");
    if (!existsSync(readmePath)) return undefined;
    return truncateReadme(readFileSync(readmePath, "utf-8"), readmePath);
  }

  private async readGitHubReadme(source: Extract<PluginSourceRef, { type: "github" }>): Promise<PluginReadmePreview | undefined> {
    const tree = await this.fetchGitHubTree(source);
    const prefix = source.subdir ? `${source.subdir.replace(/\/$/, "")}/` : "";
    const match = tree.find((entry) =>
      entry.type === "blob"
      && entry.path.toLowerCase() === `${prefix}readme.md`.toLowerCase()
    );
    if (!match) return undefined;
    return truncateReadme(await this.fetchText(rawGitHubUrl(source, match.path)), match.path);
  }
```

Add this helper near `readJsonIfExists`:

```ts
function truncateReadme(markdown: string, path: string): PluginReadmePreview {
  if (Buffer.byteLength(markdown, "utf-8") <= README_MAX_BYTES) {
    return { markdown, path, truncated: false };
  }
  const buffer = Buffer.from(markdown, "utf-8").subarray(0, README_MAX_BYTES);
  return {
    markdown: buffer.toString("utf-8").replace(/\uFFFD+$/g, ""),
    path,
    truncated: true,
  };
}
```

- [ ] **Step 5: Run the focused tests and verify pass**

Run:

```bash
rtk bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "README"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/plugin-market.ts apps/sidecar/src/services/plugins/plugin-market-service.ts apps/sidecar/src/services/plugins/plugin-market-service.test.ts
git commit -m "✨ feat(sidecar,shared): 插件详情返回 README 预览" -m "GET_MARKET_DETAIL 在插件详情请求中按需读取 README.md，市场列表仍保持轻量。缺失或读取失败不阻断详情页，超大 README 按 256KiB 截断。" -m "Constraint: 不把 README 放入 marketplace catalog" -m "Tested: rtk bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t README"
```

---

## Task 2: Plugin Detail Pure State Helpers

**Files:**
- Create: `apps/web/src/components/skills/plugin-detail-state.ts`
- Create: `apps/web/src/components/skills/plugin-detail-state.test.ts`
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`

- [ ] **Step 1: Write pure helper tests**

Create `apps/web/src/components/skills/plugin-detail-state.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { PluginMarketItem } from '@lume/shared'
import {
  buildPermissionRows,
  buildPluginSetupItems,
  formatPluginEnableState,
  formatPluginInstallState,
  formatReadmeMeta,
  formatRiskLabel,
} from './plugin-detail-state'

function plugin(input: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return {
    id: 'local:demo',
    pluginId: 'demo',
    name: 'Demo',
    version: '1.0.0',
    sourceType: 'local',
    trustLevel: 'trusted',
    installState: 'installed',
    enableState: 'workspace-enabled',
    capabilities: {
      skillCount: 1,
      hookEvents: ['SessionStart'],
      mcpServerNames: ['mcp.json'],
      commandToolNames: ['demo_run'],
    },
    permissions: {
      filesystemRead: ['./docs/**'],
      filesystemWrite: ['./data/**'],
      networkOutbound: ['127.0.0.1:*'],
      mcpRegister: true,
      shellAllow: false,
      toolAllow: ['Read'],
      toolAsk: ['Bash'],
      toolDeny: [],
      hookEvents: ['SessionStart'],
      riskLabels: ['network', 'write', 'mcp'],
    },
    ...input,
  }
}

describe('plugin-detail-state', () => {
  test('formats plugin states and risk labels', () => {
    expect(formatPluginInstallState('installed')).toBe('已安装')
    expect(formatPluginInstallState('update-available')).toBe('有更新')
    expect(formatPluginEnableState('workspace-enabled')).toBe('工作区启用')
    expect(formatRiskLabel('network')).toBe('网络')
  })

  test('builds permission rows from plugin permissions', () => {
    const rows = buildPermissionRows(plugin())
    expect(rows.find((row) => row.label === '网络访问')?.value).toBe('127.0.0.1:*')
    expect(rows.find((row) => row.label === '写入文件')?.value).toBe('./data/**')
    expect(rows.find((row) => row.label === 'Shell')?.value).toBe('未声明')
  })

  test('builds setup checklist from plugin shape', () => {
    const items = buildPluginSetupItems(plugin())
    expect(items.map((item) => item.title)).toEqual([
      '确认插件已安装',
      '启用当前工作区',
      '检查本地连接',
      '检查 MCP 服务',
    ])
    expect(items.some((item) => item.status === 'attention')).toBe(true)
  })

  test('formats README metadata', () => {
    expect(formatReadmeMeta({ markdown: '# Demo', path: 'README.md', truncated: false })).toBe('README.md')
    expect(formatReadmeMeta({ markdown: '# Demo', path: 'README.md', truncated: true })).toBe('README.md · 已截断')
    expect(formatReadmeMeta(undefined)).toBe('未找到 README.md')
  })
})
```

- [ ] **Step 2: Run helper tests and verify fail**

Run:

```bash
rtk bun test apps/web/src/components/skills/plugin-detail-state.test.ts
```

Expected: FAIL because `plugin-detail-state.ts` does not exist.

- [ ] **Step 3: Create helper implementation**

Create `apps/web/src/components/skills/plugin-detail-state.ts`:

```ts
import type { PluginMarketItem, PluginReadmePreview } from '@lume/shared'

export interface PermissionRow {
  label: string
  value: string
}

export interface PluginSetupItem {
  title: string
  description: string
  status: 'done' | 'attention' | 'idle'
}

export function formatPluginInstallState(state: PluginMarketItem['installState']): string {
  switch (state) {
    case 'installed':
      return '已安装'
    case 'update-available':
      return '有更新'
    case 'not-installed':
      return '未安装'
  }
}

export function formatPluginEnableState(state: PluginMarketItem['enableState']): string {
  switch (state) {
    case 'global-enabled':
      return '全局启用'
    case 'workspace-enabled':
      return '工作区启用'
    case 'disabled':
      return '已禁用'
    case 'needs-review':
      return '需要审核'
    case 'not-installed':
      return '未安装'
  }
}

export function formatRiskLabel(risk: PluginMarketItem['permissions']['riskLabels'][number]): string {
  switch (risk) {
    case 'shell':
      return 'Shell'
    case 'network':
      return '网络'
    case 'write':
      return '写文件'
    case 'mcp':
      return '注册 MCP'
    case 'high-risk-tool':
      return '高风险工具'
  }
}

export function buildPermissionRows(item: PluginMarketItem): PermissionRow[] {
  const permissions = item.permissions
  return [
    { label: '读取文件', value: formatPermissionList(permissions.filesystemRead) },
    { label: '写入文件', value: formatPermissionList(permissions.filesystemWrite) },
    { label: '网络访问', value: formatPermissionList(permissions.networkOutbound) },
    { label: '工具允许', value: formatPermissionList(permissions.toolAllow) },
    { label: '工具询问', value: formatPermissionList(permissions.toolAsk) },
    { label: '工具拒绝', value: formatPermissionList(permissions.toolDeny) },
    { label: 'Hook 事件', value: formatPermissionList(permissions.hookEvents) },
    { label: 'Shell', value: permissions.shellAllow ? '允许' : '未声明' },
    { label: 'MCP 注册', value: permissions.mcpRegister ? '允许' : '未声明' },
  ]
}

export function buildPluginSetupItems(item: PluginMarketItem): PluginSetupItem[] {
  const installed = item.installState === 'installed'
  const enabled = item.enableState === 'global-enabled' || item.enableState === 'workspace-enabled'
  const needsLocalConnection = item.permissions.networkOutbound.some((entry) =>
    entry.includes('127.0.0.1') || entry.includes('localhost')
  )
  const hasMcp = item.capabilities.mcpServerNames.length > 0 || item.permissions.mcpRegister
  const items: PluginSetupItem[] = [
    {
      title: '确认插件已安装',
      description: installed ? `当前版本 ${item.version} 已安装。` : '安装后才能启用和配置连接。',
      status: installed ? 'done' : 'attention',
    },
    {
      title: '启用当前工作区',
      description: enabled ? formatPluginEnableState(item.enableState) : '安装后可在当前工作区启用。',
      status: enabled ? 'done' : 'idle',
    },
  ]
  if (needsLocalConnection) {
    items.push({
      title: '检查本地连接',
      description: '该插件声明了本地网络访问，安装后需要确认外部应用或本地服务可用。',
      status: 'attention',
    })
  }
  if (hasMcp) {
    items.push({
      title: '检查 MCP 服务',
      description: '该插件包含 MCP 服务，安装或更新后需要等待服务注册完成。',
      status: 'attention',
    })
  }
  return items
}

export function formatReadmeMeta(readme: PluginReadmePreview | undefined): string {
  if (!readme) return '未找到 README.md'
  const base = readme.path ?? 'README.md'
  return readme.truncated ? `${base} · 已截断` : base
}

function formatPermissionList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '未声明'
}
```

- [ ] **Step 4: Remove duplicate helpers from `SkillsMarketView` imports in a narrow way**

Do not delete `formatInstallState`; skill detail still uses it. Add imports near the existing `plugin-market-ui-state` import:

```ts
import {
  buildPermissionRows,
  formatPluginEnableState,
  formatPluginInstallState,
  formatRiskLabel,
} from './plugin-detail-state'
```

Then replace plugin-only calls:

```tsx
{formatPluginInstallState(item.installState)}
```

Keep the existing local `formatInstallState` for skill details, or rename it to `formatSkillInstallState` in a later cleanup only if the file becomes confusing.

Delete the local `formatPluginEnableState`, `formatRiskLabel`, `buildPermissionRows`, and `formatPermissionList` functions at the bottom of `SkillsMarketView.tsx`.

- [ ] **Step 5: Run helper tests**

Run:

```bash
rtk bun test apps/web/src/components/skills/plugin-detail-state.test.ts apps/web/src/components/skills/plugin-market-ui-state.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/skills/plugin-detail-state.ts apps/web/src/components/skills/plugin-detail-state.test.ts apps/web/src/components/skills/SkillsMarketView.tsx
git commit -m "✨ feat(web): 抽出插件详情页状态 helpers" -m "将插件权限行、Setup 清单、README 元信息等可测逻辑从市场视图中抽出，为独立插件详情页复用做准备。" -m "Tested: rtk bun test apps/web/src/components/skills/plugin-detail-state.test.ts apps/web/src/components/skills/plugin-market-ui-state.test.ts"
```

---

## Task 3: Dedicated Plugin Detail Page Component

**Files:**
- Create: `apps/web/src/components/skills/PluginDetailPage.tsx`
- Create: `apps/web/src/components/skills/PluginDetailPage.test.tsx`

- [ ] **Step 1: Write the component SSR test**

Create `apps/web/src/components/skills/PluginDetailPage.test.tsx`:

```tsx
import React from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GetMarketDetailResult, PluginMarketItem } from '@lume/shared'

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <article data-x-markdown="true" className={className}>{children}</article>
  ),
}))

const { PluginDetailPage } = await import('./PluginDetailPage')

function plugin(input: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return {
    id: 'local:browser',
    pluginId: 'browser',
    name: 'Browser',
    displayName: 'Browser',
    description: 'Control the in-app browser with Codex',
    version: '26.623.101652',
    sourceType: 'local',
    trustLevel: 'trusted',
    installState: 'installed',
    enableState: 'workspace-enabled',
    capabilities: {
      skillCount: 1,
      hookEvents: [],
      mcpServerNames: [],
      commandToolNames: ['browser'],
    },
    permissions: {
      filesystemRead: [],
      filesystemWrite: [],
      networkOutbound: ['127.0.0.1:*'],
      mcpRegister: false,
      shellAllow: false,
      toolAllow: ['Read'],
      toolAsk: [],
      toolDeny: [],
      hookEvents: [],
      riskLabels: ['network'],
    },
    ...input,
  }
}

function detail(item = plugin()): GetMarketDetailResult {
  return {
    item: { kind: 'plugin', plugin: item },
    inspect: {
      kind: 'plugin',
      normalized: {
        pluginId: item.pluginId,
        name: item.name,
        version: item.version,
        displayName: item.displayName,
        description: item.description,
      },
      permissionSummary: item.permissions,
      permissionsHash: 'hash-1',
      installState: item.installState,
      enableState: item.enableState,
      diagnostics: [],
    },
    diagnostics: [],
    readme: { markdown: '# Browser\n\nUse Browser from Lume.', path: 'README.md', truncated: false },
  }
}

describe('PluginDetailPage', () => {
  test('renders independent detail page with horizontal tabs and README', () => {
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={detail()}
        loading={false}
        error={null}
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
      />,
    )

    expect(html).toContain('插件')
    expect(html).toContain('Browser')
    expect(html).toContain('README')
    expect(html).toContain('Setup')
    expect(html).toContain('权限')
    expect(html).toContain('诊断')
    expect(html).toContain('data-x-markdown="true"')
    expect(html).toContain('在对话中试用')
  })

  test('renders README empty state when README is missing', () => {
    const noReadme = detail()
    delete noReadme.readme
    const html = renderToStaticMarkup(
      <PluginDetailPage
        detail={noReadme}
        loading={false}
        error={null}
        busy={false}
        onBack={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onToggleEnable={() => {}}
        onTryInChat={() => {}}
      />,
    )

    expect(html).toContain('未找到 README.md')
  })
})
```

- [ ] **Step 2: Run test and verify fail**

Run:

```bash
rtk bun test apps/web/src/components/skills/PluginDetailPage.test.tsx
```

Expected: FAIL because `PluginDetailPage.tsx` does not exist.

- [ ] **Step 3: Create the page component**

Create `apps/web/src/components/skills/PluginDetailPage.tsx` with the structure below. Use concise JSX and reuse helpers instead of copying logic back into the component.

```tsx
import { XMarkdown } from '@ant-design/x-markdown'
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Power,
  Puzzle,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import type { GetMarketDetailResult } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { PLUGIN_SOURCE_LABELS } from './plugin-market-ui-state'
import {
  buildPermissionRows,
  buildPluginSetupItems,
  formatPluginEnableState,
  formatPluginInstallState,
  formatReadmeMeta,
  formatRiskLabel,
} from './plugin-detail-state'

interface PluginDetailPageProps {
  detail: GetMarketDetailResult | null
  loading: boolean
  error: string | null
  busy: boolean
  onBack: () => void
  onInstall: () => void
  onUninstall: () => void
  onToggleEnable: () => void
  onTryInChat: () => void
}

export function PluginDetailPage({
  detail,
  loading,
  error,
  busy,
  onBack,
  onInstall,
  onUninstall,
  onToggleEnable,
  onTryInChat,
}: PluginDetailPageProps) {
  const item = detail?.item.kind === 'plugin' ? detail.item.plugin : null
  const inspected = detail?.inspect?.kind === 'plugin' ? detail.inspect : null
  const readme = detail?.readme
  const permissionRows = item ? buildPermissionRows(item) : []
  const setupItems = item ? buildPluginSetupItems(item) : []
  const canInstall = Boolean(item && inspected && item.installState !== 'installed')
  const canToggle = Boolean(item && item.installState === 'installed')
  const enabled = item?.enableState === 'global-enabled' || item?.enableState === 'workspace-enabled'

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[var(--surface-1)]">
      <div className="mx-auto w-full max-w-[920px] px-6 py-7">
        <div className="mb-10 flex items-center gap-3 text-[13px] text-[var(--text-3)]">
          <Button variant="ghost" type="button" onClick={onBack} className="h-8 gap-2 px-2 text-[13px] text-[var(--text-3)]">
            <ArrowLeft size={15} />
            插件
          </Button>
          <span>/</span>
          <span className="text-[var(--text-1)]">{item?.displayName ?? item?.name ?? '插件详情'}</span>
        </div>

        {loading ? (
          <div className="flex min-h-[360px] items-center justify-center gap-2 text-[13px] text-[var(--text-3)]">
            <Loader2 size={16} className="animate-spin" />
            正在读取插件详情...
          </div>
        ) : error && !item ? (
          <div className="rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_24%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-5 text-[13px] leading-6 text-[var(--lume-danger)]">
            {error}
          </div>
        ) : item ? (
          <div className="space-y-8">
            <header className="space-y-5">
              <div className="flex items-start justify-between gap-6">
                <div className="min-w-0">
                  <div className="mb-5 flex size-14 items-center justify-center rounded-[14px] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-1)]">
                    <Puzzle size={28} />
                  </div>
                  <h1 className="truncate text-[34px] font-semibold leading-tight text-[var(--text-1)]">{item.displayName ?? item.name}</h1>
                  <p className="mt-2 max-w-[680px] text-[18px] leading-7 text-[var(--text-2)]">{item.description ?? '暂无描述。'}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-24">
                  <Button variant="ghost" type="button" title="更多操作" className="size-9 rounded-[8px] text-[var(--text-3)]">
                    <MoreHorizontal size={18} />
                  </Button>
                  {item.installState === 'installed' ? (
                    <Button type="button" onClick={onTryInChat} className="h-9 gap-2 rounded-[8px] bg-[var(--text-1)] px-4 text-[13px] font-semibold text-[var(--surface-1)]">
                      <ExternalLink size={15} />
                      在对话中试用
                    </Button>
                  ) : (
                    <Button type="button" disabled={!canInstall || busy} onClick={onInstall} className="h-9 gap-2 rounded-[8px] bg-[var(--brand)] px-4 text-[13px] font-semibold text-[var(--brand-foreground)] disabled:opacity-55">
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
                      {item.installState === 'update-available' ? '确认权限并更新' : '确认权限并安装'}
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge>{PLUGIN_SOURCE_LABELS[item.sourceType]}</Badge>
                <Badge>{formatPluginInstallState(item.installState)}</Badge>
                <Badge>{formatPluginEnableState(item.enableState)}</Badge>
                <Badge>v{item.version}</Badge>
              </div>

              <section className="flex min-h-[132px] items-center justify-center rounded-[18px] border border-[var(--border)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--brand)_16%,var(--surface-2)),var(--surface-1))] px-8">
                <div className="rounded-[18px] border border-[var(--border)] bg-[color:color-mix(in_oklab,var(--surface-1)_82%,transparent)] px-5 py-3 text-[14px] text-[var(--text-2)] shadow-[0_12px_32px_-24px_hsl(var(--lume-shadow-panel)/0.55)]">
                  <span className="font-semibold text-[var(--text-1)]">{item.displayName ?? item.name}</span>
                  <span className="ml-3">打开 README、检查 Setup、确认权限后再安装。</span>
                </div>
              </section>
            </header>

            {error && (
              <div className="rounded-[8px] bg-[color:color-mix(in_oklab,var(--lume-warning)_9%,var(--surface-1))] p-4 text-[13px] leading-6 text-[var(--lume-warning)]">
                {error}
              </div>
            )}

            <Tabs defaultValue="readme" className="gap-5">
              <TabsList variant="line" className="border-b border-[var(--border)]">
                <TabsTrigger value="readme" className="px-0 text-[14px]">README</TabsTrigger>
                <TabsTrigger value="setup" className="px-0 text-[14px]">Setup</TabsTrigger>
                <TabsTrigger value="permissions" className="px-0 text-[14px]">权限</TabsTrigger>
                <TabsTrigger value="diagnostics" className="px-0 text-[14px]">诊断</TabsTrigger>
              </TabsList>

              <TabsContent value="readme">
                {readme ? (
                  <section className="space-y-3">
                    <div className="text-[12px] text-[var(--text-3)]">{formatReadmeMeta(readme)}</div>
                    <XMarkdown className="x-markdown text-[15px] leading-8 text-[var(--text-1)]">
                      {readme.markdown}
                    </XMarkdown>
                  </section>
                ) : (
                  <EmptyPanel title="未找到 README.md" description="该插件没有提供 README，仍可查看 Setup、权限和诊断信息。" />
                )}
              </TabsContent>

              <TabsContent value="setup">
                <div className="space-y-3">
                  {setupItems.map((setup) => (
                    <div key={setup.title} className="flex gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-4">
                      <CheckCircle2 size={18} className={cn(setup.status === 'done' ? 'text-[var(--lume-success)]' : setup.status === 'attention' ? 'text-[var(--lume-warning)]' : 'text-[var(--text-3)]')} />
                      <div>
                        <div className="text-[13px] font-semibold text-[var(--text-1)]">{setup.title}</div>
                        <div className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{setup.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="permissions">
                <section className="space-y-4">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-1)]">
                    <ShieldCheck size={18} className="text-[var(--lume-success)]" />
                    权限审核
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.permissions.riskLabels.length > 0 ? item.permissions.riskLabels.map((risk) => (
                      <Badge key={risk} tone="warning">{formatRiskLabel(risk)}</Badge>
                    )) : (
                      <Badge tone="success">低风险</Badge>
                    )}
                  </div>
                  <div className="space-y-3">
                    {permissionRows.map((row) => (
                      <div key={row.label} className="grid gap-2 rounded-[8px] bg-[var(--surface-2)] px-3 py-2 text-[12px] leading-5 md:grid-cols-[120px_minmax(0,1fr)]">
                        <span className="font-semibold text-[var(--text-1)]">{row.label}</span>
                        <span className="break-all text-[var(--text-2)]">{row.value}</span>
                      </div>
                    ))}
                  </div>
                  {inspected && <div className="rounded-[8px] bg-[var(--surface-2)] px-3 py-2 text-[12px] leading-5 text-[var(--text-2)]">权限 hash：<span className="font-mono">{inspected.permissionsHash}</span></div>}
                </section>
              </TabsContent>

              <TabsContent value="diagnostics">
                {detail.diagnostics.length > 0 || item.diagnostics?.length ? (
                  <ul className="space-y-2 text-[13px] leading-6 text-[var(--lume-warning)]">
                    {[...(detail.diagnostics ?? []), ...(item.diagnostics ?? [])].map((diagnostic, index) => (
                      <li key={`${diagnostic.code}-${index}`} className="rounded-[8px] bg-[color:color-mix(in_oklab,var(--lume-warning)_9%,var(--surface-1))] p-3">{diagnostic.message}</li>
                    ))}
                  </ul>
                ) : (
                  <EmptyPanel title="暂无诊断信息" description="插件清单、权限和来源检查未返回需要处理的问题。" />
                )}
              </TabsContent>
            </Tabs>

            {item.installState === 'installed' && (
              <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-5">
                <Button variant="ghost" type="button" disabled={!canToggle || busy} onClick={onToggleEnable} className="h-9 gap-2 rounded-[8px] border border-[var(--border)] px-4 text-[13px] font-semibold">
                  <Power size={15} />
                  {enabled ? '禁用' : '启用'}
                </Button>
                <Button variant="ghost" type="button" disabled={busy} onClick={onUninstall} className="h-9 gap-2 rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_32%,var(--border))] px-4 text-[13px] font-semibold text-[var(--lume-danger)]">
                  <Trash2 size={15} />
                  卸载
                </Button>
              </div>
            )}
          </div>
        ) : (
          <EmptyPanel title="暂无插件详情" description="返回插件市场后重新选择一个插件。" />
        )}
      </div>
    </div>
  )
}

function Badge({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'warning' | 'success' }) {
  return (
    <span className={cn(
      'rounded-[5px] px-2 py-1 text-[12px] font-medium',
      tone === 'warning'
        ? 'bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] text-[var(--lume-warning)]'
        : tone === 'success'
          ? 'bg-[color:color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] text-[var(--lume-success)]'
          : 'bg-[var(--surface-2)] text-[var(--text-2)]',
    )}>
      {children}
    </span>
  )
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[8px] border border-dashed border-[var(--border)] p-8 text-center">
      <div className="text-[14px] font-semibold text-[var(--text-1)]">{title}</div>
      <div className="mt-2 text-[13px] leading-6 text-[var(--text-3)]">{description}</div>
    </div>
  )
}
```

- [ ] **Step 4: Run component test**

Run:

```bash
rtk bun test apps/web/src/components/skills/PluginDetailPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/skills/PluginDetailPage.tsx apps/web/src/components/skills/PluginDetailPage.test.tsx
git commit -m "✨ feat(web): 新增独立插件详情页组件" -m "新增居中内容列插件详情页，包含 header 主操作、README / Setup / 权限 / 诊断 横向 Tabs，并复用现有 markdown 与 UI 原子组件。" -m "Tested: rtk bun test apps/web/src/components/skills/PluginDetailPage.test.tsx"
```

---

## Task 4: Wire Detail Page into Skills Market View

**Files:**
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`
- Modify: `apps/web/src/components/skills/skill-market-boundary.test.ts`

- [ ] **Step 1: Add boundary test for no plugin detail modal**

In `apps/web/src/components/skills/skill-market-boundary.test.ts`, add:

```ts
  test('plugin details use an independent page rather than a modal dialog', () => {
    const content = source('apps/web/src/components/skills/SkillsMarketView.tsx')

    expect(content).toContain('PluginDetailPage')
    expect(content).not.toContain('PluginDetailDialog')
    expect(content).not.toContain('pluginDetailOpen')
  })
```

- [ ] **Step 2: Run boundary test and verify fail**

Run:

```bash
rtk bun test apps/web/src/components/skills/skill-market-boundary.test.ts -t "plugin details"
```

Expected: FAIL because `SkillsMarketView.tsx` still contains `PluginDetailDialog` and `pluginDetailOpen`.

- [ ] **Step 3: Update imports**

In `apps/web/src/components/skills/SkillsMarketView.tsx`:

Add `useSetAtom` to the jotai import:

```ts
import { useAtomValue, useSetAtom } from 'jotai'
```

Add atom imports:

```ts
import { activeTabIdAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, tabsAtom } from '@/atoms'
```

If `agentWorkspacesAtom` and `currentWorkspaceIdAtom` are already imported from `@/atoms`, merge the import without duplicating.

Add:

```ts
import { upsertWelcomeTab } from '@/components/app-shell/LeftSidebar'
import { PluginDetailPage } from './PluginDetailPage'
```

Remove no-longer-used imports after deleting `PluginDetailDialog`: `ShieldCheck`, `Trash2`, `X` if they are only used by the deleted dialog.

- [ ] **Step 4: Replace plugin modal state with selected detail state**

Replace these state declarations:

```ts
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false)
  const [pluginDetailLoading, setPluginDetailLoading] = useState(false)
  const [pluginDetailError, setPluginDetailError] = useState<string | null>(null)
  const [pluginDetail, setPluginDetail] = useState<GetMarketDetailResult | null>(null)
```

with:

```ts
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginMarketItem | null>(null)
  const [pluginDetailLoading, setPluginDetailLoading] = useState(false)
  const [pluginDetailError, setPluginDetailError] = useState<string | null>(null)
  const [pluginDetail, setPluginDetail] = useState<GetMarketDetailResult | null>(null)
```

- [ ] **Step 5: Update plugin detail handlers**

Replace `handleOpenPluginDetail` with:

```ts
  const handleOpenPluginDetail = async (item: PluginMarketItem) => {
    if (!workspaceSlug) return
    setSelectedPlugin(item)
    setPluginDetailLoading(true)
    setPluginDetailError(null)
    setPluginDetail(null)
    setError(null)
    try {
      setPluginDetail(await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: item.id }))
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
      setPluginDetail({ item: { kind: 'plugin', plugin: item }, diagnostics: item.diagnostics ?? [] })
    } finally {
      setPluginDetailLoading(false)
    }
  }
```

Replace `setPluginDetailOpen(false)` in install and uninstall handlers with:

```ts
      setSelectedPlugin(null)
      setPluginDetail(null)
```

Add these handlers near `handleUninstallPluginFromDetail`:

```ts
  const handleBackFromPluginDetail = () => {
    setSelectedPlugin(null)
    setPluginDetail(null)
    setPluginDetailError(null)
    setPluginDetailLoading(false)
  }

  const handleTogglePluginFromDetail = async () => {
    const marketItem = pluginDetail?.item.kind === 'plugin' ? pluginDetail.item.plugin : selectedPlugin
    if (!workspaceSlug || !marketItem || marketItem.installState !== 'installed') return

    setBusyItemId(`plugin:${marketItem.id}`)
    setPluginDetailError(null)
    setError(null)
    try {
      const enabled = marketItem.enableState !== 'global-enabled' && marketItem.enableState !== 'workspace-enabled'
      await setPluginEnablement({
        workspaceSlug,
        pluginId: marketItem.pluginId,
        scope: 'workspace',
        enabled,
      })
      const refreshed = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: marketItem.id })
      setPluginDetail(refreshed)
      if (refreshed.item.kind === 'plugin') {
        setSelectedPlugin(refreshed.item.plugin)
      }
      await loadCatalog()
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleTryPluginInChat = () => {
    const workspaceId = workspace?.id ?? null
    setTabs((previous) => upsertWelcomeTab(previous, workspaceId))
    setActiveTabId('__welcome__')
  }
```

- [ ] **Step 6: Render the detail page before the market list**

After `sourceViews` is computed and before the main `return`, add:

```tsx
  if (selectedPlugin || pluginDetailLoading || pluginDetail) {
    return (
      <PluginDetailPage
        detail={pluginDetail}
        loading={pluginDetailLoading}
        error={pluginDetailError}
        busy={busyItemId !== null}
        onBack={handleBackFromPluginDetail}
        onInstall={() => void handleInstallPluginFromDetail()}
        onUninstall={() => void handleUninstallPluginFromDetail()}
        onToggleEnable={() => void handleTogglePluginFromDetail()}
        onTryInChat={handleTryPluginInChat}
      />
    )
  }
```

This keeps the previous market query/category/source state in memory while the detail page is open.

- [ ] **Step 7: Remove modal usage and component**

Delete this JSX from the main return:

```tsx
      <PluginDetailDialog
        open={pluginDetailOpen}
        loading={pluginDetailLoading}
        error={pluginDetailError}
        detail={pluginDetail}
        busy={busyItemId !== null}
        onInstall={() => void handleInstallPluginFromDetail()}
        onUninstall={() => void handleUninstallPluginFromDetail()}
        onOpenChange={setPluginDetailOpen}
      />
```

Delete the entire `PluginDetailDialog` function from `SkillsMarketView.tsx`.

Keep `PluginMetric` only if still used elsewhere in the file. If it is only used by the deleted dialog, delete `PluginMetric` too.

- [ ] **Step 8: Run focused Web tests**

Run:

```bash
rtk bun test apps/web/src/components/skills/skill-market-boundary.test.ts apps/web/src/components/skills/PluginDetailPage.test.tsx apps/web/src/components/skills/plugin-detail-state.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/skills/SkillsMarketView.tsx apps/web/src/components/skills/skill-market-boundary.test.ts
git commit -m "✨ feat(web): 市场插件详情切换为独立页面" -m "技能/插件市场中点击插件详情后进入独立详情页子视图，保留市场筛选状态并移除插件详情弹窗；安装、启用、卸载和试用入口改由页面 header 承载。" -m "Tested: rtk bun test apps/web/src/components/skills/skill-market-boundary.test.ts apps/web/src/components/skills/PluginDetailPage.test.tsx apps/web/src/components/skills/plugin-detail-state.test.ts"
```

---

## Task 5: Regression and Boundary Verification

**Files:** none

- [ ] **Step 1: Run sidecar plugin market tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Web focused tests**

Run:

```bash
rtk bun test apps/web/src/components/skills/plugin-detail-state.test.ts apps/web/src/components/skills/PluginDetailPage.test.tsx apps/web/src/components/skills/plugin-market-ui-state.test.ts apps/web/src/components/skills/skill-market-boundary.test.ts
```

Expected: PASS.

- [ ] **Step 3: Typecheck changed type surfaces only**

Run:

```bash
cd apps/web && bun x tsc --noEmit 2>&1 | rg "PluginDetailPage|SkillsMarketView|plugin-detail-state|plugin-market" -n
```

Expected: no output.

Run:

```bash
cd packages/shared && bun x tsc --noEmit 2>&1 | rg "plugin-market" -n
```

Expected: no output.

- [ ] **Step 4: Check touched files**

Run:

```bash
git diff --name-only HEAD~4..HEAD
```

Expected changed files are limited to:

```text
packages/shared/src/types/plugin-market.ts
apps/sidecar/src/services/plugins/plugin-market-service.ts
apps/sidecar/src/services/plugins/plugin-market-service.test.ts
apps/web/src/components/skills/plugin-detail-state.ts
apps/web/src/components/skills/plugin-detail-state.test.ts
apps/web/src/components/skills/PluginDetailPage.tsx
apps/web/src/components/skills/PluginDetailPage.test.tsx
apps/web/src/components/skills/SkillsMarketView.tsx
apps/web/src/components/skills/skill-market-boundary.test.ts
```

- [ ] **Step 5: Commit final verification note only if needed**

If verification changed no files, do not commit. If a test snapshot or generated type output is produced, inspect it first and only commit relevant intentional changes:

```bash
git status --short
```

Expected: no files from this plan remain unstaged or modified.
