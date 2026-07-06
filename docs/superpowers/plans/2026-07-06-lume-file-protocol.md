# lume-file 协议实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用自定义 `lume-file://` 协议流式渲染 thread + workspace 图片，替代 base64，并让 workspace 图片首次可预览。

**Architecture:** main 注册 privileged scheme `lume-file`，`protocol.handle` 解码 URL → 纯函数 `resolveFileProtocolPath` 做白名单根 + 反穿越 + UNC + realpath 校验 → `net.fetch(pathToFileURL(abs))` 返回文件流；renderer `<img src=lume-file://...>` 由 Chromium 原生解码。

**Tech Stack:** Electron（protocol/net）、node:path、node:url、TypeScript/React、bun:test（web）、node:test（desktop）。

**Spec:** `docs/superpowers/specs/2026-07-06-lume-file-protocol-design.md`

## Global Constraints

- **路径安全**：handler 必须经 §4 四层校验（编码攻击 / 白名单根 / UNC / realpath），任一失败返回 403/404。校验抽纯函数 `resolveFileProtocolPath` 以便测试。
- **git 约束（用户全局规范）**：本项目未经用户明确要求，**不得执行 `git add/commit/push/branch`**。本计划中标注 "Commit" 的步骤视为**逻辑断点**——执行到此暂停、向用户汇报，由用户决定是否提交；不得自行运行 git 命令。
- **测试**：desktop 用 `node:test` + `node:assert/strict`（参照 `apps/desktop/scripts/electron-security.test.mjs`）；web 用 `bun:test`（参照 `apps/web/src/components/agent/file-link-actions.test.ts`）。命令前缀 `rtk`（如 `rtk bun test`、`rtk tsc --noEmit`）。
- **注释语言**：与现有代码一致，使用简体中文注释。
- **surgical**：只改本计划列出的文件；不重构无关代码。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/desktop/src/electron-security.ts` | 新增纯函数 `resolveFileProtocolPath(url, workspacesRoot)` | 修改 |
| `apps/desktop/scripts/electron-security.test.mjs` | `resolveFileProtocolPath` 测试矩阵 | 修改 |
| `apps/desktop/src/main.ts` | 注册 scheme + `protocol.handle` handler；新增 `registerFileProtocol`；import 补 `realpathSync`/`statSync` | 修改 |
| `apps/web/index.html` | CSP `img-src` 增补 `lume-file:` | 修改 |
| `apps/web/src/components/right-panel/file-preview-utils.ts` | 新增 `lumeFileUrl`；删除 `imageMimeType`/`imageDataUrl`；保留 `isImageFile` | 修改 |
| `apps/web/src/components/right-panel/file-preview-utils.test.ts` | 更新（删 imageDataUrl 测试，加 lumeFileUrl 测试） | 修改 |
| `apps/web/src/components/right-panel/FilesRightPanelTab.tsx` | 撤回 base64 分支 → `lumeFileUrl` | 修改 |
| `apps/web/src/components/agent/RuntimeEventContentBlock.tsx` | `useThreadImageAttachmentSrcs` 撤回 base64 → `resolveAbsolutePath` + `lumeFileUrl` | 修改 |

---

### Task 1: 纯函数 `resolveFileProtocolPath` + 测试矩阵

**Files:**
- Modify: `apps/desktop/src/electron-security.ts`（在 `resolveAppProtocolFilePath` 之后插入）
- Test: `apps/desktop/scripts/electron-security.test.mjs`

**Interfaces:**
- Produces: `resolveFileProtocolPath(url: string, workspacesRoot: string): { kind: 'ok', absPath: string } | { kind: 'forbidden' } | { kind: 'notfound' }`

- [ ] **Step 1: 写失败测试（在 electron-security.test.mjs 末尾追加）**

```js
import { resolveFileProtocolPath } from "../src/electron-security.ts";
import { tmpdir } from "node:os";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";

const ROOT = mkdtempSync(join(tmpdir(), "lume-file-"));
const IMG = resolve(ROOT, "a.png");
writeFileSync(IMG, "x");
// 跨平台分隔符的白名单前缀（确保 startsWith + sep 生效）
const ROOT_PREFIX = ROOT.endsWith(sep) ? ROOT : ROOT + sep;

