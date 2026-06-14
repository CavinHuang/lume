# 文件链接右键菜单——全 Rust 能力补齐 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让文件链接右键菜单的 6 个动作全部走 Rust 原生命令：把「复制相对路径 / 复制绝对路径」从 `navigator.clipboard` 迁到新增 Rust `write_clipboard_text` 命令，并修复「另存为」对话框被默认 SVG 过滤的 bug（按源文件扩展名推导 filter）。

**Architecture:** 新增 Rust `write_clipboard_text` 命令（镜像既有 `read_clipboard_text` 的 `pbcopy`/`Set-Clipboard`/`wl-copy` shell 模式，经 stdin 管道写入），web 侧加 `writeClipboardText` 封装；动作层 `file-link-actions.ts` 的两个复制动作改用该封装、`saveAs` 用纯函数 `buildSaveAsFilter` 按扩展名构造 filter 传给既有 `save_file_path_dialog`（Rust 端 `Some([])` 不触发 SVG 默认，故无需改 Rust）。预览/系统打开/Finder 显示三项本就 Rust，不动。

**Tech Stack:** Rust + Tauri 2（`std::process::Command` + `Stdio`/`Write`，已在 `main.rs:4/6` 导入）+ React + TypeScript + bun:test（web 测试，SSR 风格）。

**Scope（用户已确认）：** 仅补齐现有 6 项为全 Rust；不新增菜单项、不改菜单 UI、不改 Rust 的 SVG 默认过滤。

**测试约定（web 侧）**：`bun:test`，单文件 `bun test apps/web/src/components/agent/file-link-actions.test.ts`。类型检查 `cd apps/web && bunx tsc --noEmit`。Rust 验证 `cd apps/desktop/src-tauri && cargo check`（命令在 CI 难单测，编译通过即验证，端到端见 Task 5）。

---

## 文件结构

**修改（Rust）**
- `apps/desktop/src-tauri/src/main.rs` — 新增 `write_clipboard_text` 命令 + `write_system_clipboard_text` + `command_write_stdin` helper，并注册到 `generate_handler!`

**修改（web）**
- `apps/web/src/lib/desktop-api/native.ts` — 新增 `writeClipboardText` 封装
- `apps/web/src/components/agent/file-link-actions.ts` — 复制动作改用 `writeClipboardText`；`saveAs` 调 `buildSaveAsFilter`
- `apps/web/src/components/agent/file-link-actions.test.ts` — mock 改 `writeClipboardText`、saveAs 断言 filter

**不改**
- `ReadingView.tsx`（已自带 filter）、`FileLinkContextMenu.tsx` 及其测试、`AgentAttachmentGrid`/`markdown-file-link` 测试（不调用动作，mock 无需改）

---

## Task 1: Rust `write_clipboard_text` 命令 + helper + 注册

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`（`read_clipboard_text` 之后 `:553`；`command_output_text` 之后 `:707`；`generate_handler!` 中 `read_clipboard_text,` 之后 `:1690`）

- [ ] **Step 1: 新增 `write_clipboard_text` 命令**

在 `apps/desktop/src-tauri/src/main.rs` 的 `read_clipboard_text` 函数之后（当前文件 `:553` 之后，`// ── Logging commands ──` 注释之前）新增：

```rust
#[tauri::command]
fn write_clipboard_text(text: String) -> Result<(), String> {
    write_system_clipboard_text(&text)
}
```

- [ ] **Step 2: 新增 `write_system_clipboard_text` + `command_write_stdin` helper**

在 `command_output_text` 函数之后（当前文件 `:707` 之后，`save_text_file_dialog` 之前）新增。`Write`（`main.rs:4`）与 `Stdio`（`main.rs:6`）已导入，无需补 `use`：

```rust
fn write_system_clipboard_text(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return command_write_stdin("pbcopy", &[], text);
    }

    #[cfg(target_os = "windows")]
    {
        return command_write_stdin(
            "powershell",
            &["-NoProfile", "-Command", "$input | Set-Clipboard"],
            text,
        );
    }

    #[cfg(target_os = "linux")]
    {
        return command_write_stdin("wl-copy", &[], text)
            .or_else(|_| command_write_stdin("xclip", &["-selection", "clipboard"], text))
            .or_else(|_| command_write_stdin("xsel", &["--clipboard", "--input"], text));
    }

    #[allow(unreachable_code)]
    Err("clipboard is not supported on this platform".to_string())
}

fn command_write_stdin(program: &str, args: &[&str], input: &str) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("write clipboard failed: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("write clipboard failed: {e}"))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("write clipboard failed: {e}"))?;
    if !status.success() {
        return Err("write clipboard failed".to_string());
    }
    Ok(())
}
```

