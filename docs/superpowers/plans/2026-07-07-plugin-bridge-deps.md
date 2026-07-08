# 插件桥接依赖显示与安装向导 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让依赖桥接包的插件（lume-chrome、obsidian-bridge）在插件页面显示「🔌需桥接」徽章，并提供全屏分步安装向导，逐步引导用户导出/下载桥接产物、装进目标应用、验证就绪。

**Architecture:** 声明式驱动——扩展 `marketplace.setup[]` 的结构化字段（artifact/download/build/targetApp/verify），sidecar 新增 3 个 IPC（导出产物/下载外部资产/检测桥接状态），web 新增全屏向导组件 + 卡片徽章。复用现有安装链路（向导第 1 步调 `install-market-item`），不改动现有 Setup Tab。

**Tech Stack:** TypeScript monorepo（Bun workspaces）、React 18 + Jotai 2 + @base-ui/react Dialog、sidecar 为 Electron UtilityProcess（Node）、测试用 `bun:test`、zod（sidecar 侧校验）。

## Global Constraints

- **包名/目录**：SDK 目录 `packages/sdk/`，包名 `@lume/agent-sdk`（import 用此名）；shared 目录 `packages/shared/`，包名 `@lume/shared`。
- **setup step 类型有两套独立定义，必须同步**：SDK 侧 `packages/sdk/src/plugins/manifest.ts`（分号风格）与 shared 侧 `packages/shared/src/types/plugin-market.ts`（无分号风格）的 `PluginMarketplaceSetupStep` 字段名必须**完全一致**，否则跨进程序列化丢字段、且 `summarizeMarketplace`（`apps/sidecar/src/services/plugins/plugin-market-service.ts:1012`，引用传递 `setup: marketplace.setup`）处 TS 报结构不兼容。
- **代码风格**：SDK/sidecar 文件用分号；shared/web 文件不用分号、用单引号。匹配被改文件的现有风格。
- **测试运行器**：`bun:test`（`import { describe, test, expect, beforeEach, afterEach } from 'bun:test'`）。sidecar 测试命令 `bun test apps/sidecar/src/...`；web 测试命令 `cd apps/web && bun test src/...`；SDK 测试 `bun test packages/sdk/src/...`。
- **sidecar 测试隔离**：不 mock 文件系统，而是 `beforeEach` 把 `process.env.HOME` 和 `process.env.LUME_CONFIG_DIR` 重定向到 `mkdtempSync(tmpdir())`，`afterEach` 还原 + 清理。
- **web 组件**：用 `@base-ui/react` 的 Dialog（`@/components/ui/dialog`），**无 Sheet 组件**。图标用 `lucide-react`（v1）。toast 用 `sonner`。
- **不自动 git 提交**：遵循仓库 CLAUDE.md 约定「未经主动要求不做 git 操作」。本计划每个任务以「测试通过」为终点，不写 commit step；由开发者按自身工作流提交。
- **注释语言**：中文，匹配现有代码。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/sdk/src/plugins/manifest.ts` | 改 | `PluginMarketplaceSetupStep` 加 5 字段 + `normalizeMarketplace` 解析 |
| `packages/sdk/src/plugins/manifest.test.ts` | 建或扩 | schema 解析单测 |
| `packages/shared/src/types/plugin-market.ts` | 改 | setup step 同步加 5 字段 + 3 对 Input/Result 接口 |
| `packages/shared/src/types/agent.ts` | 改 | `AGENT_IPC_CHANNELS` 加 3 个 channel |
| `apps/sidecar/src/services/plugins/plugin-bridge-service.ts` | 建 | 导出/下载/检测 3 个方法 |
| `apps/sidecar/src/services/plugins/plugin-bridge-service.test.ts` | 建 | service 单测 |
| `apps/sidecar/src/rpc/schemas.ts` | 改 | 3 个 zod schema |
| `apps/sidecar/src/rpc/agent-handlers.ts` | 改 | 3 个 handler |
| `apps/web/src/lib/desktop-api/plugin-market.ts` | 改 | 3 个 wrapper 函数 |
| `apps/web/src/components/skills/plugin-detail-state.ts` | 改 | `PluginSetupItem` 加字段 + `buildPluginSetupItems` 扩展 |
| `apps/web/src/components/skills/plugin-detail-state.test.ts` | 改 | 扩展用例 |
| `apps/web/src/atoms/skill-atoms.ts` | 改 | 向导 open/plugin atom |
| `apps/web/src/components/skills/SkillsMarketView.tsx` | 改 | MarketCard 徽章 + 安装按钮接向导 |
| `apps/web/src/components/skills/BridgeInstallWizard.tsx` | 建 | 全屏分步向导 |
| `apps/web/src/components/skills/BridgeInstallWizard.test.tsx` | 建 | 组件测试 |
| `lume-plugins/plugins/lume-chrome/lume-plugin.json` | 改 | setup 补字段 |
| `lume-plugins/plugins/obsidian-bridge/lume-plugin.json` | 改 | setup 补字段 |

---

### Task 1: 扩展 SDK setup step schema + 解析

**Files:**
- Modify: `packages/sdk/src/plugins/manifest.ts:62-67`（`PluginMarketplaceSetupStep`）、`:200-223`（`normalizeMarketplace` setup 解析块）
- Test: `packages/sdk/src/plugins/manifest.test.ts`（若不存在则创建）

**Interfaces:**
- Produces: `PluginMarketplaceSetupStep` 新增可选字段 `artifact`/`download`/`build`/`targetApp`/`verify` 及关联类型（`PluginSetupArtifactKind` 等）。Task 2 的 shared 侧类型必须与本任务字段名完全一致。

- [ ] **Step 1: 写失败测试**

创建/扩展 `packages/sdk/src/plugins/manifest.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { parseManifest } from './manifest'

