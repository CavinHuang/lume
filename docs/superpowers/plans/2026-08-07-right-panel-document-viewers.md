# 右侧面板文档预览增强（Extend UI 集成）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Extend UI 的 PDF/DOCX/XLSX/PPTX/CSV 查看器接入右侧面板文件预览，替换 PDF 原生 `<object>`、补齐 Office/CSV 支持。

**Architecture:** 抽象 `DocumentViewerHost`（统一接入层：文件源 `lume-file://` scope、按 `kind` 懒加载、loading/error 占位）+ 5 个薄渲染器。接入点仅 2 处：`classifyFilePreview` 分类扩展 + `RightPanelFilePreview` 条件链路由。

**Tech Stack:** React + TypeScript + Tailwind（shadcn token）+ Electron；Extend UI（`@extend/*` shadcn registry + `@extend-ai/react-*` npm）+ `react-pdf`；测试 `bun:test`。

**关联 spec:** `docs/superpowers/specs/2026-08-07-right-panel-document-viewers-design.md`
**PR:** #33（分支 `worktree-feature+right-panel-doc-viewers`）

## Global Constraints

- **测试运行器**: `bun:test`（非 vitest）。组件测试参考 `apps/web/src/components/agent/AgentView.test.tsx` 的 fake DOM 模式。
- **包管理器**: `bun`（`bun install`、`bunx`）。新 worktree 首次操作前必须先 `bun install`。
- **提交规范**: commit message 用 emoji 前缀（如 `✨ feat:`、 `🐛 fix:`、 `📝 docs:`）。
- **分支纪律**: 所有改动只在本 worktree 分支 `worktree-feature+right-panel-doc-viewers`，禁止改 `main`。
- **bundle 纪律**: 所有文档查看器库必须懒加载（`React.lazy`），不得进主 bundle。
- **primitive 路径**: Lume `@/components/ui/{button,select,scroll-area,tooltip,dialog,...}` 已存在且与 Extend UI 默认 import 对齐；**select 存在 `select.tsx`（base-ui）与 `shadcn-select.tsx` 两份**，注意 `@/components/ui/select` 解析到 base-ui 版，其 `SelectValue` 无 children 时显示原始 value（见 [[reference_baseui-select-value]]）。
- **文件源**: 文档二进制一律走现有 `createFilePreviewScope({ref,kind:'media-file',generation})` → `mediaScope.url`（`lume-file://` 协议），不新造通道。

---

## File Structure

**新建**（均在 `apps/web/src/components/right-panel/document-viewer/`）：
- `DocumentViewerHost.tsx` — 统一接入层。props: `{ kind, fileRef, guardedRef, mediaScope, onOpenFile }`。按 `kind` 懒加载渲染器，统一 Suspense/error 占位。
- `document-viewer-kinds.ts` — 纯函数与常量：`DOCUMENT_VIEWER_KINDS` 集合、`isDocumentViewerKind(kind)`、`kindToViewer` 映射。可独立单测。
- `viewers/PdfViewer.tsx` / `DocxViewer.tsx` / `XlsxViewer.tsx` / `PptxViewer.tsx` / `CsvViewer.tsx` — 各自薄包装 shadcn add 进来的 Extend UI 组件，接 `src`。

**修改**：
- `apps/web/src/components/right-panel/file-preview-utils.ts:14,17,57-68` — `FilePreviewKind` 扩展、`TEXT_EXTENSIONS` 移除 csv、`classifyFilePreview` 加分类。
- `apps/web/src/components/right-panel/RightPanelFilePreview.tsx:125,449-452` — `mediaScope` 创建条件扩展、条件链路由到 `DocumentViewerHost`。
- `apps/web/components.json` — 若 shadcn add 未自动写入 registry namespace `@extend/*`，手动补。

**shadcn add 产物**（自动生成于 `apps/web/src/components/ui/` 或其子目录）：
- `pdf-viewer.tsx` / `docx-viewer.tsx` / `xlsx-viewer.tsx` / `pptx-viewer.tsx` / `csv-tsv-viewer.tsx`

---

## Task 1: 基建 — 拉入 Extend UI 源码与依赖