- [ ] **Step 3: 注册到 `generate_handler!`**

在 `apps/desktop/src-tauri/src/main.rs` 的 `generate_handler![...]`（当前 `:1680-1701`）中，找到 `read_clipboard_text,` 所在行（`:1690`），紧随其后新增一行 `write_clipboard_text,`（与现有命令同列、逗号结尾）。

- [ ] **Step 4: 验证 Rust 编译**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: 编译通过，无 `write_clipboard_text` / `command_write_stdin` / `write_system_clipboard_text` 相关错误或 unused 警告。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "feat(desktop): 新增 write_clipboard_text 原生命令"
```

> 注：Rust 命令在 CI 单测环境难覆盖，编译通过即视为本任务验证完成；端到端验证见 Task 5。

---

## Task 2: `native.ts` 新增 `writeClipboardText` 封装

**Files:**
- Modify: `apps/web/src/lib/desktop-api/native.ts`（`revealPathInSystem` 之后 `:48`）

- [ ] **Step 1: 新增封装**

在 `apps/web/src/lib/desktop-api/native.ts` 的 `revealPathInSystem` 导出之后（当前 `:47-48` 之后，`localFilePreviewUrl` 之前）新增：

```ts
export const writeClipboardText = (text: string) =>
  invoke<void>('write_clipboard_text', { text })
```

- [ ] **Step 2: 类型检查并提交**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: native.ts 无新类型错误

```bash
git add apps/web/src/lib/desktop-api/native.ts
git commit -m "feat(web): 新增 writeClipboardText 封装"
```

---

## Task 3: 复制动作迁移到 Rust 剪贴板（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/file-link-actions.test.ts`（先改测试，建立失败基线）
- Modify: `apps/web/src/components/agent/file-link-actions.ts`（`copyRelativePath`/`copyAbsolutePath`）

- [ ] **Step 1: 改测试——mock `writeClipboardText`、删除 `navigator` mock、断言改 Rust 封装**

打开 `apps/web/src/components/agent/file-link-actions.test.ts`，做三处改动：

(1) 顶部 import 去掉 `beforeAll`（迁移后不再需要）：

```ts
import { describe, expect, mock, test } from "bun:test"
```

(2) `@/lib/desktop-api` 的 mock 内，`copyFile` 之后新增 `writeClipboardText`：

```ts
  copyFile: async (source: string, target: string) => {
    calls.push({ fn: "copyFile", args: [source, target] })
  },
  writeClipboardText: async (text: string) => {
    calls.push({ fn: "writeClipboardText", args: [text] })
  },
```

(3) 删除整个 navigator mock 块与 `clipboardText` 变量（原 `let clipboardText = ""` 到 `beforeAll(() => { Object.defineProperty(...) })`，约 `:39-45`），一并删除。

(4) 把两个复制测试的断言从 `clipboardText` 改为查 `calls`：

