# 文件链接右键菜单 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为消息流文件链接、附件卡片、右侧文件树、文件预览区四处补一组只读右键菜单（预览/系统打开/Finder 显示/复制相对路径/复制绝对路径/另存为）。

**Architecture:** 引入 `FileLinkContext`（thread/workspace/local 三类来源）+ `resolveAbsolutePath` 汇聚点，所有动作基于解析出的绝对路径走原生 API（`openInSystem`/`revealPathInSystem`/`copyFile`），不再按 source 分派 sidecar channel。共享 `FileLinkContextMenu` 组件 + `resolveFileLinkActions` 动作层，thread 环境经 React Context 透传。

**Tech Stack:** React + TypeScript + base-ui ContextMenu（`@base-ui/react`）+ Tauri 2（Rust 命令）+ Bun（sidecar）+ bun:test（web 测试，SSR 风格）

**Spec:** `docs/superpowers/specs/2026-06-14-file-link-context-menu-design.md`

**测试约定（web 侧）**：使用 `bun:test`，渲染用 `renderToStaticMarkup`（react-dom/server）做字符串断言，mock 用 `mock.module`。单文件运行：`bun test <file路径>`。类型检查：`cd apps/web && bunx tsc --noEmit`。

---

## 文件结构

**新增**
- `apps/web/src/components/agent/file-link-types.ts` — `FileLinkContext` 类型
- `apps/web/src/components/agent/thread-file-env.tsx` — `ThreadFileEnvProvider` / `useThreadFileEnv` Context
- `apps/web/src/components/agent/thread-file-env.test.ts` — Context 测试
- `apps/web/src/components/agent/file-link-actions.ts` — `resolveAbsolutePath` + `resolveFileLinkActions`
- `apps/web/src/components/agent/file-link-actions.test.ts` — 动作层测试
- `apps/web/src/components/ui/FileLinkContextMenu.tsx` — 共享菜单组件 + `buildFileLinkMenuItems` 纯函数
- `apps/web/src/components/ui/FileLinkContextMenu.test.ts` — 菜单项构造测试

**修改**
- `apps/web/src/components/agent/AgentView.tsx` — provide `ThreadFileEnvProvider`
- `apps/web/src/components/agent/RuntimeEventContentBlock.tsx` — 胶囊 `MarkdownCode` 包菜单
- `apps/web/src/components/agent/AgentAttachmentGrid.tsx` — 附件卡片包菜单
- `apps/web/src/components/file-browser/WorkspaceFileBrowser.tsx` — 文件树项包菜单
- `apps/web/src/components/tabs/FilePreviewTabView.tsx` — 预览区包菜单 + 迁移"复制路径"
- `apps/web/src/lib/desktop-api/native.ts` — 新增 `copyFile` 封装
- `apps/desktop/src-tauri/src/main.rs` — 新增 `copy_file` 命令 + 注册

---

## Task 1: FileLinkContext 类型 + ThreadFileEnv Context

**Files:**
- Create: `apps/web/src/components/agent/file-link-types.ts`
- Create: `apps/web/src/components/agent/thread-file-env.tsx`
- Test: `apps/web/src/components/agent/thread-file-env.test.ts`

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/components/agent/thread-file-env.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadFileEnvProvider, useThreadFileEnv } from "./thread-file-env"

function Consumer(): string {
  const env = useThreadFileEnv()
  return JSON.stringify(env)
}