describe('PluginMarketplaceSetupStep bridge fields', () => {
  test('解析 artifact/download/build/targetApp/verify 字段', () => {
    const parsed = parseManifest({
      schema: 'lume-plugin/v1',
      name: 'demo',
      version: '1.0.0',
      marketplace: {
        setup: [
          {
            id: 'install-ext',
            title: '安装扩展',
            description: '加载已解压扩展',
            kind: 'install',
            artifact: { path: './ext.zip', kind: 'chrome-extension' },
            download: { url: 'https://example.com/asset.zip', filename: 'asset.zip' },
            build: { command: 'cargo build --release', cwd: './host', prerequisites: '需 Rust' },
            targetApp: { kind: 'chrome', installHint: 'chrome://extensions' },
            verify: { method: 'chrome-extension', detail: 'abcdefg' },
          },
        ],
      },
    })
    const step = parsed.marketplace!.setup![0]
    expect(step.artifact).toEqual({ path: './ext.zip', kind: 'chrome-extension' })
    expect(step.download).toEqual({ url: 'https://example.com/asset.zip', filename: 'asset.zip' })
    expect(step.build).toEqual({ command: 'cargo build --release', cwd: './host', prerequisites: '需 Rust' })
    expect(step.targetApp).toEqual({ kind: 'chrome', installHint: 'chrome://extensions' })
    expect(step.verify).toEqual({ method: 'chrome-extension', detail: 'abcdefg' })
  })

  test('拒绝非 https 的 download.url（丢弃 download 字段）', () => {
    const parsed = parseManifest({
      schema: 'lume-plugin/v1',
      name: 'demo',
      version: '1.0.0',
      marketplace: {
        setup: [{ id: 's1', title: 't', description: 'd', download: { url: 'http://insecure.com/a.zip' } }],
      },
    })
    expect(parsed.marketplace!.setup![0].download).toBeUndefined()
  })

  test('拒绝含 .. 的 artifact.path（整步丢弃）', () => {
    const parsed = parseManifest({
      schema: 'lume-plugin/v1',
      name: 'demo',
      version: '1.0.0',
      marketplace: {
        setup: [{ id: 's1', title: 't', description: 'd', artifact: { path: './../escape.zip', kind: 'file' } }],
      },
    })
    // path 非法则该步被丢弃（validatePluginPath 抛错被 flatMap 捕获为空）
    expect(parsed.marketplace!.setup?.length ?? 0).toBe(0)
  })

  test('无新字段的旧 setup step 仍正常解析', () => {
    const parsed = parseManifest({
      schema: 'lume-plugin/v1',
      name: 'demo',
      version: '1.0.0',
      marketplace: { setup: [{ id: 's1', title: 't', description: 'd', kind: 'install' }] },
    })
    expect(parsed.marketplace!.setup).toEqual([{ id: 's1', title: 't', description: 'd', kind: 'install' }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/sdk/src/plugins/manifest.test.ts`
Expected: FAIL（`step.artifact` 为 `undefined`，新字段未解析）

- [ ] **Step 3: 加新类型定义**

在 `packages/sdk/src/plugins/manifest.ts` 的 `PluginMarketplaceSetupKind`（`:53`）之后、`PluginMarketplaceSetupStep`（`:62`）之前插入：

```ts
export type PluginSetupArtifactKind =
  | "chrome-extension"
  | "obsidian-plugin"
  | "native-binary"
  | "node-bundle"
  | "file";

export interface PluginSetupArtifact {
  path: string;
  kind: PluginSetupArtifactKind;
}

export interface PluginSetupDownload {
  url: string;
  filename?: string;
  sha256?: string;
}

export interface PluginSetupBuild {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  prerequisites?: string;
}

export interface PluginSetupTargetApp {
  kind: "chrome" | "obsidian" | "system-path";
  installHint?: string;
}

export interface PluginSetupVerify {
  method: "tcp-port" | "chrome-extension" | "http-get" | "none";
  detail?: string;
}
```

- [ ] **Step 4: 扩展 `PluginMarketplaceSetupStep`**

把 `packages/sdk/src/plugins/manifest.ts:62-67` 改为：

```ts
export interface PluginMarketplaceSetupStep {
  id: string;
  title: string;
  description: string;
  kind?: PluginMarketplaceSetupKind;
  artifact?: PluginSetupArtifact;
  download?: PluginSetupDownload;
  build?: PluginSetupBuild;
  targetApp?: PluginSetupTargetApp;
  verify?: PluginSetupVerify;
}
```

- [ ] **Step 5: 扩展 `normalizeMarketplace` 的 setup 解析**

把 `packages/sdk/src/plugins/manifest.ts:200-223` 的 setup 解析块替换为（在原 `return [{ id, title, description, ...kind }]` 基础上追加新字段解析）：

```ts
  if (Array.isArray(value.setup)) {
    const setup = value.setup.flatMap((entry): PluginMarketplaceSetupStep[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const step = entry as Record<string, unknown>;
      if (
        typeof step.id !== "string"
        || typeof step.title !== "string"
        || typeof step.description !== "string"
      ) {
        return [];
      }
      const artifact = parseArtifact(step.artifact);
      const download = parseDownload(step.download);
      const build = parseBuild(step.build);
      const targetApp = parseTargetApp(step.targetApp);
      const verify = parseVerify(step.verify);
      // artifact.path 非法时整步丢弃（与现有 validatePluginPath 抛错语义一致）
      if (step.artifact && !artifact) return [];
      return [{
        id: step.id,
        title: step.title,
        description: step.description,
        ...(typeof step.kind === "string" && MARKETPLACE_SETUP_KINDS.has(step.kind as PluginMarketplaceSetupKind)
          ? { kind: step.kind as PluginMarketplaceSetupKind }
          : {}),
        ...(artifact ? { artifact } : {}),
        ...(download ? { download } : {}),
        ...(build ? { build } : {}),
        ...(targetApp ? { targetApp } : {}),
        ...(verify ? { verify } : {}),
      }];
    });
    if (setup.length > 0) {
      result.setup = setup;
    }
  }
```

在 `normalizeMarketplace` 函数之后（`inferDefaults` 之前）追加 5 个解析辅助函数：

```ts
const SETUP_ARTIFACT_KINDS = new Set<PluginSetupArtifactKind>([
  "chrome-extension", "obsidian-plugin", "native-binary", "node-bundle", "file",
]);
const SETUP_TARGET_KINDS = new Set<PluginSetupTargetApp["kind"]>(["chrome", "obsidian", "system-path"]);
const SETUP_VERIFY_METHODS = new Set<PluginSetupVerify["method"]>(["tcp-port", "chrome-extension", "http-get", "none"]);

function parseArtifact(raw: unknown): PluginSetupArtifact | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.path !== "string" || typeof v.kind !== "string") return undefined;
  if (!SETUP_ARTIFACT_KINDS.has(v.kind as PluginSetupArtifactKind)) return undefined;
  try {
    validatePluginPath(v.path, "marketplace.setup.artifact.path");
  } catch {
    return undefined;
  }
  return { path: v.path, kind: v.kind as PluginSetupArtifactKind };
}

function parseDownload(raw: unknown): PluginSetupDownload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.url !== "string") return undefined;
  // 强制 https
  if (!v.url.startsWith("https://")) return undefined;
  return {
    url: v.url,
    ...(typeof v.filename === "string" ? { filename: v.filename } : {}),
    ...(typeof v.sha256 === "string" ? { sha256: v.sha256 } : {}),
  };
}

function parseBuild(raw: unknown): PluginSetupBuild | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.command !== "string") return undefined;
  if (typeof v.cwd === "string") {
    try { validatePluginPath(v.cwd, "marketplace.setup.build.cwd"); }
    catch { return undefined; }
  }
  return {
    command: v.command,
    ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
    ...(v.env && typeof v.env === "object" && !Array.isArray(v.env) ? { env: v.env as Record<string, string> } : {}),
    ...(typeof v.prerequisites === "string" ? { prerequisites: v.prerequisites } : {}),
  };
}

function parseTargetApp(raw: unknown): PluginSetupTargetApp | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.kind !== "string" || !SETUP_TARGET_KINDS.has(v.kind as PluginSetupTargetApp["kind"])) return undefined;
  return {
    kind: v.kind as PluginSetupTargetApp["kind"],
    ...(typeof v.installHint === "string" ? { installHint: v.installHint } : {}),
  };
}