```ts
  test("copyRelativePath writes relPath via Rust clipboard", async () => {
    calls.length = 0
    toasts.length = 0
    await resolveFileLinkActions(threadCtx()).copyRelativePath()
    expect(
      calls.some((c) => c.fn === "writeClipboardText" && c.args[0] === "plans/research.md"),
    ).toBe(true)
    expect(toasts[0]).toMatchObject({ kind: "success" })
  })

  test("copyAbsolutePath writes abs path via Rust clipboard", async () => {
    calls.length = 0
    await resolveFileLinkActions(threadCtx()).copyAbsolutePath()
    expect(
      calls.some(
        (c) => c.fn === "writeClipboardText" && c.args[0] === "/data/threads/t1/plans/research.md",
      ),
    ).toBe(true)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: FAIL（两个复制测试——当前动作实现走 `navigator.clipboard`，mock 里已无 `writeClipboardText` 调用产生；且原 `clipboardText` 已删除导致引用错误）

- [ ] **Step 3: 迁移动作到 `writeClipboardText`**

打开 `apps/web/src/components/agent/file-link-actions.ts`。

(1) import 行（`:3`）加入 `writeClipboardText`：

```ts
import { openInSystem, revealPathInSystem, saveFilePathDialog, copyFile, writeClipboardText, sidecarCall } from "@/lib/desktop-api"
```

(2) `copyRelativePath`（约 `:62-69`）改为：

```ts
    async copyRelativePath() {
      try {
        await writeClipboardText(ctx.relPath)
        toast.success("已复制相对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
```

(3) `copyAbsolutePath`（约 `:70-78`）改为：

```ts
    async copyAbsolutePath() {
      try {
        const abs = await resolveAbsolutePath(ctx)
        await writeClipboardText(abs)
        toast.success("已复制绝对路径")
      } catch (e) {
        toast.error(`复制失败：${errMsg(e)}`)
      }
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: PASS（`resolveAbsolutePath` 4 + `resolveFileLinkActions` 7 = 11 个测试全绿，含两个迁移后的复制测试）

- [ ] **Step 5: 类型检查并提交**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误

```bash
git add apps/web/src/components/agent/file-link-actions.ts apps/web/src/components/agent/file-link-actions.test.ts
git commit -m "refactor(web): 复制路径动作改用 Rust write_clipboard_text"
```

---

## Task 4: 修复「另存为」SVG 过滤 bug——按扩展名推导 filter（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/file-link-actions.test.ts`（saveAs mock 与断言）
- Modify: `apps/web/src/components/agent/file-link-actions.ts`（新增 `buildSaveAsFilter`，`saveAs` 传 filter）

- [ ] **Step 1: 改测试——saveAs mock 接收 filters，断言 filter 内容**

打开 `apps/web/src/components/agent/file-link-actions.test.ts`：

(1) `saveFilePathDialog` mock 改为接收并记录 `filters`（替换原 `(filename: string)` 版本）：

```ts
  saveFilePathDialog: async (filename: string, filters?: unknown) => {
    calls.push({ fn: "saveFilePathDialog", args: [filename, filters] })
    return { path: saveDialogResult }
  },
```

(2) 在 `saveAs silent when user cancels dialog` 测试之后，新增两个测试：

```ts
  test("saveAs derives md filter from source extension", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = "/target/copied.md"
    await resolveFileLinkActions(threadCtx()).saveAs()
    const dialogCall = calls.find((c) => c.fn === "saveFilePathDialog")!
    expect(dialogCall.args[0]).toBe("research.md")
    expect(dialogCall.args[1]).toEqual([{ name: "md", extensions: ["md"] }])
  })

  test("saveAs passes empty filter (no restriction) for extensionless file", async () => {
    calls.length = 0
    toasts.length = 0
    saveDialogResult = "/target/NOTES"
    await resolveFileLinkActions({ source: "thread", relPath: "NOTES", threadId: "t1", workspaceSlug: "ws-1" }).saveAs()
    const dialogCall = calls.find((c) => c.fn === "saveFilePathDialog")!
    expect(dialogCall.args[1]).toEqual([])
  })
```

(3) 已有 happy-path 测试（`saveAs happy path: resolve -> dialog -> copyFile -> success toast`）的 `calls.map` 断言不变；它只校验调用顺序，filter 改动不影响。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: FAIL（两个新增 saveAs 测试——当前 `saveAs` 不传 filter，`dialogCall.args[1]` 为 `undefined`）

- [ ] **Step 3: 实现 `buildSaveAsFilter` + `saveAs` 传 filter**

打开 `apps/web/src/components/agent/file-link-actions.ts`。

(1) import 行加入 `SaveFilePathFilter` 类型：

```ts
import { openInSystem, revealPathInSystem, saveFilePathDialog, copyFile, writeClipboardText, sidecarCall, type SaveFilePathFilter } from "@/lib/desktop-api"
```

(2) 在 `basename` helper 附近新增纯函数：

```ts
/** 按源文件扩展名构造保存对话框 filter；无扩展名返回空数组（Rust 端 Some([]) 不触发 SVG 默认过滤）。 */
function buildSaveAsFilter(absPath: string): SaveFilePathFilter[] {
  const base = basename(absPath)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return [] // 无点（"NOTES"）或以点开头（".gitignore"）→ 不限制
  const ext = base.slice(dot + 1).toLowerCase()
  if (!ext) return []
  return [{ name: ext, extensions: [ext] }]
}
```

(3) `saveAs`（约 `:79-89`）改为传 filter：

```ts
    async saveAs() {
      try {
        const abs = await resolveAbsolutePath(ctx)
        const { path: target } = await saveFilePathDialog(basename(abs), buildSaveAsFilter(abs))
        if (!target) return // 用户取消，静默
        await copyFile(abs, target)
        toast.success(`已保存到 ${target}`)
      } catch (e) {
        toast.error(`保存失败：${errMsg(e)}`)
      }
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts`
Expected: PASS（原 11 + 新增 2 = 13 个测试全绿）

- [ ] **Step 5: 类型检查并提交**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无新类型错误（`SaveFilePathFilter` 经 `@/lib/desktop-api` 的 `export * from './native'` 可用）

```bash
git add apps/web/src/components/agent/file-link-actions.ts apps/web/src/components/agent/file-link-actions.test.ts
git commit -m "fix(web): 另存为按源扩展名推导过滤，修复 SVG 默认过滤 bug"
```

---

## Task 5: 全量回归 + 桌面端手动验证

**Files:** 无（验证任务）

- [ ] **Step 1: 全量类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无本次引入的类型错误（既有无关错误除外）

- [ ] **Step 2: web 全量测试（动作层 + 菜单相关）**

Run: `bun test apps/web/src/components/agent/file-link-actions.test.ts apps/web/src/components/ui/FileLinkContextMenu.test.tsx apps/web/src/components/agent/AgentAttachmentGrid.test.tsx apps/web/src/components/agent/RuntimeEventContentBlock.markdown-file-link.test.tsx`
Expected: 全绿（动作层 13 + 其余既有测试不回归）

- [ ] **Step 3: Rust 编译**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: 通过，无 unused 警告

- [ ] **Step 4: 桌面端启动手动验证**

Run: `bun tauri dev`

按以下矩阵验证（在消息流胶囊 / 附件卡片 / 右侧文件树（线程 + 工作区两个 tab）/ 文件预览区任一处右键触发菜单）：

| 动作 | 验证要点 |
|------|---------|
| 复制相对路径 | 点后在系统粘贴得 thread/workspace 相对路径；**不再走 navigator.clipboard**（失败时弹 error toast） |
| 复制绝对路径 | 粘贴得完整绝对路径（如 `<configDir>/agent-workspaces/<slug>/threads/<id>/...`） |
| 另存为（.md/.pdf 等有扩展名） | 保存对话框 filter 与扩展名一致（不再是 SVG）；选目标后成功 toast + 文件被复制 |
| 另存为（无扩展名文件，如 `Makefile`/`NOTES`） | 保存对话框无过滤限制（显示所有文件） |
| 另存为 取消 | 对话框取消 → 静默，无 toast、无复制 |
| 用系统应用打开 | 系统默认应用打开该文件（回归，未改动） |
| 在 Finder 中显示 | Finder 选中该文件（回归，未改动） |
| 在右侧预览 | 右侧打开预览（回归，未改动） |
| local 来源 | 「复制相对路径」隐藏；「复制绝对路径」走 local 绝对路径 |

- [ ] **Step 5: 最终提交（如有手动验证发现的小修）**

```bash
git add -A
git commit -m "test: 文件链接右键菜单全 Rust 能力回归通过"
```

---

## Self-Review 结论

**Spec 覆盖**：用户确认范围「补齐现有 6 项为全 Rust」→
- 复制相对/绝对路径迁移 Rust → Task 1（命令）+ Task 2（封装）+ Task 3（动作迁移）
- 另存为 SVG 过滤 bug → Task 4
- 预览/系统打开/Finder 显示三项本就 Rust（`main.rs:753/783` + React 回调），不动
- 全量回归 + 手动 → Task 5
全覆盖，无遗漏。

**占位符**：无 TBD/TODO；每步均给出完整代码与精确命令。

**类型一致**：`write_clipboard_text`（Rust）↔ `writeClipboardText`（web 封装 `native.ts`）↔ 动作层调用全程命名一致；`buildSaveAsFilter` 返回 `SaveFilePathFilter[]`（`native.ts:13-16`），与 `saveFilePathDialog(filename, filters?)`（`native.ts:39-40`）签名一致；`copy_file`/`copyFile` 命名沿用既有，未变。

**Rust 不改 SVG 默认**：`save_file_path_dialog` 的 SVG 默认仅 `filters: None` 时触发；Task 4 让 web 侧始终传显式 filter（有扩展名 `[{...}]` / 无扩展名 `[]` → Rust 收到 `Some(...)` 不触发默认），故 `ReadingView.tsx:365`（自带 filter）与其它 None 场景行为不变，符合 surgical 原则。