describe("thread-file-env", () => {
  test("default env is empty when no provider", () => {
    const markup = renderToStaticMarkup(<Consumer />)
    expect(JSON.parse(markup)).toEqual({})
  })

  test("provides env value to consumer", () => {
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: "t1", workspaceSlug: "ws-1" }}>
        <Consumer />
      </ThreadFileEnvProvider>,
    )
    expect(JSON.parse(markup)).toEqual({ threadId: "t1", workspaceSlug: "ws-1" })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/src/components/agent/thread-file-env.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现类型与 Context**

Create `apps/web/src/components/agent/file-link-types.ts`:

```ts
export type FileLinkSource = "thread" | "workspace" | "local"

export interface FileLinkContext {
  source: FileLinkSource
  /** thread/workspace 内相对路径；source==="local" 时为绝对路径 */
  relPath: string
  /** source==="thread" 时必填 */
  threadId?: string
  /** source==="thread" | "workspace" 时必填 */
  workspaceSlug?: string
}
```

Create `apps/web/src/components/agent/thread-file-env.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react"

export interface ThreadFileEnv {
  threadId?: string
  workspaceSlug?: string
}

const ThreadFileEnvContext = createContext<ThreadFileEnv>({})

export function ThreadFileEnvProvider({
  value,
  children,
}: {
  value: ThreadFileEnv
  children: ReactNode
}) {
  return <ThreadFileEnvContext.Provider value={value}>{children}</ThreadFileEnvContext.Provider>
}

export function useThreadFileEnv(): ThreadFileEnv {
  return useContext(ThreadFileEnvContext)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/src/components/agent/thread-file-env.test.ts`
Expected: PASS（2 个测试）

- [ ] **Step 5: 类型检查并提交**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 新文件无类型错误

```bash
git add apps/web/src/components/agent/file-link-types.ts apps/web/src/components/agent/thread-file-env.tsx apps/web/src/components/agent/thread-file-env.test.ts
git commit -m "feat(web): 添加 FileLinkContext 类型与 ThreadFileEnv Context"
```

---

## Task 2: resolveAbsolutePath 路径解析

**Files:**
- Create: `apps/web/src/components/agent/file-link-actions.ts`
- Test: `apps/web/src/components/agent/file-link-actions.test.ts`

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/components/agent/file-link-actions.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test"
import { resolveAbsolutePath } from "./file-link-actions"

mock.module("@lume/shared", () => ({
  AGENT_IPC_CHANNELS: {
    GET_THREAD_PATH: "agent:get-thread-path",
    GET_WORKSPACE_RESOURCES_PATH: "agent:get-workspace-resources-path",
  },
}))

const sidecarCalls: Array<{ method: string; params: unknown }> = []
mock.module("@/lib/desktop-api", () => ({
  sidecarCall: async (method: string, params: unknown) => {
    sidecarCalls.push({ method, params })
    if (method === "agent:get-thread-path") return "/data/threads/t1"
    if (method === "agent:get-workspace-resources-path") return "/data/ws/resources"
    throw new Error(`unexpected method ${method}`)
  },
}))

mock.module("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }))

const { resolveAbsolutePath } = await import("./file-link-actions")

describe("resolveAbsolutePath", () => {
  test("local source returns relPath as-is", async () => {
    const abs = await resolveAbsolutePath({ source: "local", relPath: "/abs/path/file.md" })
    expect(abs).toBe("/abs/path/file.md")
    expect(sidecarCalls).toHaveLength(0)
  })

  test("thread source resolves via GET_THREAD_PATH and joins relPath", async () => {
    const abs = await resolveAbsolutePath({
      source: "thread",
      relPath: "plans/research.md",
      threadId: "t1",
      workspaceSlug: "ws-1",
    })
    expect(abs).toBe("/data/threads/t1/plans/research.md")
    expect(sidecarCalls.at(-1)).toEqual({
      method: "agent:get-thread-path",
      params: { threadId: "t1", workspaceSlug: "ws-1" },
    })
  })

  test("workspace source resolves via GET_WORKSPACE_RESOURCES_PATH", async () => {
    const abs = await resolveAbsolutePath({
      source: "workspace",
      relPath: "shared/notes.md",
      workspaceSlug: "ws-1",
    })
    expect(abs).toBe("/data/ws/resources/shared/notes.md")
    expect(sidecarCalls.at(-1)).toEqual({
      method: "agent:get-workspace-resources-path",
      params: { workspaceSlug: "ws-1" },
    })
  })

  test("thread without threadId throws", async () => {
    await expect(
      resolveAbsolutePath({ source: "thread", relPath: "a.md", workspaceSlug: "ws-1" }),
    ).rejects.toThrow("threadId")
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: FAIL（`resolveAbsolutePath` 未导出）

- [ ] **Step 3: 实现 resolveAbsolutePath（最小骨架）**

Create `apps/web/src/components/agent/file-link-actions.ts`:

```ts
import { AGENT_IPC_CHANNELS } from "@lume/shared"
import { sidecarCall } from "@/lib/desktop-api"
import type { FileLinkContext } from "./file-link-types"

function joinPath(dir: string, rel: string): string {
  return `${dir.replace(/\/+$/, "")}/${rel}`
}

export async function resolveAbsolutePath(ctx: FileLinkContext): Promise<string> {
  if (ctx.source === "local") return ctx.relPath

  if (ctx.source === "thread") {
    if (!ctx.threadId) throw new Error("thread 文件缺少 threadId")
    const dir = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_THREAD_PATH, {
      threadId: ctx.threadId,
      workspaceSlug: ctx.workspaceSlug,
    })
    return joinPath(dir, ctx.relPath)
  }

  // workspace
  if (!ctx.workspaceSlug) throw new Error("workspace 文件缺少 workspaceSlug")
  const dir = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_WORKSPACE_RESOURCES_PATH, {
    workspaceSlug: ctx.workspaceSlug,
  })
  return joinPath(dir, ctx.relPath)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/agent/file-link-actions.ts apps/web/src/components/agent/file-link-actions.test.ts
git commit -m "feat(web): 添加 resolveAbsolutePath 三类来源路径解析"
```

---

## Task 3: Rust copy_file 命令 + native.ts copyFile 封装

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`（新增 `copy_file` 命令 + 注册到 `generate_handler!`）
- Modify: `apps/web/src/lib/desktop-api/native.ts`（新增 `copyFile`）

- [ ] **Step 1: 在 main.rs 新增 copy_file 命令**

在 `apps/desktop/src-tauri/src/main.rs` 中 `reveal_path_in_system` 函数之后（约 `:830` 附近，找 `#[tauri::command]` 块的末尾）新增：

```rust
#[tauri::command]
fn copy_file(source: String, target: String) -> Result<(), String> {
    let src = Path::new(&source);
    if !src.exists() {
        return Err(format!("源文件不存在: {source}"));
    }
    std::fs::copy(&source, &target).map_err(|e| format!("复制失败: {e}"))?;
    Ok(())
}
```

- [ ] **Step 2: 注册到 generate_handler!**

在 `main.rs:1670` 的 `generate_handler![...]` 宏调用列表中，找到 `open_in_system`、`reveal_path_in_system` 所在行，紧随其后新增一行 `copy_file,`（保持与现有命令同列、逗号结尾）。

- [ ] **Step 3: 验证 Rust 编译**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: 编译通过，无 `copy_file` 相关错误

- [ ] **Step 4: 在 native.ts 新增 copyFile 封装**

在 `apps/web/src/lib/desktop-api/native.ts` 的 `writeBinaryFile` 导出之后新增：

```ts
export const copyFile = (source: string, target: string) =>
  invoke<void>('copy_file', { source, target })
```

- [ ] **Step 5: 类型检查并提交**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: native.ts 无新类型错误

```bash
git add apps/desktop/src-tauri/src/main.rs apps/web/src/lib/desktop-api/native.ts
git commit -m "feat(desktop,web): 新增 copy_file 原生命令与 copyFile 封装"
```

> 注：Rust 命令在 CI 单测环境难覆盖，编译通过即视为本任务验证完成；端到端验证见 Task 11 手动清单。

---

## Task 4: resolveFileLinkActions 完整动作层

**Files:**
- Modify: `apps/web/src/components/agent/file-link-actions.ts`（追加 5 个动作）
- Modify: `apps/web/src/components/agent/file-link-actions.test.ts`（追加动作测试）

- [ ] **Step 1: 追加失败测试**

在 `file-link-actions.test.ts` 顶部 mock 块的 `@/lib/desktop-api` mock 中补齐原生 API（替换原 mock）：

```ts
const calls: Array<{ fn: string; args: unknown[] }> = []
let saveDialogResult: string | null = "/target/copied.md"

mock.module("@/lib/desktop-api", () => ({
  sidecarCall: async (method: string, params: unknown) => {
    calls.push({ fn: "sidecarCall", args: [method, params] })
    if (method === "agent:get-thread-path") return "/data/threads/t1"
    if (method === "agent:get-workspace-resources-path") return "/data/ws/resources"
    throw new Error(`unexpected ${method}`)
  },
  openInSystem: async (path: string) => { calls.push({ fn: "openInSystem", args: [path] }) },
  revealPathInSystem: async (path: string) => { calls.push({ fn: "revealPathInSystem", args: [path] }) },
  saveFilePathDialog: async (filename: string) => {
    calls.push({ fn: "saveFilePathDialog", args: [filename] })
    return saveDialogResult
  },
  copyFile: async (source: string, target: string) => {
    calls.push({ fn: "copyFile", args: [source, target] })
  },
}))

const toasts: Array<{ kind: string; text: string }> = []
mock.module("sonner", () => ({
  toast: {
    success: (text: string) => { toasts.push({ kind: "success", text }) },
    error: (text: string) => { toasts.push({ kind: "error", text }) },
  },
}))

let clipboardText = ""
beforeAll(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (t: string) => { clipboardText = t } } },
    configurable: true,
  })
})
```

（在文件顶部 import 加 `beforeAll`：`import { beforeAll, describe, expect, mock, test } from "bun:test"`）

追加测试用例：

```ts
import { resolveFileLinkActions } from "./file-link-actions"

function threadCtx() {
  return { source: "thread" as const, relPath: "plans/research.md", threadId: "t1", workspaceSlug: "ws-1" }
}

describe("resolveFileLinkActions", () => {
  test("openInSystem resolves abs path then calls native", async () => {
    calls.length = 0
    await resolveFileLinkActions(threadCtx()).openInSystem()
    expect(calls.map((c) => c.fn)).toEqual(["sidecarCall", "openInSystem"])
    expect(calls[1].args).toEqual(["/data/threads/t1/plans/research.md"])
  })

  test("revealInFolder calls revealPathInSystem with abs path", async () => {
    calls.length = 0
    await resolveFileLinkActions(threadCtx()).revealInFolder()
    expect(calls.map((c) => c.fn)).toEqual(["sidecarCall", "revealPathInSystem"])
  })

  test("copyRelativePath writes relPath to clipboard", async () => {
    clipboardText = ""
    toasts.length = 0
    await resolveFileLinkActions(threadCtx()).copyRelativePath()
    expect(clipboardText).toBe("plans/research.md")
    expect(toasts[0]).toMatchObject({ kind: "success" })
  })

  test("copyAbsolutePath writes abs path to clipboard", async () => {
    clipboardText = ""
    await resolveFileLinkActions(threadCtx()).copyAbsolutePath()
    expect(clipboardText).toBe("/data/threads/t1/plans/research.md")
  })

  test("saveAs happy path: resolve -> dialog -> copyFile -> success toast", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = "/target/copied.md"
    await resolveFileLinkActions(threadCtx()).saveAs()
    expect(calls.map((c) => c.fn)).toEqual(["sidecarCall", "saveFilePathDialog", "copyFile"])
    expect(calls[2].args).toEqual(["/data/threads/t1/plans/research.md", "/target/copied.md"])
    expect(toasts[0]).toMatchObject({ kind: "success" })
  })

  test("saveAs silent when user cancels dialog", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = null
    await resolveFileLinkActions(threadCtx()).saveAs()
    expect(calls.some((c) => c.fn === "copyFile")).toBe(false)
    expect(toasts).toHaveLength(0)
  })

  test("openInSystem toasts error when resolve fails (missing threadId)", async () => {
    calls.length = 0
    toasts.length = 0
    await resolveFileLinkActions({ source: "thread", relPath: "a.md" }).openInSystem()
    expect(toasts[0]).toMatchObject({ kind: "error" })
    expect(calls.some((c) => c.fn === "openInSystem")).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: FAIL（`resolveFileLinkActions` 未导出）

- [ ] **Step 3: 实现动作层**

在 `file-link-actions.ts` 追加：

```ts
import { openInSystem, revealPathInSystem, saveFilePathDialog, copyFile } from "@/lib/desktop-api"
import { toast } from "sonner"

function basename(p: string): string {
  return p.split("/").pop() ?? p
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface FileLinkActions {
  openInSystem: () => Promise<void>
  revealInFolder: () => Promise<void>
  copyRelativePath: () => Promise<void>
  copyAbsolutePath: () => Promise<void>
  saveAs: () => Promise<void>
}

export function resolveFileLinkActions(ctx: FileLinkContext): FileLinkActions {
  return {
    async openInSystem() {
      try {
        await openInSystem(await resolveAbsolutePath(ctx))
      } catch (e) {
        toast.error(`无法打开：${errMsg(e)}`)
      }
    },
    async revealInFolder() {
      try {
        await revealPathInSystem(await resolveAbsolutePath(ctx))
      } catch (e) {
        toast.error(`无法定位：${errMsg(e)}`)
      }
    },
    async copyRelativePath() {
      try {
        await navigator.clipboard.writeText(ctx.relPath)
        toast.success("已复制相对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
    async copyAbsolutePath() {
      try {
        const abs = await resolveAbsolutePath(ctx)
        await navigator.clipboard.writeText(abs)
        toast.success("已复制绝对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
    async saveAs() {
      try {
        const abs = await resolveAbsolutePath(ctx)
        const target = await saveFilePathDialog(basename(abs))
        if (!target) return // 用户取消，静默
        await copyFile(abs, target)
        toast.success(`已保存到 ${target}`)
      } catch (e) {
        toast.error(`保存失败：${errMsg(e)}`)
      }
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: PASS（resolveAbsolutePath 5 + actions 7 = 12 个测试）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/agent/file-link-actions.ts apps/web/src/components/agent/file-link-actions.test.ts
git commit -m "feat(web): 添加 resolveFileLinkActions 只读六件套动作"
```

---

## Task 5: FileLinkContextMenu 组件 + 菜单项构造纯函数

**Files:**
- Create: `apps/web/src/components/ui/FileLinkContextMenu.tsx`
- Test: `apps/web/src/components/ui/FileLinkContextMenu.test.ts`

- [ ] **Step 1: 写失败测试（纯函数 + 组件 SSR 降级）**

Create `apps/web/src/components/ui/FileLinkContextMenu.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { buildFileLinkMenuItems, FileLinkContextMenu } from "./FileLinkContextMenu"
import type { FileLinkContext } from "@/components/agent/file-link-types"

mock.module("@/lib/desktop-api", () => ({
  sidecarCall: async () => "/dir",
  openInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  saveFilePathDialog: async () => null,
  copyFile: async () => undefined,
}))
mock.module("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }))

const noop = () => undefined

describe("buildFileLinkMenuItems", () => {
  test("thread with preview: 6 actions + 3 separators", () => {
    const ctx: FileLinkContext = { source: "thread", relPath: "a.md", threadId: "t1", workspaceSlug: "ws" }
    const items = buildFileLinkMenuItems(ctx, { hasPreview: true, onPreview: noop })
    const labels = items.filter((i) => i.kind === "item").map((i) => i.label)
    expect(labels).toEqual([
      "在右侧预览",
      "用系统应用打开",
      "在 Finder 中显示",
      "复制相对路径",
      "复制绝对路径",
      "另存为…",
    ])
  })

  test("without preview: omits preview item", () => {
    const ctx: FileLinkContext = { source: "workspace", relPath: "a.md", workspaceSlug: "ws" }
    const items = buildFileLinkMenuItems(ctx, { hasPreview: false })
    const labels = items.filter((i) => i.kind === "item").map((i) => i.label)
    expect(labels).not.toContain("在右侧预览")
    expect(labels[0]).toBe("用系统应用打开")
  })

  test("local source: hides copy relative path", () => {
    const ctx: FileLinkContext = { source: "local", relPath: "/abs/a.md" }
    const items = buildFileLinkMenuItems(ctx, { hasPreview: false })
    const labels = items.filter((i) => i.kind === "item").map((i) => i.label)
    expect(labels).not.toContain("复制相对路径")
    expect(labels).toContain("复制绝对路径")
  })
})

describe("FileLinkContextMenu component", () => {
  test("renders ContextMenu trigger wrapper when context usable", () => {
    const ctx: FileLinkContext = { source: "thread", relPath: "a.md", threadId: "t1", workspaceSlug: "ws" }
    const markup = renderToStaticMarkup(
      <FileLinkContextMenu context={ctx} onPreview={noop}>
        <button type="button">file</button>
      </FileLinkContextMenu>,
    )
    expect(markup).toContain('data-slot="context-menu-trigger"')
  })

  test("degrades to bare children when thread context missing threadId", () => {
    const ctx: FileLinkContext = { source: "thread", relPath: "a.md" }
    const markup = renderToStaticMarkup(
      <FileLinkContextMenu context={ctx}>
        <button type="button">file</button>
      </FileLinkContextMenu>,
    )
    expect(markup).not.toContain('data-slot="context-menu-trigger"')
    expect(markup).toContain("<button")
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/src/components/ui/FileLinkContextMenu.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现组件**

Create `apps/web/src/components/ui/FileLinkContextMenu.tsx`:

```tsx
import { type ReactNode, type ReactElement } from "react"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { resolveFileLinkActions } from "@/components/agent/file-link-actions"
import type { FileLinkContext } from "@/components/agent/file-link-types"

export type FileLinkMenuItem =
  | { kind: "item"; key: string; label: string; onSelect: () => void }
  | { kind: "separator"; key: string }

/** 菜单项构造（纯函数，便于 SSR 测试）。onPreview 缺省时不显示「预览」项。 */
export function buildFileLinkMenuItems(
  ctx: FileLinkContext,
  opts: { hasPreview?: boolean; onPreview?: () => void } = {},
): FileLinkMenuItem[] {
  const actions = resolveFileLinkActions(ctx)
  const items: FileLinkMenuItem[] = []
  let n = 0
  const sep = () => ({ kind: "separator" as const, key: `sep-${n++}` })

  if (opts.hasPreview && opts.onPreview) {
    items.push({ kind: "item", key: "preview", label: "在右侧预览", onSelect: opts.onPreview })
    items.push(sep())
  }
  items.push({ kind: "item", key: "open", label: "用系统应用打开", onSelect: actions.openInSystem })
  items.push({ kind: "item", key: "reveal", label: "在 Finder 中显示", onSelect: actions.revealInFolder })
  items.push(sep())
  if (ctx.source !== "local") {
    items.push({ kind: "item", key: "copy-rel", label: "复制相对路径", onSelect: actions.copyRelativePath })
  }
  items.push({ kind: "item", key: "copy-abs", label: "复制绝对路径", onSelect: actions.copyAbsolutePath })
  items.push(sep())
  items.push({ kind: "item", key: "save-as", label: "另存为…", onSelect: actions.saveAs })
  return items
}

function isContextUsable(ctx: FileLinkContext): boolean {
  if (ctx.source === "thread") return Boolean(ctx.threadId)
  if (ctx.source === "workspace") return Boolean(ctx.workspaceSlug)
  return true // local
}

interface FileLinkContextMenuProps {
  context: FileLinkContext
  onPreview?: () => void
  children: ReactElement
}

export function FileLinkContextMenu({ context, onPreview, children }: FileLinkContextMenuProps) {
  if (!isContextUsable(context)) return <>{children}</>

  const items = buildFileLinkMenuItems(context, {
    hasPreview: Boolean(onPreview),
    onPreview,
  })

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span style={{ display: "contents" }} />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {items.map((item) =>
          item.kind === "separator" ? (
            <ContextMenuSeparator key={item.key} />
          ) : (
            <ContextMenuItem key={item.key} onSelect={item.onSelect}>
              {item.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/src/components/ui/FileLinkContextMenu.test.ts`
Expected: PASS（buildFileLinkMenuItems 3 + 组件 2 = 5 个测试）

- [ ] **Step 5: 类型检查并提交**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误

```bash
git add apps/web/src/components/ui/FileLinkContextMenu.tsx apps/web/src/components/ui/FileLinkContextMenu.test.ts
git commit -m "feat(web): 添加 FileLinkContextMenu 共享组件与菜单项构造"
```

---

## Task 6: AgentView 提供 ThreadFileEnvProvider

**Files:**
- Modify: `apps/web/src/components/agent/AgentView.tsx`

- [ ] **Step 1: 包裹 Provider**

在 `AgentView.tsx` 的 import 区追加：

```tsx
import { ThreadFileEnvProvider } from './thread-file-env'
```

找到 `AgentView` return 的最外层 JSX（包裹 `AgentMessages` 等的根元素）。在 `AgentMessages` 所在的容器内，用 `<ThreadFileEnvProvider value={{ threadId, workspaceSlug }}>` 包裹整个消息流区域（`AgentMessages` + 输入区相关）。`threadId` 是 props，`workspaceSlug` 是 `:51-55` 的 useMemo 变量，两者在作用域内可用。

示例（以实际 JSX 结构为准，定位到 return 语句的根容器内层）：

```tsx
<ThreadFileEnvProvider value={{ threadId, workspaceSlug }}>
  {/* 原有 AgentMessages / 输入区 / 横幅等 */}
</ThreadFileEnvProvider>
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误

- [ ] **Step 3: 回归测试**

Run: `bun test apps/web/src/components/agent`
Expected: 现有测试全绿（Provider 包裹不改变子树渲染输出）

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/agent/AgentView.tsx
git commit -m "feat(web): AgentView 提供 ThreadFileEnvProvider"
```

---

## Task 7: 对话流胶囊接线（MarkdownCode）

**Files:**
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`（`MarkdownCode` 组件 `:949-990`）
- Test: 既有 `RuntimeEventContentBlock.markdown-file-link.test.tsx` 必须继续通过

- [ ] **Step 1: 先确认回归基线**

Run: `bun test apps/web/src/components/agent/RuntimeEventContentBlock.markdown-file-link.test.tsx`
Expected: PASS（4 个测试，建立基线）

- [ ] **Step 2: 改造 MarkdownCode 包菜单**

在 `RuntimeEventContentBlock.tsx` import 区追加：

```tsx
import { useThreadFileEnv } from './thread-file-env'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
```

修改 `MarkdownCode`（`:949` 起）。在 `filePath && onOpenThreadFile` 分支内，把返回的 `<button>` 用 `FileLinkContextMenu` 包裹。`useThreadFileEnv` 必须在组件顶层调用（不能在 if 内），所以提取到函数体顶部：

```tsx
export function MarkdownCode({
  children,
  block,
  lang: _lang,
  domNode: _domNode,
  streamStatus: _streamStatus,
  onOpenThreadFile,
  ...rest
}: MarkdownCodeProps & { onOpenThreadFile?: (path: string) => void }) {
  const env = useThreadFileEnv()
  const text = flattenText(children)
  const filePath = !block ? normalizeThreadFilePathCandidate(text) : null

  if (filePath && onOpenThreadFile) {
    const button = (
      <button
        type="button"
        data-thread-file-link="true"
        data-file-link-highlight="true"
        aria-label={`在右侧预览文件 ${filePath}`}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpenThreadFile(filePath)
        }}
        className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border border-[#d9d2ff] bg-[#f4f1ff] px-1.5 py-0.5 align-baseline font-mono text-[0.92em] font-medium text-[#4f46e5] shadow-[0_1px_0_rgba(103,92,255,0.12)] transition-colors hover:border-[#b9afff] hover:bg-[#edeaff] hover:text-[#4338ca] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#675cff]/35"
        title="在右侧预览文件"
      >
        <span aria-hidden="true" data-file-link-icon="true" className="inline-flex shrink-0 items-center">
          <FileTypeIcon filename={filePath} size={13} />
        </span>
        <span className="truncate">{children}</span>
      </button>
    )
    return (
      <FileLinkContextMenu
        context={{ source: "thread", relPath: filePath, threadId: env.threadId, workspaceSlug: env.workspaceSlug }}
        onPreview={() => onOpenThreadFile(filePath)}
      >
        {button}
      </FileLinkContextMenu>
    )
  }

  const codeProps = normalizeMarkdownCodeProps(rest as Record<string, unknown>) as HTMLAttributes<HTMLElement>
  return <code {...codeProps}>{children}</code>
}
```

- [ ] **Step 3: 运行既有测试确认不回归**

Run: `bun test apps/web/src/components/agent/RuntimeEventContentBlock.markdown-file-link.test.tsx`
Expected: PASS（4 个测试仍通过——`data-thread-file-link` 等属性仍在；SSR 下 `FileLinkContextMenu` 因无 Provider 提供 threadId 会降级渲染 bare button，`renderFileLink` 仍产出含 `data-thread-file-link` 的 button）

> 若测试因 Provider 缺失导致降级而失败：测试文件里 `renderFileLink` 已 mock `@/lib/desktop-api`，Context 默认值 `{}` 使 `env.threadId` 为 undefined → `isContextUsable` 返回 false → 降级渲染 bare button，符合既有断言。如断言依赖 `data-slot="context-menu"`，则不通过——但既有断言只查 `data-thread-file-link`，故安全。

- [ ] **Step 4: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/agent/RuntimeEventContentBlock.tsx
git commit -m "feat(web): 对话流文件链接胶囊接入右键菜单"
```

---

## Task 8: 附件卡片接线（AgentAttachmentGrid）

**Files:**
- Modify: `apps/web/src/components/agent/AgentAttachmentGrid.tsx`（`:60-106` 附件项 button）
- Test: 新增 `apps/web/src/components/agent/AgentAttachmentGrid.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/components/agent/AgentAttachmentGrid.test.tsx`:

```tsx
import { describe, expect, mock, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentAttachmentGrid, type AgentAttachmentGridItem } from "./AgentAttachmentGrid"
import { ThreadFileEnvProvider } from "./thread-file-env"

mock.module("@/lib/desktop-api", () => ({
  sidecarCall: async () => "/dir",
  openInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  saveFilePathDialog: async () => null,
  copyFile: async () => undefined,
}))
mock.module("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }))

describe("AgentAttachmentGrid context menu", () => {
  test("wraps attachment with threadPath in FileLinkContextMenu", () => {
    const items: AgentAttachmentGridItem[] = [
      { id: "1", filename: "report.pdf", mediaType: "application/pdf", size: 10, threadPath: "files/report.pdf" },
    ]
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: "t1", workspaceSlug: "ws" }}>
        <AgentAttachmentGrid attachments={items} onOpenFile={() => undefined} />
      </ThreadFileEnvProvider>,
    )
    expect(markup).toContain('data-slot="context-menu-trigger"')
  })

  test("does not wrap attachment without threadPath (pending/local)", () => {
    const items: AgentAttachmentGridItem[] = [
      { id: "1", filename: "pending.png", mediaType: "image/png", size: 10 },
    ]
    const markup = renderToStaticMarkup(
      <AgentAttachmentGrid attachments={items} onOpenImage={() => undefined} />,
    )
    expect(markup).not.toContain('data-slot="context-menu-trigger"')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/src/components/agent/AgentAttachmentGrid.test.tsx`
Expected: FAIL（未接入 ContextMenu）

- [ ] **Step 3: 接入 FileLinkContextMenu**

在 `AgentAttachmentGrid.tsx` import 区追加：

```tsx
import { useThreadFileEnv } from './thread-file-env'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
```

`AgentAttachmentGrid` 是函数组件，在组件函数体顶部（`if (attachments.length === 0) return null` 之前）取 env：

```tsx
const env = useThreadFileEnv()
```

在 `attachments.map` 内，把现有的 `<div ...><button>...</button>{removable && ...}</div>` 结构用条件包裹：当 `attachment.threadPath && env.threadId` 时，外层包 `FileLinkContextMenu`。修改 button 的容器 div：

```tsx
const attachNode = (
  <div
    key={attachment.id}
    data-agent-attachment-kind={image ? 'image' : 'file'}
    className={cn('group/attachment relative min-w-0', image ? 'h-[108px] w-[108px]' : 'h-[108px] w-[250px] max-w-full')}
  >
    {/* 原 button 不变 */}
    <button type="button" onClick={...} ...>...</button>
    {removable && (<button ...>...</button>)}
  </div>
)

const canMenu = Boolean(attachment.threadPath) && Boolean(env.threadId)
return canMenu ? (
  <FileLinkContextMenu
    key={attachment.id}
    context={{ source: 'thread', relPath: attachment.threadPath!, threadId: env.threadId, workspaceSlug: env.workspaceSlug }}
    onPreview={() => (image ? onOpenImage?.(attachment) : onOpenFile?.(attachment))}
  >
    {attachNode}
  </FileLinkContextMenu>
) : attachNode
```

（`map` 回调改为显式 `return`，把原 JSX 赋给 `attachNode` 再决定是否包裹。`threadPath!` 非空断言已由 `canMenu` 守卫。）

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/src/components/agent/AgentAttachmentGrid.test.tsx`
Expected: PASS（2 个测试）

- [ ] **Step 5: 类型检查并提交**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误

```bash
git add apps/web/src/components/agent/AgentAttachmentGrid.tsx apps/web/src/components/agent/AgentAttachmentGrid.test.tsx
git commit -m "feat(web): 消息附件卡片接入右键菜单"
```

> 注：`AgentAttachmentGrid` 也用于 `AgentInput` 的 pending 附件——pending 附件无 `threadPath`，`canMenu` 为 false，不会被挂菜单，符合预期（见 spec 待核实点 6）。

---

## Task 9: 右侧文件树接线（WorkspaceFileBrowser）

**Files:**
- Modify: `apps/web/src/components/file-browser/WorkspaceFileBrowser.tsx`

- [ ] **Step 1: 先读文件确认数据来源**

Run: 读 `WorkspaceFileBrowser.tsx`，确认：
1. 文件树项组件（`WorkspaceFileTreeItem` 或类似）的渲染位置（探索提到 `:142` 有 `onOpenFile`）
2. 每个 file 的 path 字段名（`file.path`）
3. `workspaceSlug` 的来源（props / context / store）

记录结论后再编写实现。若 `workspaceSlug` 不在该组件作用域，向上追溯 props 链或从 `currentWorkspaceIdAtom`+`agentWorkspacesAtom` 推导（参照 `AgentView.tsx:51-55` 模式）。

- [ ] **Step 2: 接入 FileLinkContextMenu**

import 追加：

```tsx
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
```

在文件树项的渲染处（`:142` 附近的 `onOpenFile` 触发元素），用 `FileLinkContextMenu` 包裹该项：

```tsx
<FileLinkContextMenu
  context={{ source: 'workspace', relPath: file.path, workspaceSlug }}
  onPreview={() => onOpenFile(file)}
>
  {/* 原文件树项元素（div/row） */}
</FileLinkContextMenu>
```

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误（若 `workspaceSlug` 来源需补 props/推导，确保类型对齐）

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/file-browser/WorkspaceFileBrowser.tsx
git commit -m "feat(web): 工作区文件树项接入右键菜单"
```

> 注：本任务无单测——文件树项交互依赖完整 workspace context，SSR 难以构造。验证靠 Task 11 手动清单 + 类型检查。

---

## Task 10: 文件预览区接线（FilePreviewTabView）+ 复制路径迁移

**Files:**
- Modify: `apps/web/src/components/tabs/FilePreviewTabView.tsx`

- [ ] **Step 1: 先读文件确认 fileSource 枚举**

Run: 读 `FilePreviewTabView.tsx`，确认：
1. `tab.fileSource` 的类型与取值（预期 `'thread' | 'workspace' | 'local'`，若不同需补归一化映射——见 spec 待核实点 5）
2. 当前文件 path / threadId / workspaceSlug 在该组件的取值方式
3. `:191-213` 自绘下拉菜单中"复制路径"项的实现（待移除）

记录结论。

- [ ] **Step 2: 接入 FileLinkContextMenu + 移除下拉"复制路径"**

import 追加：

```tsx
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import type { FileLinkSource } from '@/components/agent/file-link-types'
```

构造 context（按 fileSource 映射，若枚举已对齐则直接用）：

```tsx
const source: FileLinkSource = tab.fileSource  // 若枚举不一致，此处做归一化映射
const fileCtx = { source, relPath: currentPath, threadId, workspaceSlug }
```

在预览区标题/内容区根元素外包 `FileLinkContextMenu`（不传 `onPreview`——已在预览，隐藏"预览"项）：

```tsx
<FileLinkContextMenu context={fileCtx}>
  {/* 原标题区/内容区根元素 */}
</FileLinkContextMenu>
```

从 `:191-213` 自绘下拉菜单中**移除"复制路径"项**（已由右键菜单的"复制相对路径/复制绝对路径"替代）；保留"切换增强视图"项。

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/tabs/FilePreviewTabView.tsx
git commit -m "feat(web): 文件预览区接入右键菜单并迁移复制路径"
```

> 注：本任务无单测，验证靠 Task 11 手动清单 + 类型检查。

---

## Task 11: 全量回归 + 手动验证清单

**Files:** 无（验证任务）

- [ ] **Step 1: 全量类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无本次引入的类型错误（既有无关错误除外）

- [ ] **Step 2: 全量测试**

Run: `bun test apps/web/src/components/agent apps/web/src/components/ui/FileLinkContextMenu.test.ts`
Expected: 全绿（含本次新增 5 个测试文件 + 既有 `markdown-file-link.test.tsx` 回归）

- [ ] **Step 3: Rust 编译**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: 通过

- [ ] **Step 4: 桌面端启动手动验证**

Run: `bun tauri dev`

按以下矩阵验证（每处右键应弹出统一菜单）：

| 位置 | 验证动作 |
|------|---------|
| 对话流胶囊（`src/App.tsx` 形） | 右键 → 菜单出现；单击仍触发右侧预览（回归） |
| 消息附件卡片（PDF/图片） | 右键 → 菜单出现；pending 附件无菜单 |
| 右侧文件树项 | 右键 → 菜单出现，"复制相对路径"可见 |
| 文件预览区 | 右键 → 菜单出现，**无"预览"项**；下拉"复制路径"已移除 |
| local 来源（本地打开文件） | "复制相对路径"**隐藏**，"复制绝对路径"可用 |
| 另存为 | 选目标 → 成功 toast；取消对话框 → 静默 |
| 系统打开 / Finder 显示 | 用系统应用打开 / 在 Finder 选中 |
| 路径解析失败（删除 thread） | error toast，无后续动作 |

- [ ] **Step 5: 最终提交（如有手动验证发现的小修）**

```bash
git add -A
git commit -m "test: 文件链接右键菜单全量回归通过"
```

---

## Self-Review 结论

**Spec 覆盖**：spec §2 四类挂载点 → Task 7/8/9/10；§5.1 三文件抽象 → Task 1/4/5；§5.2 透传 Context → Task 6；§5.3 数据流与 IPC（含 copy_file 缺口）→ Task 2/3/4；§5.4 错误处理 → Task 4 动作层；§5.5 测试 → Task 1/2/4/5/8 测试 + Task 7 回归 + Task 11 手动。全覆盖。

**占位符**：无 TBD/TODO；Task 9/10 含「先读文件确认」步骤，因依赖运行时数据来源，属必要的前置核实而非占位。

**类型一致**：`FileLinkContext`（Task 1）→ `resolveAbsolutePath`/`resolveFileLinkActions`（Task 2/4）→ `buildFileLinkMenuItems`/`FileLinkContextMenu`（Task 5）→ 四处接线（Task 7-10）的 `source`/`relPath`/`threadId`/`workspaceSlug` 字段名全程一致；`copyFile`/`copy_file` 命名一致。