**Files:**
- Read: `apps/web/components.json`
- Create（由 shadcn add 自动）: `apps/web/src/components/ui/{pdf,docx,xlsx,pptx,csv-tsv}-viewer.tsx`
- Modify: `apps/web/package.json`（npm runtime 依赖）

**Interfaces:**
- Produces: 5 个 Extend UI viewer 源码文件到位；npm 依赖 `react-pdf`、`@extend-ai/react-xlsx`、`@extend-ai/react-pptx`、（docx/csv 库由 add 带入）可被 import。

**目的**: 让后续任务能引用真实组件源码与 props 签名。这是本计划的前置——各 viewer 的精确 props 须在此任务后从源码读取。

- [ ] **Step 1: 进入 worktree 并安装现有依赖**

```bash
cd "D:/workspace/projects/ai-projects/lume/.claude/worktrees/feature+right-panel-doc-viewers"
bun install
```

Expected: 安装成功，无报错。

- [ ] **Step 2: 核对 components.json 的 registry 配置**

Run: 读 `apps/web/components.json`，确认 `style`、`baseColor`、`aliases.components`（应为 `@/components`）。
若已存在 `registries` 字段含 `@extend/*`，跳过 Step 3 的手动补；否则 Step 3 需补。

- [ ] **Step 3: shadcn add 5 个 viewer**

```bash
cd apps/web
bunx shadcn@latest add @extend/pdf-viewer @extend/docx-viewer @extend/xlsx-viewer @extend/pptx-viewer @extend/csv-tsv-viewer
```

若提示 `@extend` namespace 未注册，按提示追加 registry（`https://ui.extend.ai/r/styles/default/index.json` 或文档站给出的 registry URL）到 `components.json` 的 `registries` 字段后重跑。

Expected: `apps/web/src/components/ui/`（或子目录）下生成 5 个 viewer 源码文件；`package.json` 新增 `react-pdf`、`@extend-ai/react-xlsx`、`@extend-ai/react-pptx` 等。

- [ ] **Step 4: 记录每个 viewer 的 props 签名与 primitive 依赖**

逐个读生成的 5 个 viewer 源码，在每个文件的顶部以注释记录：
- 默认导出的组件名（如 `PDFViewer`）
- 关键 props（文件源 prop 名，预期为 `src` 或 `file`；以及 `className`/`showToolbar` 等）
- 其 `import` 的 `@/components/ui/*` primitive 清单（核对路径在 Lume 是否存在）

这份记录是 Task 5–9 适配的依据。

- [ ] **Step 5: 验证依赖可 import**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: 不应出现「Cannot find module 'react-pdf'/'@extend-ai/react-*'」。Extend UI 组件自身的 primitive 类型错误此时可暂存（后续 task 修）。

- [ ] **Step 6: Commit**

```bash
git add apps/web/components.json apps/web/package.json apps/web/src/components/ui/*viewer*.tsx
git commit -m "📦 build(deps): 引入 Extend UI 文档查看器源码与依赖

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: classifyFilePreview 扩展（TDD）

**Files:**
- Modify: `apps/web/src/components/right-panel/file-preview-utils.ts:14,17,57-68`
- Test: `apps/web/src/components/right-panel/file-preview-utils.test.ts`（新建）

**Interfaces:**
- Produces: `FilePreviewKind` 增加 `'docx' | 'xlsx' | 'pptx' | 'csv'`；`classifyFilePreview` 对 docx/xlsx/pptx/csv 返回对应 kind。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/src/components/right-panel/file-preview-utils.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { classifyFilePreview } from './file-preview-utils'

describe('classifyFilePreview — 文档查看器格式', () => {
  it('识别 Office 与 CSV 文档', () => {
    expect(classifyFilePreview('a.docx')).toBe('docx')
    expect(classifyFilePreview('b.DOCX')).toBe('docx')
    expect(classifyFilePreview('a.xlsx')).toBe('xlsx')
    expect(classifyFilePreview('a.pptx')).toBe('pptx')
    expect(classifyFilePreview('a.csv')).toBe('csv')
    expect(classifyFilePreview('a.tsv')).toBe('csv')
  })

  it('保留既有分类不回归', () => {
    expect(classifyFilePreview('a.pdf')).toBe('pdf')
    expect(classifyFilePreview('a.png')).toBe('image')
    expect(classifyFilePreview('a.md')).toBe('markdown')
    expect(classifyFilePreview('a.html')).toBe('html')
    expect(classifyFilePreview('a.mp4')).toBe('video')
    expect(classifyFilePreview('a.ts')).toBe('text')
    expect(classifyFilePreview('a.unknownext')).toBe('unsupported')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/web && bun test src/components/right-panel/file-preview-utils.test.ts
```