test("resolveFileProtocolPath: 合法绝对路径返回 ok", () => {
  const url = `lume-file://file/${encodeURIComponent(IMG)}`;
  assert.deepEqual(resolveFileProtocolPath(url, ROOT), { kind: "ok", absPath: IMG });
});

test("resolveFileProtocolPath: 白名单根外返回 forbidden", () => {
  const outside = resolve(ROOT, "..", "secret.png");
  const url = `lume-file://file/${encodeURIComponent(outside)}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: %2e%2e 编码攻击返回 forbidden", () => {
  const url = `lume-file://file/${ROOT_PREFIX}%2e%2e%2fsecret`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: %5c..%5c 返回 forbidden", () => {
  const url = `lume-file://file/${encodeURIComponent(ROOT)}%5c..%5csecret`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: %00 返回 forbidden", () => {
  const url = `lume-file://file/${encodeURIComponent(IMG)}%00`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: UNC 路径返回 forbidden", () => {
  const url = `lume-file://file/${encodeURIComponent("\\\\server\\share\\x.png")}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: symlink 越界返回 forbidden", () => {
  const linkDir = mkdtempSync(join(tmpdir(), "lume-out-"));
  const target = resolve(linkDir, "secret.png");
  writeFileSync(target, "x");
  const link = resolve(ROOT, "link.png");
  try { symlinkSync(target, link); } catch { return; } // 无权限创建 symlink 的环境跳过
  const url = `lume-file://file/${encodeURIComponent(link)}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "forbidden");
});

test("resolveFileProtocolPath: 不存在返回 notfound", () => {
  const url = `lume-file://file/${encodeURIComponent(resolve(ROOT, "nope.png"))}`;
  assert.equal(resolveFileProtocolPath(url, ROOT).kind, "notfound");
});
```

需在文件顶部 import 区补 `import { join, resolve, sep } from "node:path";`（若已有 `resolve` 则只补 `sep`/`join`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && rtk proxy node --test --import tsx scripts/electron-security.test.mjs`
Expected: FAIL（`resolveFileProtocolPath is not a function` 或 import 失败）

- [ ] **Step 3: 实现 `resolveFileProtocolPath`（electron-security.ts，`resolveAppProtocolFilePath` 之后）**

```ts
import { realpathSync, statSync, existsSync } from 'node:fs'   // 顶部 import 区补（若未导入）
import { isAbsolute, resolve as pathResolve, sep } from 'node:path'  // 顶部补 sep（resolve/isAbsolute 已有）

export type FileProtocolResolution =
  | { kind: 'ok'; absPath: string }
  | { kind: 'forbidden' }
  | { kind: 'notfound' }

/**
 * 解析 lume-file:// 协议 URL 到可信绝对路径。
 * 四层校验：URL 编码攻击 → 白名单根 → UNC → symlink 逃逸（realpath）。
 * 返回 'forbidden'（越界/攻击）、'notfound'（不存在或非文件）、'ok'（可信绝对路径）。
 */
export function resolveFileProtocolPath(url: string, workspacesRoot: string): FileProtocolResolution {
  try {
    // 1) URL 编码层面的攻击（%00 / %2e / %2f / %5c）
    if (/%(?:00|2e|2f|5c)/i.test(url)) return { kind: 'forbidden' }

    const parsed = new URL(url)
    const raw = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, '')
    const abs = decodeURIComponent(raw.startsWith('file/') ? raw.slice('file/'.length) : raw)
    const norm = pathResolve(abs)

    // 2) 白名单根
    const root = pathResolve(workspacesRoot)
    if (!norm.startsWith(root + sep)) return { kind: 'forbidden' }

    // 3) 禁 UNC（Windows）
    if (sep === '\\' && norm.startsWith('\\\\')) return { kind: 'forbidden' }

    // 4) realpath 校验（防 symlink 逃逸）
    let real: string
    try {
      real = realpathSync(norm)
    } catch {
      return { kind: 'notfound' }
    }
    if (!real.startsWith(root + sep)) return { kind: 'forbidden' }

    // 5) 必须是文件
    if (!existsSync(real) || !statSync(real).isFile()) return { kind: 'notfound' }

    return { kind: 'ok', absPath: real }
  } catch {
    return { kind: 'forbidden' }
  }
}
```