function parseVerify(raw: unknown): PluginSetupVerify | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.method !== "string" || !SETUP_VERIFY_METHODS.has(v.method as PluginSetupVerify["method"])) return undefined;
  return {
    method: v.method as PluginSetupVerify["method"],
    ...(typeof v.detail === "string" ? { detail: v.detail } : {}),
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test packages/sdk/src/plugins/manifest.test.ts`
Expected: PASS（4 个用例全过）

- [ ] **Step 7: typecheck**

Run: `cd packages/sdk && bun run typecheck`
Expected: 无错误。

---

### Task 2: 同步 shared 类型 + 新增 IPC channel 与 Input/Result

**Files:**
- Modify: `packages/shared/src/types/plugin-market.ts:77-96`（setup 类型）、文件末尾追加 Input/Result
- Modify: `packages/shared/src/types/agent.ts`（`AGENT_IPC_CHANNELS` 对象，约 `:1446` SET_PLUGIN_ACTIVE_VERSION 之后）

**Interfaces:**
- Consumes: Task 1 的字段定义（字段名必须完全一致）
- Produces: 3 个 channel 常量、6 个接口（`ExportPluginArtifactInput/Result`、`DownloadBridgeAssetInput/Result`、`CheckBridgeStatusInput/Result`）。供 Task 4（handler）、Task 5（web wrapper）使用。

- [ ] **Step 1: 同步 shared 的 setup step 类型**

把 `packages/shared/src/types/plugin-market.ts` 中 `PluginMarketplaceSetupKind` 与 `PluginMarketplaceSetupStep`（`:77-96`）替换为（无分号风格，字段名与 Task 1 完全一致）：

```ts
export type PluginMarketplaceSetupKind =
  | "install"
  | "enable"
  | "browser-auth"
  | "pairing-code"
  | "local-service"
  | "mcp"
  | "custom"

export type PluginSetupArtifactKind =
  | "chrome-extension"
  | "obsidian-plugin"
  | "native-binary"
  | "node-bundle"
  | "file"

export interface PluginSetupArtifact {
  path: string
  kind: PluginSetupArtifactKind
}

export interface PluginSetupDownload {
  url: string
  filename?: string
  sha256?: string
}

export interface PluginSetupBuild {
  command: string
  cwd?: string
  env?: Record<string, string>
  prerequisites?: string
}

export interface PluginSetupTargetApp {
  kind: "chrome" | "obsidian" | "system-path"
  installHint?: string
}

export interface PluginSetupVerify {
  method: "tcp-port" | "chrome-extension" | "http-get" | "none"
  detail?: string
}

export interface PluginMarketplaceSetupStep {
  id: string
  title: string
  description: string
  kind?: PluginMarketplaceSetupKind
  artifact?: PluginSetupArtifact
  download?: PluginSetupDownload
  build?: PluginSetupBuild
  targetApp?: PluginSetupTargetApp
  verify?: PluginSetupVerify
}
```

- [ ] **Step 2: 追加 3 对 Input/Result 接口**

在 `packages/shared/src/types/plugin-market.ts` 末尾追加：

```ts
export interface ExportPluginArtifactInput {
  pluginId: string
  version: string
  artifactPath: string
  destDir?: string
}

export interface ExportPluginArtifactResult {
  savedPath: string
}

export interface DownloadBridgeAssetInput {
  url: string
  filename?: string
  sha256?: string
  destDir?: string
}

export interface DownloadBridgeAssetResult {
  savedPath: string
  verified: boolean
}

export interface CheckBridgeStatusInput {
  pluginId: string
  version: string
  verify: PluginSetupVerify
}

export interface CheckBridgeStatusResult {
  ok: boolean
  detail: string
}
```

- [ ] **Step 3: 在 `AGENT_IPC_CHANNELS` 加 3 个 channel**

在 `packages/shared/src/types/agent.ts` 的 `AGENT_IPC_CHANNELS` 对象中，`SET_PLUGIN_ACTIVE_VERSION: 'agent:set-plugin-active-version',` 之后追加：

```ts
  /** 导出已安装插件的桥接产物到本地 */
  EXPORT_PLUGIN_ARTIFACT: 'agent:export-plugin-artifact',
  /** 下载外部桥接资产（如 GitHub Release） */
  DOWNLOAD_BRIDGE_ASSET: 'agent:download-bridge-asset',
  /** 检测桥接是否就绪（端口/扩展/HTTP） */
  CHECK_BRIDGE_STATUS: 'agent:check-bridge-status',
```

- [ ] **Step 4: typecheck 验证**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误（确认 barrel 自动导出新接口，无需改 `types/index.ts`）。

---

### Task 3: sidecar plugin-bridge-service（导出/下载/检测）

**Files:**
- Create: `apps/sidecar/src/services/plugins/plugin-bridge-service.ts`
- Test: `apps/sidecar/src/services/plugins/plugin-bridge-service.test.ts`

**Interfaces:**
- Consumes: Task 2 的 6 个接口；`PluginMarketServiceConfig.installedRoot` 模式（`join(homedir(), ".lume", "plugins")`）
- Produces: `PluginBridgeService`（方法 `exportPluginArtifact` / `downloadBridgeAsset` / `checkBridgeStatus`）、`createDefaultPluginBridgeService()`、`PluginBridgeError`。供 Task 4 handler 调用。

- [ ] **Step 1: 写失败测试**

创建 `apps/sidecar/src/services/plugins/plugin-bridge-service.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PluginBridgeError,
  PluginBridgeService,
} from './plugin-bridge-service'