Expected: FAIL（`'docx'` 等不等于 `'unsupported'`/`'text'`；TS 可能先报 `FilePreviewKind` 不含新成员）。

- [ ] **Step 3: 扩展类型与分类器**

`file-preview-utils.ts`:

:14 类型扩展为：
```ts
export type FilePreviewKind = 'text' | 'markdown' | 'image' | 'html' | 'pdf' | 'video' | 'pdb' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'unsupported'
```

:16-21 `TEXT_EXTENSIONS` 集合中**删除 `'csv',`** 这一项（:17 行内）。

:57-68 `classifyFilePreview` 在 `pdf` 判断之后、`markdown` 之前插入：
```ts
  if (extension === 'docx') return 'docx'
  if (extension === 'xlsx') return 'xlsx'
  if (extension === 'pptx' || extension === 'ppt') return 'pptx'
  if (extension === 'csv' || extension === 'tsv') return 'csv'
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd apps/web && bun test src/components/right-panel/file-preview-utils.test.ts
```

Expected: PASS。

- [ ] **Step 5: typecheck**

```bash
bun run typecheck 2>&1 | tail -20
```

Expected: 无与 `FilePreviewKind` 相关的新错误。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/right-panel/file-preview-utils.ts apps/web/src/components/right-panel/file-preview-utils.test.ts
git commit -m "✨ feat(right-panel): classifyFilePreview 识别 docx/xlsx/pptx/csv

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: mediaScope 文件源扩展到文档格式

**Files:**
- Modify: `apps/web/src/components/right-panel/RightPanelFilePreview.tsx:125`

**Interfaces:**
- Produces: docx/xlsx/pptx/csv 的预览也会创建 `mediaScope`（`lume-file://` URL），供 `DocumentViewerHost` 的 `src` 使用。

- [ ] **Step 1: 扩展 mediaScope 创建条件**

`RightPanelFilePreview.tsx:125`，把：
```ts
    if (kind === 'image' || kind === 'pdf' || kind === 'video') {
```
改为：
```ts
    if (kind === 'image' || kind === 'pdf' || kind === 'video'
      || kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'csv') {
```

这样 4 个新 kind 也走 `createFilePreviewScope({ref,kind:'media-file',generation})` → `setMediaScope({token,url})`。

- [ ] **Step 2: typecheck**

```bash
bun run typecheck 2>&1 | tail -20
```

Expected: 无新错误（`kind` 类型已含新成员）。

- [ ] **Step 3: 手动验证（可选，集成验证在 Task 10）**

此处仅确认编译通过；端到端渲染验证留到 Task 10（此时 viewer 尚未接入）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/right-panel/RightPanelFilePreview.tsx
git commit -m "✨ feat(right-panel): mediaScope 覆盖 docx/xlsx/pptx/csv

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: DocumentViewerHost + 分发逻辑（TDD）

**Files:**
- Create: `apps/web/src/components/right-panel/document-viewer/document-viewer-kinds.ts`
- Create: `apps/web/src/components/right-panel/document-viewer/DocumentViewerHost.tsx`
- Create: `apps/web/src/components/right-panel/document-viewer/viewers/{Pdf,Docx,Xlsx,Pptx,Csv}Viewer.tsx`（骨架）
- Test: `apps/web/src/components/right-panel/document-viewer/document-viewer-kinds.test.ts`

**Interfaces:**
- Consumes: `FilePreviewKind`（来自 `file-preview-utils`）；Task 1 的 5 个 Extend UI viewer 源码。
- Produces: `DocumentViewerHost`（props `{ kind: FilePreviewKind; fileRef; guardedRef; mediaScope: {token,url}|null; onOpenFile }`）、`isDocumentViewerKind(kind)`、`DOCUMENT_VIEWER_KINDS`。

- [ ] **Step 1: 写分发逻辑失败测试**