注：顶部 import 区若已 `import { existsSync, readFileSync, ... } from 'node:fs'`，把 `realpathSync, statSync` 加进去；`node:path` 若已 `import { join, resolve } from 'node:path'`，改为 `import { isAbsolute, join, resolve, sep } from 'node:path'`（`isAbsolute` 本函数未直接用，保留原样即可，仅需 `sep`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && rtk proxy node --test --import tsx scripts/electron-security.test.mjs`
Expected: PASS（含新增 8 个用例）

- [ ] **Step 5: Commit（逻辑断点）**

汇报 Task 1 完成，暂停等待用户决定是否 `git commit`。

---

### Task 2: main 注册 `lume-file` scheme + handler

**Files:**
- Modify: `apps/desktop/src/main.ts`

**Interfaces:**
- Consumes: `resolveFileProtocolPath`（Task 1）、`resolveConfigDir`（已存在，main.ts:153）、`net`/`protocol`/`pathToFileURL`（已 import）

- [ ] **Step 1: 常量定义（找到 `APP_PROTOCOL` 常量定义处，旁添）**

定位 `APP_PROTOCOL` 定义（`grep -n "APP_PROTOCOL =" apps/desktop/src/main.ts` 或在 desktop-core.ts）。在其旁新增：

```ts
export const FILE_PROTOCOL = 'lume-file'
```

- [ ] **Step 2: 注册为 privileged scheme（main.ts:118 的 `registerSchemesAsPrivileged` 数组追加一项）**

```ts
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: FILE_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])
```

- [ ] **Step 3: 新增 `registerFileProtocol` 函数（在 `registerAppProtocol` 函数之后）**

```ts
function registerFileProtocol() {
  protocol.handle(FILE_PROTOCOL, async (request) => {
    const workspacesRoot = join(resolveConfigDir(), 'agent-workspaces')
    const resolved = resolveFileProtocolPath(request.url, workspacesRoot)
    if (resolved.kind === 'forbidden') return new Response('Forbidden', { status: 403 })
    if (resolved.kind === 'notfound') return new Response('Not Found', { status: 404 })
    try {
      return net.fetch(pathToFileURL(resolved.absPath))
    } catch {
      return new Response('Internal Error', { status: 500 })
    }
  })
}
```

需在 main.ts 顶部 import 区从 `./electron-security` 补 `resolveFileProtocolPath`（找到现有 `electron-security` import 块，加入）。

- [ ] **Step 4: 在 app ready 区调用 `registerFileProtocol()`**

定位 `registerAppProtocol()` 的调用处（`grep -n "registerAppProtocol()" apps/desktop/src/main.ts`，通常在 `app.whenReady().then(...)` 内）。在其后补一行：

```ts
registerFileProtocol()
```

- [ ] **Step 5: typecheck**

Run: `cd apps/desktop && rtk tsc --noEmit`
Expected: 无错误（若 desktop 无 typecheck script，跳过；main.ts 是 .ts，IDE/tsc 可校验）

- [ ] **Step 6: Commit（逻辑断点）**

汇报 Task 2 完成，暂停。

---

### Task 3: CSP 增补 `lume-file:`

**Files:**
- Modify: `apps/web/index.html:7`
- Verify: `apps/web/scripts/security-policy.test.mjs`、`scripts/verify-desktop-package-inputs.mjs`

- [ ] **Step 1: 修改 index.html CSP 的 img-src**

将 `apps/web/index.html:7` 的 `img-src 'self' data: blob: file: https: http:` 改为：

```
img-src 'self' data: blob: file: https: http: lume-file:;
```

（仅追加 ` lume-file:`，其余 CSP 指令不动）

- [ ] **Step 2: 检查 CSP 测试脚本是否断言 img-src 具体内容**

Run: `grep -n "img-src" apps/web/scripts/security-policy.test.mjs scripts/verify-desktop-package-inputs.mjs`

若任一脚本断言了 img-src 的精确内容（会因增补 `lume-file:` 而失败），同步更新断言；若仅断言 `default-src 'self'` 等其他指令，则无需改动。

- [ ] **Step 3: 跑 CSP 测试确认通过**

Run: `cd apps/web && rtk proxy node --test scripts/security-policy.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit（逻辑断点）**