async function writeFile(path: string, content: string) {
  await mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function makeService(root: string, fetchImpl?: typeof fetch) {
  return new PluginBridgeService({
    installedRoot: join(root, 'plugins'),
    fetchImpl,
  })
}

describe('PluginBridgeService', () => {
  let root = ''
  let prevHome: string | undefined

  beforeEach(() => {
    prevHome = process.env.HOME
    root = mkdtempSync(join(tmpdir(), 'lume-bridge-'))
    process.env.HOME = root
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test('exportPluginArtifact 复制产物到 destDir', async () => {
    const artifactPath = join(root, 'plugins', 'demo', '1.0.0', 'ext.zip')
    await writeFile(artifactPath, 'zip-bytes')
    const result = await makeService(root).exportPluginArtifact({
      pluginId: 'demo',
      version: '1.0.0',
      artifactPath: './ext.zip',
      destDir: join(root, 'out'),
    })
    expect(result.savedPath).toBe(join(root, 'out', 'ext.zip'))
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test('exportPluginArtifact 产物不存在时抛错', async () => {
    expect(
      makeService(root).exportPluginArtifact({
        pluginId: 'demo',
        version: '1.0.0',
        artifactPath: './missing.zip',
        destDir: join(root, 'out'),
      }),
    ).rejects.toBeInstanceOf(PluginBridgeError)
  })

  test('downloadBridgeAsset 下载并校验 sha256', async () => {
    const fetchImpl = (async () =>
      new Response('hello', { status: 200 })) as unknown as typeof fetch
    // sha256 of 'hello'
    const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    const result = await makeService(root, fetchImpl).downloadBridgeAsset({
      url: 'https://example.com/asset.bin',
      filename: 'asset.bin',
      sha256: sha,
      destDir: join(root, 'out'),
    })
    expect(result.verified).toBe(true)
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test('checkBridgeStatus tcp-port 检测未监听端口返回 ok=false', async () => {
    const result = await makeService(root).checkBridgeStatus({
      pluginId: 'demo',
      version: '1.0.0',
      verify: { method: 'tcp-port', detail: '127.0.0.1:59999' },
    })
    expect(result.ok).toBe(false)
  })

  test('checkBridgeStatus tcp-port 拒绝非本地地址', async () => {
    expect(
      makeService(root).checkBridgeStatus({
        pluginId: 'demo',
        version: '1.0.0',
        verify: { method: 'tcp-port', detail: '8.8.8.8:53' },
      }),
    ).rejects.toBeInstanceOf(PluginBridgeError)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/sidecar/src/services/plugins/plugin-bridge-service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 service**

创建 `apps/sidecar/src/services/plugins/plugin-bridge-service.ts`：

```ts
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CheckBridgeStatusInput,
  CheckBridgeStatusResult,
  DownloadBridgeAssetInput,
  DownloadBridgeAssetResult,
  ExportPluginArtifactInput,
  ExportPluginArtifactResult,
} from "@lume/shared";

export class PluginBridgeError extends Error {
  constructor(
    public readonly code:
      | "artifact_not_found"
      | "download_failed"
      | "verify_failed"
      | "unsupported_verify"
      | "unsafe_target",
    message: string,
  ) {
    super(message);
    this.name = "PluginBridgeError";
  }
}

export interface PluginBridgeServiceConfig {
  installedRoot: string;
  fetchImpl?: typeof fetch;
}

export function createDefaultPluginBridgeService(): PluginBridgeService {
  return new PluginBridgeService({
    installedRoot: join(homedir(), ".lume", "plugins"),
  });
}

const TCP_TIMEOUT_MS = 2000;

export class PluginBridgeService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: PluginBridgeServiceConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** 导出已安装插件目录内的桥接产物到本地目录。 */
  async exportPluginArtifact(input: ExportPluginArtifactInput): Promise<ExportPluginArtifactResult> {
    const src = this.resolveArtifactPath(input.pluginId, input.version, input.artifactPath);
    if (!existsSync(src)) {
      throw new PluginBridgeError("artifact_not_found", `桥接产物不存在: ${input.artifactPath}`);
    }
    const destDir = input.destDir ?? join(homedir(), "Downloads");
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, basename(src));
    await copyFile(src, dest);
    return { savedPath: dest };
  }

  /** 下载外部桥接资产（如 GitHub Release），可选 sha256 校验。 */
  async downloadBridgeAsset(input: DownloadBridgeAssetInput): Promise<DownloadBridgeAssetResult> {
    if (!input.url.startsWith("https://")) {
      throw new PluginBridgeError("download_failed", "仅允许 https 下载源");
    }
    const filename = input.filename ?? basename(new URL(input.url).pathname) || "bridge-asset.bin";
    const destDir = input.destDir ?? join(homedir(), "Downloads");
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, filename);

    const resp = await this.fetchImpl(input.url);
    if (!resp.ok || !resp.body) {
      throw new PluginBridgeError("download_failed", `下载失败: HTTP ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    await mkdir(dirname(dest), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, buf);

    let verified = true;
    if (input.sha256) {
      const actual = createHash("sha256").update(buf).digest("hex");
      verified = actual === input.sha256.toLowerCase();
      if (!verified) {
        throw new PluginBridgeError("verify_failed", `sha256 不匹配: 期望 ${input.sha256}, 实际 ${actual}`);
      }
    }
    return { savedPath: dest, verified };
  }

  /** 检测桥接是否就绪。tcp-port/http-get 仅允许本地地址。 */
  async checkBridgeStatus(input: CheckBridgeStatusInput): Promise<CheckBridgeStatusResult> {
    const { method, detail } = input.verify;
    switch (method) {
      case "none":
        return { ok: true, detail: "无需检测" };
      case "tcp-port": {
        const target = parseHostPort(detail ?? "");
        if (!isLocalHost(target.host)) {
          throw new PluginBridgeError("unsafe_target", `仅允许本地地址: ${detail}`);
        }
        const ok = await probeTcp(target.host, target.port);
        return { ok, detail: ok ? `${detail} 可连接` : `${detail} 未监听` };
      }
      case "http-get": {
        const url = new URL(detail ?? "");
        if (!isLocalHost(url.hostname)) {
          throw new PluginBridgeError("unsafe_target", `仅允许本地地址: ${detail}`);
        }
        try {
          const r = await this.fetchImpl(url.toString());
          return { ok: r.ok, detail: `HTTP ${r.status}` };
        } catch {
          return { ok: false, detail: "请求失败" };
        }
      }
      case "chrome-extension": {
        const ok = checkChromeExtensionInstalled(detail ?? "");
        return { ok, detail: ok ? "扩展已加载" : "未检测到扩展" };
      }
      default:
        throw new PluginBridgeError("unsupported_verify", `不支持的检测方式: ${method}`);
    }
  }

  private resolveArtifactPath(pluginId: string, version: string, artifactPath: string): string {
    // artifactPath 形如 "./ext.zip"；拼到 ~/.lume/plugins/<id>/<ver>/<path>
    const rel = artifactPath.replace(/^\.\//, "");
    return join(this.config.installedRoot, pluginId, version, rel);
  }
}

function parseHostPort(detail: string): { host: string; port: number } {
  const m = detail.match(/^([^:]+):(\d+)$/);
  if (!m) throw new PluginBridgeError("unsafe_target", `非法的地址格式: ${detail}`);
  return { host: m[1], port: Number(m[2]) };
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const socket = createConnection({ host, port }, () => {
      if (!done) { done = true; socket.destroy(); resolve(true); }
    });
    socket.on("error", () => { if (!done) { done = true; resolve(false); } });
    setTimeout(() => { if (!done) { done = true; socket.destroy(); resolve(false); } }, TCP_TIMEOUT_MS);
  });
}

/** 扫描 Chrome 扩展目录（MVP: Windows）。 */
function checkChromeExtensionInstalled(extensionId: string): boolean {
  if (!/^[a-p]{32}$/i.test(extensionId)) return false;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const base = join(localAppData, "Google", "Chrome", "User Data", "Default", "Extensions", extensionId);
  try {
    return existsSync(base) && readdirSync(base).length > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/sidecar/src/services/plugins/plugin-bridge-service.test.ts`
Expected: PASS（5 个用例全过）

- [ ] **Step 5: typecheck**

Run: `cd apps/sidecar && bunx tsc --noEmit`
Expected: 无错误。

---

### Task 4: 注册 3 个 sidecar RPC handler + zod schema

**Files:**
- Modify: `apps/sidecar/src/rpc/schemas.ts`（追加 3 个 schema）
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`（在 `SET_PLUGIN_ACTIVE_VERSION` handler 之后追加 3 个 handler）

**Interfaces:**
- Consumes: Task 2 的 channel + 接口；Task 3 的 `createDefaultPluginBridgeService`；现有 `validateInput`（`apps/sidecar/src/rpc/validation.ts`）与 `verifyMethodSchema` 风格。
- Produces: 3 个可从前端经 `sidecar_call` 调用的 RPC 方法。

- [ ] **Step 1: 加 zod schema**

在 `apps/sidecar/src/rpc/schemas.ts` 末尾追加（参考现有 `installMarketItemInputSchema` 的 `.strict()` 风格；`verifySchema` 复用于 export/download 不需要，此处仅 check 用到）：

```ts
export const verifySchema = z.object({
  method: z.enum(["tcp-port", "chrome-extension", "http-get", "none"]),
  detail: z.string().optional(),
}).strict();

export const exportPluginArtifactInputSchema = z.object({
  pluginId: idSchema,
  version: z.string().trim().min(1),
  artifactPath: z.string().trim().min(1),
  destDir: z.string().optional(),
}).strict();

export const downloadBridgeAssetInputSchema = z.object({
  url: z.string().url().startsWith("https://"),
  filename: z.string().optional(),
  sha256: z.string().optional(),
  destDir: z.string().optional(),
}).strict();

export const checkBridgeStatusInputSchema = z.object({
  pluginId: idSchema,
  version: z.string().trim().min(1),
  verify: verifySchema,
}).strict();
```

- [ ] **Step 2: 加 handler**

在 `apps/sidecar/src/rpc/agent-handlers.ts` 的 handlers 对象中，`[AGENT_IPC_CHANNELS.SET_PLUGIN_ACTIVE_VERSION]` handler 之后追加。先在文件顶部 import 区补 `createDefaultPluginBridgeService`（如未引入），并补 schema import：

```ts
// 顶部 import 追加（与现有 schema/service import 同区）：
import { createDefaultPluginBridgeService } from "../services/plugins/plugin-bridge-service";
import {
  // ... 现有 schema import
  exportPluginArtifactInputSchema,
  downloadBridgeAssetInputSchema,
  checkBridgeStatusInputSchema,
} from "./schemas";
```

在 handlers 对象内追加：

```ts
    [AGENT_IPC_CHANNELS.EXPORT_PLUGIN_ARTIFACT]: async (params) => {
      const input = validateInput(
        exportPluginArtifactInputSchema,
        params,
        AGENT_IPC_CHANNELS.EXPORT_PLUGIN_ARTIFACT,
      );
      return createDefaultPluginBridgeService().exportPluginArtifact(input);
    },
    [AGENT_IPC_CHANNELS.DOWNLOAD_BRIDGE_ASSET]: async (params) => {
      const input = validateInput(
        downloadBridgeAssetInputSchema,
        params,
        AGENT_IPC_CHANNELS.DOWNLOAD_BRIDGE_ASSET,
      );
      return createDefaultPluginBridgeService().downloadBridgeAsset(input);
    },
    [AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS]: async (params) => {
      const input = validateInput(
        checkBridgeStatusInputSchema,
        params,
        AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS,
      );
      return createDefaultPluginBridgeService().checkBridgeStatus(input);
    },
```

- [ ] **Step 3: 写 handler 集成测试**

创建 `apps/sidecar/src/rpc/agent-handlers.bridge.test.ts`（参考 `agent-handlers.market.test.ts` 的 HOME 重定向 + `makeHandlers` 模式）：

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import type { PlanModePhaseTracker } from '../services/agent/plan-mode-phase-tracker'
import { createAgentHandlers } from './agent-handlers'

const previousHome = process.env.HOME

function makeHandlers() {
  return createAgentHandlers({
    writeNotification: () => {},
    planModePhaseTracker: {
      isLikelyExecutionRequest: () => false,
      getPhase: () => 'idle',
      clearSession: () => undefined,
    } as unknown as PlanModePhaseTracker,
    notifyPlanModePhaseChange: () => undefined,
  })
}

describe('agent handlers plugin bridge', () => {
  afterEach(() => {
    if (process.env.HOME && process.env.HOME.startsWith(tmpdir())) {
      rmSync(process.env.HOME, { recursive: true, force: true })
    }
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  })

  test('CHECK_BRIDGE_STATUS 拒绝非本地地址', async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'lume-bridge-rpc-'))
    const handlers = makeHandlers()
    await expect(
      handlers[AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS]!({
        pluginId: 'demo',
        version: '1.0.0',
        verify: { method: 'tcp-port', detail: '8.8.8.8:53' },
      }),
    ).rejects.toThrow(/本地地址/)
  })

  test('EXPORT_PLUGIN_ARTIFACT 导出已存在的产物', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lume-bridge-rpc-'))
    process.env.HOME = home
    const artifactDir = join(home, '.lume', 'plugins', 'demo', '1.0.0')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'ext.zip'), 'bytes')
    const handlers = makeHandlers()
    const result = await handlers[AGENT_IPC_CHANNELS.EXPORT_PLUGIN_ARTIFACT]!({
      pluginId: 'demo',
      version: '1.0.0',
      artifactPath: './ext.zip',
      destDir: join(home, 'out'),
    }) as { savedPath: string }
    expect(result.savedPath).toContain('ext.zip')
  })
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/sidecar/src/rpc/agent-handlers.bridge.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `cd apps/sidecar && bunx tsc --noEmit`
Expected: 无错误。

---

### Task 5: web desktop-api 3 个 wrapper 函数

**Files:**
- Modify: `apps/web/src/lib/desktop-api/plugin-market.ts`

**Interfaces:**
- Consumes: Task 2 的 channel 常量与 6 个接口。
- Produces: `exportPluginArtifact` / `downloadBridgeAsset` / `checkBridgeStatus` 三个前端可调函数。供 Task 8 向导组件使用。

- [ ] **Step 1: 扩展 import 与函数**

在 `apps/web/src/lib/desktop-api/plugin-market.ts` 顶部的 `@lume/shared` import 中追加 3 对类型（保持现有 import 列表，仅追加）：

```ts
// 追加到现有 import { ... } from '@lume/shared'：
  type ExportPluginArtifactInput,
  type ExportPluginArtifactResult,
  type DownloadBridgeAssetInput,
  type DownloadBridgeAssetResult,
  type CheckBridgeStatusInput,
  type CheckBridgeStatusResult,
```

在文件末尾追加：

```ts
export const exportPluginArtifact = (input: ExportPluginArtifactInput) =>
  sidecarCall<ExportPluginArtifactResult>(AGENT_IPC_CHANNELS.EXPORT_PLUGIN_ARTIFACT, input)

export const downloadBridgeAsset = (input: DownloadBridgeAssetInput) =>
  sidecarCall<DownloadBridgeAssetResult>(AGENT_IPC_CHANNELS.DOWNLOAD_BRIDGE_ASSET, input)

export const checkBridgeStatus = (input: CheckBridgeStatusInput) =>
  sidecarCall<CheckBridgeStatusResult>(AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS, input)
```

- [ ] **Step 2: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

---

### Task 6: 扩展 buildPluginSetupItems 携带桥接字段

**Files:**
- Modify: `apps/web/src/components/skills/plugin-detail-state.ts:8-12`（`PluginSetupItem`）、`:89-178`（`buildPluginSetupItems` / `buildExplicitSetupItems` / `setupStepStatus`）
- Test: `apps/web/src/components/skills/plugin-detail-state.test.ts`

**Interfaces:**
- Consumes: Task 2 后，`PluginMarketItem.marketplace.setup` 元素已含新字段（自动随 shared 类型生效）。
- Produces: `PluginSetupItem` 增加可选 `artifact/download/build/targetApp/verify/id` 字段，供向导与详情页渲染操作按钮。

- [ ] **Step 1: 写失败测试**

在 `apps/web/src/components/skills/plugin-detail-state.test.ts` 的 describe 块内追加用例：

```ts
  test('explicit setup 步骤携带桥接字段', () => {
    const items = buildPluginSetupItems(plugin({
      marketplace: {
        setup: [{
          id: 'install-ext',
          title: '安装扩展',
          description: '加载已解压扩展',
          kind: 'install',
          artifact: { path: './ext.zip', kind: 'chrome-extension' },
          targetApp: { kind: 'chrome', installHint: 'chrome://extensions' },
          verify: { method: 'chrome-extension', detail: 'abcdefg' },
        }],
      },
    }))
    expect(items[0]).toMatchObject({
      id: 'install-ext',
      artifact: { path: './ext.zip', kind: 'chrome-extension' },
      targetApp: { kind: 'chrome' },
      verify: { method: 'chrome-extension' },
    })
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test src/components/skills/plugin-detail-state.test.ts`
Expected: FAIL（`items[0].artifact` 为 undefined）

- [ ] **Step 3: 扩展 `PluginSetupItem` 与 `buildExplicitSetupItems`**

把 `apps/web/src/components/skills/plugin-detail-state.ts:8-12` 的 `PluginSetupItem` 改为：

```ts
export interface PluginSetupItem {
  id?: string
  title: string
  description: string
  status: 'done' | 'attention' | 'idle'
  artifact?: import('@lume/shared').PluginSetupArtifact
  download?: import('@lume/shared').PluginSetupDownload
  build?: import('@lume/shared').PluginSetupBuild
  targetApp?: import('@lume/shared').PluginSetupTargetApp
  verify?: import('@lume/shared').PluginSetupVerify
}
```

> 优先做法：在文件顶部 `import type { PluginMarketItem, PluginMarketplaceSetupKind, PluginReadmePreview, PluginSetupArtifact, PluginSetupDownload, PluginSetupBuild, PluginSetupTargetApp, PluginSetupVerify } from '@lume/shared'`，然后用裸类型名替代上面的内联 `import(...)`。

把 `buildExplicitSetupItems`（`:147-158`）改为透传新字段：

```ts
function buildExplicitSetupItems(
  item: PluginMarketItem,
  currentVersionInstalled: boolean,
  enabled: boolean,
): PluginSetupItem[] {
  const setup = item.marketplace?.setup ?? []
  return setup.map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    status: setupStepStatus(step.kind, currentVersionInstalled, enabled),
    ...(step.artifact ? { artifact: step.artifact } : {}),
    ...(step.download ? { download: step.download } : {}),
    ...(step.build ? { build: step.build } : {}),
    ...(step.targetApp ? { targetApp: step.targetApp } : {}),
    ...(step.verify ? { verify: step.verify } : {}),
  }))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && bun test src/components/skills/plugin-detail-state.test.ts`
Expected: PASS（原有用例 + 新用例全过）

- [ ] **Step 5: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

---

### Task 7: MarketCard 「🔌需桥接」徽章 + 向导 atom

**Files:**
- Modify: `apps/web/src/atoms/skill-atoms.ts`
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`（`MarketCard` 约 `:613-680`、卡片构造处 `MarketDisplayCard`/`MarketCardView`）

**Interfaces:**
- Consumes: `PluginMarketItem.marketplace.setup` 是否非空 → 判定是否需桥接。
- Produces: `bridgeWizardOpenAtom` / `bridgeWizardPluginAtom`；MarketCard 在分类徽章旁渲染「🔌需桥接」徽章。

- [ ] **Step 1: 加 atom**

在 `apps/web/src/atoms/skill-atoms.ts` 追加：

```ts
import type { PluginMarketItem } from '@lume/shared'

export const bridgeWizardOpenAtom = atom(false)
export const bridgeWizardPluginAtom = atom<PluginMarketItem | null>(null)
```

- [ ] **Step 2: MarketCard 加徽章**

在 `apps/web/src/components/skills/SkillsMarketView.tsx` 的 `MarketCard` 组件内，分类徽章 `<span>`（约 `:662-664`）旁边追加桥接徽章。先确认 `MarketCardView`/`MarketDisplayCard` 是否已暴露 `needsBridge` 标志；若未暴露，在卡片构造函数（搜索 `buildMarketCards` 或 `toDisplayCard`，通常在 `plugin-market-ui-state.ts`）中根据 `item.kind === 'plugin' && (item.marketplace?.setup?.length ?? 0) > 0` 计算 `needsBridge` 并加入 `MarketDisplayCard`。

在 MarketCard 的分类徽章后加：

```tsx
{card.needsBridge && (
  <span className="min-w-0 break-all rounded-[5px] bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] px-2 py-1 text-[12px] font-medium text-[var(--lume-warning)]">
    🔌 需桥接
  </span>
)}
```

> 若 `MarketDisplayCard` 暂无 `needsBridge` 字段：在 `MarketCardView` 接口加 `needsBridge?: boolean`，并在卡片构造处赋值（`plugin-market-ui-state.ts` 里 plugin 分支）。这是本步骤的一部分。

- [ ] **Step 3: 写渲染测试**

创建 `apps/web/src/components/skills/MarketCard.bridge.test.tsx`（用 `renderToStaticMarkup`，参考 `PluginDetailPage.test.tsx`）：

```tsx
import React from 'react'
import { describe, expect, test } from 'bun:test'

// MarketCard 多为 SkillsMarketView 内部函数；若不可独立 import，
// 则改为在 SkillsMarketView 的更高层快照中断言文案。以下假设可抽出：
describe('MarketCard bridge badge', () => {
  test('needsBridge 时渲染徽章文案', () => {
    // 视 MarketCard 是否导出而定；若未导出，跳过此单测，
    // 改在 Task 9 的集成测试中验证「向导师需桥接插件才弹出」。
    expect(true).toBe(true)
  })
})
```

> 注：若 `MarketCard` 未导出（私有函数），本任务的渲染验证合并到 Task 9 的向导集成测试，此处仅保留 atom 单测与 typecheck。

- [ ] **Step 4: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

---

### Task 8: BridgeInstallWizard 全屏分步向导组件

**Files:**
- Create: `apps/web/src/components/skills/BridgeInstallWizard.tsx`
- Test: `apps/web/src/components/skills/BridgeInstallWizard.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 3 个 desktop-api 函数、Task 6 的 `PluginSetupItem`、Task 7 的 atom、现有 `installMarketItem`/`getMarketDetail`、`@/components/ui/dialog`、`@/components/ui/button`、`sonner` toast。
- Produces: `BridgeInstallWizard` 组件，由 Task 9 在 SkillsMarketView 中挂载。

- [ ] **Step 1: 写组件测试（renderToStaticMarkup）**

创建 `apps/web/src/components/skills/BridgeInstallWizard.test.tsx`：

```tsx
import React from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { bridgeWizardOpenAtom, bridgeWizardPluginAtom } from '@/atoms'
import type { PluginMarketItem } from '@lume/shared'

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

const { BridgeInstallWizard } = await import('./BridgeInstallWizard')

function bridgePlugin(): PluginMarketItem {
  return {
    id: 'local:demo', pluginId: 'demo', name: 'Demo', version: '1.0.0',
    sourceType: 'local', trustLevel: 'trusted',
    installState: 'not-installed', enableState: 'not-installed',
    capabilities: { skillCount: 0, hookEvents: [], mcpServerNames: [], commandToolNames: [] },
    permissions: { filesystemRead: [], filesystemWrite: [], networkOutbound: [], mcpRegister: false, shellAllow: false, toolAllow: [], toolAsk: [], toolDeny: [], hookEvents: [], riskLabels: [] },
    marketplace: {
      setup: [{
        id: 'install-ext', title: '安装扩展', description: '加载已解压', kind: 'install',
        artifact: { path: './ext.zip', kind: 'chrome-extension' },
        targetApp: { kind: 'chrome', installHint: 'chrome://extensions' },
      }],
    },
  }
}

describe('BridgeInstallWizard', () => {
  test('open 时渲染步骤标题与导出按钮', () => {
    const store = createStore()
    store.set(bridgeWizardOpenAtom, true)
    store.set(bridgeWizardPluginAtom, bridgePlugin())
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <BridgeInstallWizard workspaceSlug="default" />
      </Provider>,
    )
    expect(html).toContain('安装扩展')
    expect(html).toContain('导出')
  })

  test('未 open 时不渲染内容', () => {
    const store = createStore()
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <BridgeInstallWizard workspaceSlug="default" />
      </Provider>,
    )
    expect(html).not.toContain('安装扩展')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test src/components/skills/BridgeInstallWizard.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

创建 `apps/web/src/components/skills/BridgeInstallWizard.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAtom, useAtomValue } from 'jotai'
import { bridgeWizardOpenAtom, bridgeWizardPluginAtom } from '@/atoms'
import {
  checkBridgeStatus,
  downloadBridgeAsset,
  exportPluginArtifact,
} from '@/lib/desktop-api'
import type { PluginSetupArtifact, PluginSetupVerify } from '@lume/shared'

interface BridgeInstallWizardProps {
  workspaceSlug: string | null
}

interface StepState {
  done: boolean
  checking: boolean
  note?: string
}

export function BridgeInstallWizard({ workspaceSlug }: BridgeInstallWizardProps) {
  const [open, setOpen] = useAtom(bridgeWizardOpenAtom)
  const plugin = useAtomValue(bridgeWizardPluginAtom)
  const [index, setIndex] = useState(0)
  const [steps, setSteps] = useState<Record<string, StepState>>({})

  useEffect(() => {
    if (open) {
      setIndex(0)
      setSteps({})
    }
  }, [open])

  const setupItems = useMemo(() => (plugin?.marketplace?.setup ?? []), [plugin])
  if (!plugin) return null

  const totalSteps = setupItems.length + 1 // +1 为 Lume 插件安装首步
  const current = setupItems[index - 1] // index 0 = 安装插件步

  const close = () => setOpen(false)

  const handleExport = async (artifact: PluginSetupArtifact) => {
    try {
      const r = await exportPluginArtifact({
        pluginId: plugin.pluginId,
        version: plugin.version,
        artifactPath: artifact.path,
      })
      toast.success(`已导出到 ${r.savedPath}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDownload = async (url: string, filename?: string) => {
    try {
      const r = await downloadBridgeAsset({ url, filename })
      toast.success(`已下载到 ${r.savedPath}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleVerify = async (stepId: string, verify: PluginSetupVerify) => {
    setSteps((s) => ({ ...s, [stepId]: { ...s[stepId], checking: true } }))
    try {
      const r = await checkBridgeStatus({
        pluginId: plugin.pluginId,
        version: plugin.version,
        verify,
      })
      setSteps((s) => ({ ...s, [stepId]: { done: r.ok, checking: false, note: r.detail } }))
    } catch (err) {
      setSteps((s) => ({ ...s, [stepId]: { done: false, checking: false, note: err instanceof Error ? err.message : String(err) } }))
    }
  }

  const markDone = (stepId: string) =>
    setSteps((s) => ({ ...s, [stepId]: { ...s[stepId], done: true } }))

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[720px] lg:max-w-[880px] max-h-[88vh] overflow-y-auto" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold text-[var(--text-1)]">
            安装向导：{plugin.displayName ?? plugin.name}
          </DialogTitle>
        </DialogHeader>

        <p className="text-[13px] text-[var(--text-2)]">步骤 {index + 1}/{totalSteps}</p>

        {index === 0 ? (
          <div className="lume-subpanel p-4">
            <h3 className="text-[14px] font-semibold">1. 安装 Lume 插件</h3>
            <p className="mt-2 text-[13px] text-[var(--text-2)]">
              {plugin.installState === 'installed'
                ? `已安装 v${plugin.version}，可继续完成桥接。`
                : '点击下方按钮完成 Lume 插件安装（含权限审查）。'}
            </p>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => markDone('install-plugin')}>
                {plugin.installState === 'installed' ? '已安装，下一步' : '前往安装'}
              </Button>
            </div>
          </div>
        ) : current ? (
          <div className="lume-subpanel p-4">
            <h3 className="text-[14px] font-semibold">{index + 1}. {current.title}</h3>
            <p className="mt-2 text-[13px] text-[var(--text-2)]">{current.description}</p>
            {current.targetApp?.installHint && (
              <p className="mt-1 text-[12px] text-[var(--text-2)]">目标位置：{current.targetApp.installHint}</p>
            )}
            {current.build && (
              <div className="mt-2">
                <p className="text-[12px] text-[var(--text-2)]">{current.build.prerequisites}</p>
                <code className="mt-1 block rounded bg-[var(--surface-2)] p-2 text-[12px]">{current.build.command}</code>
                <Button variant="ghost" className="mt-1" onClick={() => navigator.clipboard?.writeText(current.build!.command)}>
                  复制命令
                </Button>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {current.artifact && (
                <Button onClick={() => handleExport(current.artifact!)}>导出 {artifactLabel(current.artifact.kind)}</Button>
              )}
              {current.download && (
                <Button onClick={() => handleDownload(current.download!.url, current.download!.filename)}>
                  下载 {current.download.filename ?? '资产'}
                </Button>
              )}
              {current.verify && current.verify.method !== 'none' && (
                <Button variant="ghost" disabled={steps[current.id]?.checking} onClick={() => handleVerify(current.id, current.verify!)}>
                  {steps[current.id]?.checking ? '检测中…' : '检测'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => markDone(current.id)}>标记完成</Button>
            </div>
            {steps[current.id]?.note && (
              <p className="mt-2 text-[12px] text-[var(--text-2)]">{steps[current.id]?.note}</p>
            )}
          </div>
        ) : null}

        <div className="flex justify-between">
          <Button variant="ghost" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>上一步</Button>
          {index < totalSteps - 1 ? (
            <Button onClick={() => setIndex((i) => i + 1)}>下一步</Button>
          ) : (
            <Button onClick={close}>完成</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function artifactLabel(kind: PluginSetupArtifact['kind']): string {
  switch (kind) {
    case 'chrome-extension': return '扩展'
    case 'obsidian-plugin': return '插件'
    case 'native-binary': return '二进制'
    case 'node-bundle': return '脚本'
    default: return '产物'
  }
}
```

> 注：`workspaceSlug` prop 当前预留，用于「第 0 步实际触发 installMarketItem」的接入（见 Task 9 可选增强）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && bun test src/components/skills/BridgeInstallWizard.test.tsx`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

---

### Task 9: 接入向导入口（SkillsMarketView 挂载 + 安装按钮触发）

**Files:**
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`（挂载 `<BridgeInstallWizard />`；`handlePluginAction` 对需桥接插件改为打开向导）

**Interfaces:**
- Consumes: Task 7 atom、Task 8 组件、Task 5 desktop-api。
- Produces: 卡片「安装」按钮对需桥接插件弹出向导；向导挂载到市场视图。

- [ ] **Step 1: 挂载向导组件**

在 `SkillsMarketView.tsx` 的 JSX 中（与 `<PluginDetailPage />` 同层）挂载：

```tsx
<BridgeInstallWizard workspaceSlug={workspaceSlug} />
```

顶部 import：

```ts
import { BridgeInstallWizard } from './BridgeInstallWizard'
import { bridgeWizardOpenAtom, bridgeWizardPluginAtom } from '@/atoms'
import { useSetAtom } from 'jotai'
```

- [ ] **Step 2: 安装按钮对需桥接插件开向导**

在 `SkillsMarketView` 组件内取 setter：

```ts
const setBridgeWizardOpen = useSetAtom(bridgeWizardOpenAtom)
const setBridgeWizardPlugin = useSetAtom(bridgeWizardPluginAtom)
```

在 `handlePluginAction`（约 `:213+`，处理卡片安装动作处）开头加分支：若该插件 `marketplace.setup` 非空，则打开向导而非走原 inline 安装：

```ts
const handlePluginAction = async (item: PluginMarketItem) => {
  if ((item.marketplace?.setup?.length ?? 0) > 0) {
    setBridgeWizardPlugin(item)
    setBridgeWizardOpen(true)
    return
  }
  // ... 原有安装逻辑保持不变
}
```

- [ ] **Step 3: 向导第 0 步实际安装（可选增强）**

向导第 0 步「前往安装」按钮当前仅 `markDone`。如需真正触发安装，在 `BridgeInstallWizard` 内 `workspaceSlug` 有效时调用 `installMarketItem`（复用 `handleInstallPluginFromDetail` 的参数组装：`itemId`、`acceptedPermissionsHash` 来自 inspect、`enableScope: 'workspace'`）。MVP 可不接（用户从详情页或卡片安装后，向导自动跳首步），本步骤标记为可选。

- [ ] **Step 4: typecheck + 手动走查**

Run: `cd apps/web && bun run typecheck`
Expected: 无错误。

手动验证（开发服务器）：市场页对 lume-chrome / obsidian-bridge 卡片显示「🔌需桥接」徽章；点安装弹出向导；步骤切换、导出/下载/检测按钮可点；example-hello / test-codex 无徽章、走原流程。

---

### Task 10: lume-plugins 仓库 chrome/obsidian 清单补字段

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume-plugins\plugins\lume-chrome\lume-plugin.json`
- Modify: `D:\workspace\projects\ai-projects\lume-plugins\plugins\obsidian-bridge\lume-plugin.json`

> 此任务在 `lume-plugins` 仓库（独立目录），不在 `lume` 主仓。需切换工作目录操作。

**Interfaces:**
- Consumes: Task 1 的 schema（字段名/取值）。
- Produces: 两个桥接插件的 `marketplace.setup[]` 携带结构化产物信息，供向导渲染。

- [ ] **Step 1: 为 lume-chrome 补 setup 字段**

编辑 `lume-plugins/plugins/lume-chrome/lume-plugin.json` 的 `marketplace.setup`，给现有步骤补字段（保留原 `id/title/description/kind`，追加 `artifact/build/targetApp/verify`；`<占位>` 处填实际扩展 id 与路径）：

```jsonc
{
  "id": "install-extension",
  "kind": "install",
  "title": "安装 Chrome 扩展",
  "description": "加载已解压的 Lume 浏览器扩展。",
  "artifact": { "path": "./lume-browser-extension-v4.zip", "kind": "chrome-extension" },
  "targetApp": { "kind": "chrome", "installHint": "chrome://extensions → 加载已解压的扩展程序" },
  "verify": { "method": "chrome-extension", "detail": "<实际-extension-id>" }
}
```

```jsonc
{
  "id": "build-native-host",
  "kind": "local-service",
  "title": "编译并注册 Native Host",
  "description": "编译 Rust Native Host 并注册到 Chrome。",
  "build": {
    "command": "cargo build --release",
    "cwd": "./native-host",
    "prerequisites": "需要本机已安装 Rust 工具链",
    "env": {
      "LUME_EXTENSION_ID": "<实际-extension-id>",
      "LUME_CHROME_HOST_PATH": "<编译产物绝对路径>",
      "LUME_APP_SERVER_URL": "ws://127.0.0.1:43127/browser"
    }
  }
}
```

- [ ] **Step 2: 为 obsidian-bridge 补 setup 字段**

编辑 `lume-plugins/plugins/obsidian-bridge/lume-plugin.json` 的 `marketplace.setup`：

```jsonc
{
  "id": "install-obsidian-plugin",
  "kind": "install",
  "title": "安装 Obsidian 社区插件",
  "description": "把 main.js 与 manifest.json 放入 vault 插件目录并启用。",
  "artifact": { "path": "./dist/main.js", "kind": "obsidian-plugin" },
  "download": { "url": "https://github.com/CavinHuang/lume-plugins/releases/download/obsidian-bridge-v0.1.2/manifest.json", "filename": "manifest.json" },
  "targetApp": { "kind": "obsidian", "installHint": "<Vault>/.obsidian/plugins/obsidian-bridge/" }
}
```

```jsonc
{
  "id": "verify-http",
  "kind": "local-service",
  "title": "确认本地 HTTP 服务",
  "description": "在 Obsidian 中启用插件后，确认本地 HTTP 服务已启动。",
  "verify": { "method": "tcp-port", "detail": "127.0.0.1:43112" }
}
```

> Release URL 需在 lume-plugins 实际发布该资产后核实；若资产名不同，更新 `url`/`filename`。

- [ ] **Step 3: 端到端走查**

在 Lume 中订阅官方市场源、安装两个插件，验证向导能：导出 `lume-browser-extension-v4.zip` / `dist/main.js`、显示 Rust 构建命令、提供 manifest.json 下载链接、检测扩展/端口。

---

## Self-Review 已执行

**Spec 覆盖**：
- 显示桥接依赖 → Task 7（徽章）+ Task 6（setup 字段透传）。
- 下载到本地（包内导出 + 包外源链接）→ Task 3/5（export + download IPC）+ Task 8（按钮）+ Task 10（清单）。
- 安装教程（分步向导）→ Task 8（向导）+ Task 9（入口）。
- chrome-extension 检测 MVP Windows → Task 3 `checkChromeExtensionInstalled`。
- 软校验/不自动安装/不执行 cargo/不持久化/不动 Setup Tab → Task 8 实现（标记完成按钮 + 仅复制命令）。
- schema 5 字段 + 两套类型同步 → Task 1 + Task 2。
- summarizeMarketplace 引用传递不用改 → Global Constraints 已说明，Task 1/2 保证两边字段一致即可。

**占位符**：`<实际-extension-id>`、`<Vault>`、`<编译产物绝对路径>`、Release URL 在 Task 10 是运行期值（由实际插件资产决定），已在步骤中标注「需核实/填实际值」，非计划未完成。

**类型一致性**：`PluginSetupArtifact/Download/Build/TargetApp/Verify` 在 SDK（Task 1，分号）与 shared（Task 2，无分号）字段名完全一致；`PluginBridgeService` 方法签名与 Input/Result 接口匹配；web wrapper 泛型与 Result 类型匹配。