新建 `document-viewer/document-viewer-kinds.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { DOCUMENT_VIEWER_KINDS, isDocumentViewerKind } from './document-viewer-kinds'

describe('isDocumentViewerKind', () => {
  it('文档格式返回 true', () => {
    for (const kind of ['pdf', 'docx', 'xlsx', 'pptx', 'csv'] as const) {
      expect(isDocumentViewerKind(kind)).toBe(true)
    }
  })
  it('非文档格式返回 false', () => {
    expect(isDocumentViewerKind('image')).toBe(false)
    expect(isDocumentViewerKind('text')).toBe(false)
    expect(isDocumentViewerKind('unsupported')).toBe(false)
  })
  it('DOCUMENT_VIEWER_KINDS 恰好 5 项', () => {
    expect(DOCUMENT_VIEWER_KINDS).toHaveLength(5)
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd apps/web && bun test src/components/right-panel/document-viewer/document-viewer-kinds.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现分发常量与判断**

新建 `document-viewer/document-viewer-kinds.ts`：

```ts
import type { FilePreviewKind } from '../file-preview-utils'

/** 由 DocumentViewerHost 接管的文件预览类型 */
export const DOCUMENT_VIEWER_KINDS = ['pdf', 'docx', 'xlsx', 'pptx', 'csv'] as const
export type DocumentViewerKind = (typeof DOCUMENT_VIEWER_KINDS)[number]

export function isDocumentViewerKind(kind: FilePreviewKind): kind is DocumentViewerKind {
  return (DOCUMENT_VIEWER_KINDS as readonly string[]).includes(kind)
}
```

- [ ] **Step 4: 运行确认通过**

```bash
cd apps/web && bun test src/components/right-panel/document-viewer/document-viewer-kinds.test.ts
```

Expected: PASS。

- [ ] **Step 5: 创建 5 个渲染器骨架**

每个 `viewers/XxxViewer.tsx` 形如（以 PDF 为例，其余替换组件名与 import；精确 props 以 Task 1 Step 4 记录为准）：

```tsx
import { lazy, Suspense } from 'react'
import { PreviewStatus } from '../RightPanelFilePreview'

//Extend UI 组件（Task 1 add 进来）；按源码实际导出名调整
const ExtPdfViewer = lazy(() =>
  import('@/components/ui/pdf-viewer').then((m) => ({ default: m.PDFViewer })),
)

export function PdfViewer({ src, className }: { src: string; className?: string }) {
  return (
    <Suspense fallback={<PreviewStatus>正在加载 PDF 查看器…</PreviewStatus>}>
      <ExtPdfViewer src={src} className={className} />
    </Suspense>
  )
}
```

对 `Docx/Xlsx/Pptx/Csv`Viewer：同样 `lazy` import 对应 `@/components/ui/{docx,xlsx,pptx,csv-tsv}-viewer`，导出名按 Task 1 记录（如 `DOCXViewer`/`XLSXViewer`/`PPTXViewer`/`CSVViewer`）。`src` prop 同名。

- [ ] **Step 6: 实现 DocumentViewerHost**

`document-viewer/DocumentViewerHost.tsx`：

```tsx
import type { FileRef, GuardedFileRef } from '@lume/shared'
import type { FilePreviewKind } from '../file-preview-utils'
import type { RightPanelFileTarget } from '../right-panel-files-state'
import { isDocumentViewerKind } from './document-viewer-kinds'
import { PdfViewer } from './viewers/PdfViewer'
import { DocxViewer } from './viewers/DocxViewer'
import { XlsxViewer } from './viewers/XlsxViewer'
import { PptxViewer } from './viewers/PptxViewer'
import { CsvViewer } from './viewers/CsvViewer'
import { PreviewStatus } from '../RightPanelFilePreview'

type MediaScope = { token: string; url: string } | null