汇报 Task 3 完成，暂停。

---

### Task 4: renderer `lumeFileUrl` 工具 + 调整 file-preview-utils

**Files:**
- Modify: `apps/web/src/components/right-panel/file-preview-utils.ts`
- Test: `apps/web/src/components/right-panel/file-preview-utils.test.ts`

**Interfaces:**
- Produces: `lumeFileUrl(absPath: string): string` —— `lume-file://file/<encodeURIComponent(absPath)>`
- Removes: `imageMimeType`、`imageDataUrl`（协议方式不再需要 MIME）
- Keeps: `isImageFile`

- [ ] **Step 1: 更新测试（file-preview-utils.test.ts）**

删除 `imageMimeType`、`imageDataUrl` 两个 describe 块；新增 `lumeFileUrl` 测试：

```ts
import { isImageFile, lumeFileUrl } from "./file-preview-utils"

describe("lumeFileUrl", () => {
  test("编码绝对路径为 lume-file URL", () => {
    expect(lumeFileUrl("/data/threads/t1/a.png")).toBe(
      "lume-file://file/" + encodeURIComponent("/data/threads/t1/a.png"),
    )
  })
  test("Windows 绝对路径也被正确编码", () => {
    const p = "C:\\data\\threads\\t1\\a.png"
    expect(lumeFileUrl(p)).toBe("lume-file://file/" + encodeURIComponent(p))
  })
})
```

保留 `isImageFile` 的 describe 块不动。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && rtk bun test src/components/right-panel/file-preview-utils.test.ts`
Expected: FAIL（`lumeFileUrl is not exported`，且旧的 imageMimeType/imageDataUrl 测试因 import 失败）

- [ ] **Step 3: 改 file-preview-utils.ts**

替换整个文件内容为：

```ts
/** 预览支持的内联图片扩展名集合（用于判断是否走图片渲染分支） */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

function imageExt(filePath: string): string | undefined {
  return /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase()
}

/** 是否为可内联预览的图片文件（按扩展名判断） */
export function isImageFile(filePath: string): boolean {
  const ext = imageExt(filePath)
  return ext !== undefined && IMAGE_EXTENSIONS.has(ext)
}

/**
 * 构造 lume-file:// 协议 URL，交由 Electron main 流式读取并交 Chromium 解码。
 * 仅适用于 .lume/agent-workspaces 可信根内的文件（thread/workspace）。
 */