export function DocumentViewerHost({
  kind,
  mediaScope,
}: {
  kind: FilePreviewKind
  fileRef: FileRef | null
  guardedRef?: GuardedFileRef
  mediaScope: MediaScope
  onOpenFile: (target: RightPanelFileTarget | FileRef) => void
}) {
  if (!isDocumentViewerKind(kind)) return null
  if (!mediaScope) return <PreviewStatus>正在准备文档…</PreviewStatus>

  const cls = 'h-full w-full'
  switch (kind) {
    case 'pdf': return <PdfViewer src={mediaScope.url} className={cls} />
    case 'docx': return <DocxViewer src={mediaScope.url} className={cls} />
    case 'xlsx': return <XlsxViewer src={mediaScope.url} className={cls} />
    case 'pptx': return <PptxViewer src={mediaScope.url} className={cls} />
    case 'csv': return <CsvViewer src={mediaScope.url} className={cls} />
    default: return null
  }
}
```

注意：`PreviewStatus` 当前是 `RightPanelFilePreview.tsx` 内的局部函数（:525）。**若它未被 export，先在该文件加 `export`**（最小改动），或在本目录重写一个等价组件。优先 export 现有的（DRY）。

- [ ] **Step 7: typecheck**

```bash
bun run typecheck 2>&1 | tail -30
```

Expected: Extend UI 组件本身的 primitive 类型问题可能在此暴露——记录下来留待 Task 5–9 修。Host 自身类型应通过。

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/right-panel/document-viewer apps/web/src/components/right-panel/RightPanelFilePreview.tsx
git commit -m "✨ feat(right-panel): DocumentViewerHost 统一接入层 + 5 渲染器骨架

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: PdfViewer 适配 + react-pdf worker

**Files:**
- Modify: `apps/web/src/components/right-panel/document-viewer/viewers/PdfViewer.tsx`
- Read: `apps/web/src/components/ui/pdf-viewer.tsx`（Task 1 产物）

**目的**: PDF 是当前最弱一环（替换原生 `<object>`），且 `react-pdf` 在 Electron+Vite 下需配置 worker——此任务作为 viewer 适配的参考实现。

- [ ] **Step 1: 读 pdf-viewer 源码，确认 props 与 primitive**

确认：默认导出名、文件源 prop（`src`/`file`/`url`？）、`import` 的 `@/components/ui/*` 清单。

- [ ] **Step 2: 配置 react-pdf worker**

`react-pdf` 需 `pdfjs.GlobalWorkerOptions.workerSrc`。在 `PdfViewer.tsx` 顶部：
```tsx
import { GlobalWorkerOptions } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
GlobalWorkerOptions.workerSrc = workerSrc
```
（Vite 的 `?url` 后缀把 worker 作为 URL 资源；若 `pdfjs-dist` 版本路径不同，按实际 `package.json` 版本调整，例如 `pdf.worker.min.mjs` vs `pdf.worker.min.js`。）

- [ ] **Step 3: 修正 primitive import（按需）**

若 `pdf-viewer.tsx` 内有 `@/components/ui/select` 且用到 `SelectValue`，注意 base-ui 陷阱：`SelectValue` 需传 children 或用 `<SelectValue>{(value) => label}</SelectValue>` 渲染模式。逐处核对。

- [ ] **Step 4: 手动验证**

在 Lume 桌面端打开一个含 `.pdf` 的项目（或准备样本），右侧面板文件 Tab 选中该 PDF。验证：
- [ ] 不再是原生 `<object>`（地址栏/工具栏为 Extend UI 风格）
- [ ] 翻页、缩放可用
- [ ] 无 worker 报错（控制台无 `Setting up fake worker`/worker 404）

- [ ] **Step 5: typecheck + Commit**

```bash
bun run typecheck 2>&1 | tail -20
git add apps/web/src/components/right-panel/document-viewer/viewers/PdfViewer.tsx apps/web/src/components/ui/pdf-viewer.tsx
git commit -m "✨ feat(right-panel): PdfViewer 适配 + react-pdf worker 配置

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: DocxViewer 适配

**Files:**
- Modify: `apps/web/src/components/right-panel/document-viewer/viewers/DocxViewer.tsx`
- Read: `apps/web/src/components/ui/docx-viewer.tsx`

- [ ] **Step 1: 读 docx-viewer 源码**

确认导出名、文件源 prop、primitive 清单、底层 docx 渲染库。

- [ ] **Step 2: 对齐 src prop 与 primitive import**

把 `DocxViewer.tsx` 的 `lazy` import 与 `src` 传参对齐源码实际签名；修正任何 base-ui `SelectValue` 陷阱。

- [ ] **Step 3: 手动验证**

准备一个 `.docx` 样本，右侧面板打开。验证：
- [ ] 文档内容渲染（文字/段落/基本排版）
- [ ] 不再是 `unsupported` 占位
- [ ] 控制台无报错

- [ ] **Step 4: typecheck + Commit**

```bash
bun run typecheck 2>&1 | tail -20
git add apps/web/src/components/right-panel/document-viewer/viewers/DocxViewer.tsx apps/web/src/components/ui/docx-viewer.tsx
git commit -m "✨ feat(right-panel): DocxViewer 适配

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: XlsxViewer 适配

**Files:**
- Modify: `apps/web/src/components/right-panel/document-viewer/viewers/XlsxViewer.tsx`
- Read: `apps/web/src/components/ui/xlsx-viewer.tsx`

- [ ] **Step 1: 读 xlsx-viewer 源码**

确认导出名、文件源 prop、primitive 清单；底层 `@extend-ai/react-xlsx`。

- [ ] **Step 2: 对齐 src prop 与 primitive import**

同 Task 6 Step 2。

- [ ] **Step 3: 手动验证**

准备一个多 sheet 的 `.xlsx` 样本，右侧面板打开。验证：
- [ ] 表格渲染、sheet 切换可用
- [ ] 缩放/列宽可用
- [ ] 不再是 `unsupported` 占位

- [ ] **Step 4: typecheck + Commit**

```bash
bun run typecheck 2>&1 | tail -20
git add apps/web/src/components/right-panel/document-viewer/viewers/XlsxViewer.tsx apps/web/src/components/ui/xlsx-viewer.tsx
git commit -m "✨ feat(right-panel): XlsxViewer 适配

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: PptxViewer 适配

**Files:**
- Modify: `apps/web/src/components/right-panel/document-viewer/viewers/PptxViewer.tsx`
- Read: `apps/web/src/components/ui/pptx-viewer.tsx`

- [ ] **Step 1: 读 pptx-viewer 源码**

确认导出名、文件源 prop（预期 `src`）、primitive 清单；底层 `@extend-ai/react-pptx`。已知可选 props：`initialSlide`、`defaultZoom`、`defaultThumbnailSidebarOpen`、`showToolbar`。

- [ ] **Step 2: 对齐 src prop 与 primitive import**

同 Task 6 Step 2。

- [ ] **Step 3: 手动验证**

准备一个多页 `.pptx` 样本，右侧面板打开。验证：
- [ ] 幻灯片渲染、缩略图侧边栏、翻页/缩放可用
- [ ] 不再是 `unsupported` 占位

- [ ] **Step 4: typecheck + Commit**

```bash
bun run typecheck 2>&1 | tail -20
git add apps/web/src/components/right-panel/document-viewer/viewers/PptxViewer.tsx apps/web/src/components/ui/pptx-viewer.tsx
git commit -m "✨ feat(right-panel): PptxViewer 适配

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: CsvViewer 适配

**Files:**
- Modify: `apps/web/src/components/right-panel/document-viewer/viewers/CsvViewer.tsx`
- Read: `apps/web/src/components/ui/csv-tsv-viewer.tsx`

- [ ] **Step 1: 读 csv-tsv-viewer 源码**

确认导出名、文件源 prop、primitive 清单、底层库。

- [ ] **Step 2: 对齐 src prop 与 primitive import**

同 Task 6 Step 2。

- [ ] **Step 3: 手动验证**

准备一个 `.csv` 样本，右侧面板打开。验证：
- [ ] 以表格渲染（不再当源码文本）
- [ ] TSV 同样工作（`.tsv` 也走 `csv` kind）

- [ ] **Step 4: typecheck + Commit**

```bash
bun run typecheck 2>&1 | tail -20
git add apps/web/src/components/right-panel/document-viewer/viewers/CsvViewer.tsx apps/web/src/components/ui/csv-tsv-viewer.tsx
git commit -m "✨ feat(right-panel): CsvViewer 适配（修正 csv 误归 text）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: 条件链接入 + 移除旧 PDF `<object>`

**Files:**
- Modify: `apps/web/src/components/right-panel/RightPanelFilePreview.tsx:449-452`（及条件链）

**目的**: 把 pdf 分支 + 新格式分支统一路由到 `DocumentViewerHost`，完成端到端集成。

- [ ] **Step 1: 路由文档格式到 Host**

在 `RightPanelFilePreview.tsx` 顶部 import：
```tsx
import { DocumentViewerHost } from './document-viewer/DocumentViewerHost'
import { isDocumentViewerKind } from './document-viewer/document-viewer-kinds'
```

在条件链中，**移除** :449-452 的 pdf `<object>` 分支：
```tsx
// 删除：
// ) : kind === 'pdf' && mediaScope ? (
//   <object data={mediaScope.url} type="application/pdf" className="h-full w-full">
//     <PreviewStatus>浏览器无法显示此 PDF，可使用系统应用打开。</PreviewStatus>
//   </object>
```

在 image 分支之后、video 分支之前（或紧跟 image 分支），插入文档统一分支：
```tsx
        ) : isDocumentViewerKind(kind) ? (
          <DocumentViewerHost
            kind={kind}
            fileRef={fileRef}
            guardedRef={guardedRef}
            mediaScope={mediaScope}
            onOpenFile={onOpenFile}
          />
```

注意保持条件链的三元结构正确闭合（pdf 已移除，video 等后续分支的 `: kind === 'video'` 前导 `)` 与新分支衔接）。

- [ ] **Step 2: typecheck**

```bash
bun run typecheck 2>&1 | tail -20
```

Expected: 无新错误。

- [ ] **Step 3: 端到端手动验证**

准备样本：`sample.pdf`、`sample.docx`、`sample.xlsx`、`sample.pptx`、`sample.csv`。在桌面端右侧面板文件 Tab 逐个打开：
- [ ] PDF：Extend UI 查看器（非原生 object），翻页/缩放正常
- [ ] DOCX/XLSX/PPTX：正常渲染，非 `unsupported` 占位
- [ ] CSV：表格渲染，非源码文本
- [ ] 切换文件、关闭 tab 无泄漏/报错（`mediaScope` revoke 正常）
- [ ] 明暗主题下查看器外观正常

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/right-panel/RightPanelFilePreview.tsx
git commit -m "✨ feat(right-panel): 文档预览路由到 DocumentViewerHost，移除原生 PDF object

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: typecheck + bundle 验证

**Files:** 无（验证性任务）

- [ ] **Step 1: 全量 typecheck**

```bash
cd "D:/workspace/projects/ai-projects/lume/.claude/worktrees/feature+right-panel-doc-viewers"
bun run typecheck
```

Expected: 绿（无错误）。若有 Extend UI 组件的 primitive 类型残留，回到对应 Task 修。

- [ ] **Step 2: bundle 体积对比（懒加载生效）**

```bash
cd apps/web && bun run build
```

对比 build 产物：5 个文档查看器库应出现在**独立 chunk**（lazy split），主入口 chunk 体积不应显著增长。记录 build 输出的 chunk 列表。

Expected: 产物含 `pdf-viewer`/`xlsx`/`pptx` 等 lazy chunk；主 chunk 未因这些库膨胀。

- [ ] **Step 3: 推送并更新 PR**

```bash
git push
```

PR #33 已开，追加 commits 会自动更新。在 PR 描述勾掉完成项。

---

## Self-Review 记录

- **Spec 覆盖**: spec 第 4 章范围（5 viewer）→ Task 1,5-9；第 6 章接入点（classifyFilePreview + 条件链）→ Task 2,10；第 6 章 mediaScope → Task 3；第 5 章架构（Host+渲染器）→ Task 4；第 7 章 4 集成点 → 散布 Task 4(worker/懒加载/主题/文件源)；第 10 章验证 → Task 11。✅ 无遗漏。
- **占位符**: 各 viewer 精确 props 受限于「Task 1 add 后源码」——已通过 Task 1 Step 4 显式记录签名 + Task 5-9 Step 1 读源码动作兜住，非空 TODO。
- **类型一致性**: `DocumentViewerHost` props（`kind/mediaScope/fileRef/guardedRef/onOpenFile`）与 Task 10 调用点一致；`isDocumentViewerKind` 在 Task 4 定义、Task 10 使用，签名一致。