export function lumeFileUrl(absPath: string): string {
  return `lume-file://file/${encodeURIComponent(absPath)}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && rtk bun test src/components/right-panel/file-preview-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（逻辑断点）**

汇报 Task 4 完成，暂停。

---

### Task 5: `FilesRightPanelTab` 撤回 base64 → 协议 URL

**Files:**
- Modify: `apps/web/src/components/right-panel/FilesRightPanelTab.tsx`

**Interfaces:**
- Consumes: `isImageFile`、`lumeFileUrl`（Task 4）

- [ ] **Step 1: 撤回 import**

把 `import { imageDataUrl, isImageFile } from './file-preview-utils'` 改为：

```ts
import { isImageFile, lumeFileUrl } from './file-preview-utils'
```

- [ ] **Step 2: 撤回 imageData state**

删除 `const [imageData, setImageData] = useState<string | null>(null)` 这一行（Task 前序本计划外的本轮改动）。

- [ ] **Step 3: 撤回 loadPreview 的图片分支 + setImageData 调用**

把 `loadPreview` 中以下三处删掉/还原：
- 删除 `if (isImageFile(selectedPath) && source === 'thread') { ... return }` 整块
- 删除空选 / 文本分支前的 `setImageData(null)`（两处）
- 删除 catch 中的 `setImageData(null)`

还原为：空选 `setContent(''); setTruncated(false); setError(null); return`，文本走原 READ_FILE / READ_WORKSPACE_FILE / memory 分支。

- [ ] **Step 4: 改渲染分支为协议 URL**

把渲染区的：

```tsx
{isImage && imageData ? (
  <img
    src={imageDataUrl(selectedPath, imageData)}
    alt={basename(selectedPath)}
    className="max-h-[72vh] w-auto max-w-full rounded-[8px] border border-border/60 bg-foreground/[0.02] object-contain"
  />
) : state.enhancedView && isMarkdown ? (
```

改为（撤回 `&& imageData` 条件，src 改协议 URL，加 `onError` 占位）：

```tsx
{isImage ? (
  <img
    src={lumeFileUrl(selectedPath)}
    alt={basename(selectedPath)}
    className="max-h-[72vh] w-auto max-w-full rounded-[8px] border border-border/60 bg-foreground/[0.02] object-contain"
    onError={(event) => {
      const img = event.currentTarget
      img.style.display = 'none'
      const fallback = document.createElement('div')
      fallback.className = 'rounded-[8px] border border-border/60 bg-foreground/[0.03] px-4 py-3 text-[13px] text-foreground/55'
      fallback.textContent = '无法预览此文件'
      img.parentElement?.appendChild(fallback)
    }}
  />
) : state.enhancedView && isMarkdown ? (
```

- [ ] **Step 5: typecheck**

Run: `cd apps/web && rtk tsc --noEmit 2>&1 | grep -iE "FilesRightPanelTab|file-preview-utils" || echo "=== 无相关错误 ==="`
Expected: 无相关错误

- [ ] **Step 6: Commit（逻辑断点）**

汇报 Task 5 完成，暂停。

---

### Task 6: `useThreadImageAttachmentSrcs` 撤回 base64 → 协议 URL

**Files:**
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`

**Interfaces:**
- Consumes: `resolveAbsolutePath`（`@/components/agent/file-link-actions`，已存在）、`lumeFileUrl`（`@/components/right-panel/file-preview-utils`，Task 4）

- [ ] **Step 1: import 补 `resolveAbsolutePath` 与 `lumeFileUrl`**

在 RuntimeEventContentBlock.tsx 顶部 import 区补：

```ts
import { resolveAbsolutePath } from '@/components/agent/file-link-actions'
import { lumeFileUrl } from '@/components/right-panel/file-preview-utils'
```

（确认 `resolveAbsolutePath` 已从 file-link-actions 导出——前序轮次已 export）

- [ ] **Step 2: 改 `useThreadImageAttachmentSrcs` 签名 + 实现（491-528）**

把整个函数替换为：

```ts
function useThreadImageAttachmentSrcs(
  threadId: string,
  attachments: AgentMessageAttachmentInput[] | undefined,
  workspaceSlug?: string,
): Record<string, string | undefined> {
  const [srcById, setSrcById] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    const imageAttachments = (attachments ?? []).filter(isImageAttachment)
    if (imageAttachments.length === 0) {
      setSrcById({})
      return
    }

    let cancelled = false
    setSrcById({})
    void Promise.all(imageAttachments.map(async (attachment) => {
      try {
        // 解析 thread 文件绝对路径，再编码为 lume-file:// 协议 URL（main 流式读取，不 base64）
        const abs = await resolveAbsolutePath({
          source: 'thread',
          relPath: attachment.threadPath,
          threadId,
          ...(workspaceSlug ? { workspaceSlug } : {}),
        })
        return [attachment.id, lumeFileUrl(abs)] as const
      } catch (error) {
        console.error('[RuntimeEventContentBlock] 加载附件图片失败:', error)
        return [attachment.id, undefined] as const
      }
    })).then((entries) => {
      if (cancelled) return
      setSrcById(Object.fromEntries(entries))
    })

    return () => {
      cancelled = true
    }
  }, [attachments, threadId, workspaceSlug])

  return srcById
}
```

- [ ] **Step 3: 调用处传 workspaceSlug（323 行）**

把：

```ts
const imageSrcById = useThreadImageAttachmentSrcs(threadId, message.attachments)
```

改为（参照同文件 1477 行 `env.workspaceSlug` 模式；若当前组件作用域变量名为 `workspaceSlug` 而非 `env.workspaceSlug`，用对应变量）：

```ts
const imageSrcById = useThreadImageAttachmentSrcs(threadId, message.attachments, env?.workspaceSlug)
```

若该组件无 `env` 或 `workspaceSlug` 变量，则保留原调用（不传第三参），`resolveAbsolutePath` 仍能由 threadId 经 GET_THREAD_PATH 解析 workspace。

- [ ] **Step 4: 更新受影响测试（若有）**

Run: `grep -rn "useThreadImageAttachmentSrcs\|imageSrcById" apps/web/src --include="*.test.ts*"`

若测试断言了 data URL 形态，更新为 `lume-file://file/` 前缀的期望；若无相关测试，跳过。

- [ ] **Step 5: typecheck**

Run: `cd apps/web && rtk tsc --noEmit 2>&1 | grep -iE "RuntimeEventContentBlock" || echo "=== 无相关错误 ==="`
Expected: 无相关错误

- [ ] **Step 6: Commit（逻辑断点）**

汇报 Task 6 完成，暂停。

---

### Task 7: 端到端验证

**Files:** 无修改（仅验证）

- [ ] **Step 1: 全量 typecheck**

Run: `cd apps/web && rtk tsc --noEmit`
Expected: TypeScript: No errors found

- [ ] **Step 2: 全量相关单测**

Run:
```
cd apps/web && rtk bun test src/components/right-panel/file-preview-utils.test.ts src/components/agent/file-link-actions.test.ts
cd apps/desktop && rtk proxy node --test --import tsx scripts/electron-security.test.mjs
```
Expected: 全部 PASS

- [ ] **Step 3: 手动端到端（启动 desktop dev）**

启动应用，在右侧面板：
1. 选中 thread 下图片（如 `files/image-gen/*.png`）→ 左侧预览应**直接渲染图片**（非报错、非 base64 占用）。
2. 切到 workspace source 选图片 → **首次能预览**（验证 workspace 支持）。
3. 选中 `.md`/`.txt` → 文本预览不受影响。
4. 对话历史中的图片附件 → 正常渲染。

验证协议生效：devtools Network 面板应见 `lume-file://file/...` 请求返回 200 + 图片内容（非 `data:` URL）。

- [ ] **Step 4: 汇报完成**

向用户汇报所有 Task 完成 + 验证结果，由用户决定是否提交。

---

## Self-Review

**1. Spec 覆盖：**
- §3.1 scheme 注册 → Task 2 Step 2 ✓
- §3.2 handler → Task 2 Step 3-4 ✓
- §3.3 URL 格式 → Task 4（`lumeFileUrl`）✓
- §3.4 CSP → Task 3 ✓
- §4 安全校验 → Task 1（`resolveFileProtocolPath` 四层校验）✓
- §5 renderer 迁移（FilesRightPanelTab / useThreadImageAttachmentSrcs / local 保留）→ Task 5 / 6 /（local 不动）✓
- §6 错误处理（403/404/500 + onError 占位）→ Task 2 Step 3 + Task 5 Step 4 ✓
- §7 测试矩阵 → Task 1 ✓ + Task 4 ✓
- §8 决策记录 → 体现在 Global Constraints + 各 Task ✓

**2. 占位扫描：** 无 TBD/TODO；每步含完整代码或精确命令。Task 6 Step 3 对 `env?.workspaceSlug` 给了 fallback（无 env 时不传），不算占位。

**3. 类型一致性：**
- `resolveFileProtocolPath(url, workspacesRoot): FileProtocolResolution` —— Task 1 定义，Task 2 消费，签名一致 ✓
- `lumeFileUrl(absPath): string` —— Task 4 定义，Task 5/6 消费，签名一致 ✓
- `isImageFile` 保留 —— Task 4 保留，Task 5 消费 ✓
