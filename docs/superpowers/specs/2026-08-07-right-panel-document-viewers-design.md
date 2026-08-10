# 右侧面板文档预览增强（Extend UI 集成）

- 日期: 2026-08-07
- 状态: 已批准，待实现
- 工作分支: `worktree-feature+right-panel-doc-viewers`（基于 origin/main）
- 相关组件库: [extend-hq/ui](https://github.com/extend-hq/ui) · [文档站](https://www.extend.ai/ui)

## 1. 背景与动机

右侧面板的文件预览对 Office / CSV 类文档支持薄弱：

- **PDF** 用浏览器原生 `<object>` 渲染，无统一工具栏 / 翻页 / 缩放，体验与视觉不统一。
- **DOCX / XLSX / PPTX** 在分类器里无对应分支，落到 `unsupported` 占位（"此文件类型不支持内嵌预览"）。
- **CSV** 被误归为 `text`，当成源码文本预览，表格可读性差。

引入 Extend UI 的文档查看器套件一次性补齐这 5 类，并把"每个查看器都要解决的通用问题"抽象成一个共享接入层，避免 5 份 copy-paste。

## 2. 现状（事实依据）

预览主干（均位于 `apps/web/src/components/right-panel/`）：

- **分发链**: `RightPanelFilePreview.tsx:429-519` 的条件链，按 `kind` 分流到 image / pdf / video / html / markdown / pdb / source / unsupported。
- **分类器**: `classifyFilePreview`（`file-preview-utils.ts:57`），返回 `FilePreviewKind`（:14）= `'text' | 'markdown' | 'image' | 'html' | 'pdf' | 'video' | 'pdb' | 'unsupported'`。
  - `pdf` → `'pdf'`（:60）
  - `csv` 在 `TEXT_EXTENSIONS`（:17）→ `'text'`（当源码预览）
  - `docx / xlsx / pptx` → 无匹配 → `'unsupported'`
- **PDF 当前渲染**: `RightPanelFilePreview.tsx:449-452`，`<object data={mediaScope.url} type="application/pdf">`。
- **文件源**: `mediaScope.url`（`lume-file://` 沙箱 scope），由 `lumeFileUrl(absPath)`（`file-preview-utils.ts:179`）生成 → `lume-file://file/<encoded absPath>`，经 Electron main 流式读取。图片 / PDF / 视频均已用此通道。
- **主题**: shadcn 风格 Tailwind token（`foreground` / `background` / `primary` / `destructive` + `dark:` 前缀），与 Extend UI 同源。

## 3. Extend UI 覆盖范围

| 格式 | 组件 | registry | 底层 | 纯前端 |
|---|---|---|---|---|
| PDF | PDF Viewer | `@extend/pdf-viewer` | `react-pdf` | ✅ |
| DOCX | DOCX Viewer | `@extend/docx-viewer` | docx 渲染 | ✅ |
| XLSX | XLSX Viewer | `@extend/xlsx-viewer` | `@extend-ai/react-xlsx`（多 sheet / 公式 / 虚拟化 / 冻结） | ✅ |
| PPTX | PPTX Viewer | `@extend/pptx-viewer` | `@extend-ai/react-pptx`（缩略图 / 缩放 / 无需转码） | ✅ |
| CSV/TSV | CSV/TSV Viewer | `@extend/csv-tsv-viewer` | — | ✅ |

- 全部纯前端，无需服务端转换，适配 Electron。
- 分发方式：shadcn registry（组件源码复制进项目）+ `@extend-ai/react-*` 为 npm runtime 依赖。

## 4. 目标范围

**一次性接入 5 个文档查看器**（交付节奏：用户选定方案 C "五个一起上"）。

为兜住"一起上"的集成风险，内部结构仍为 **1 个共享 Host + 5 个渲染器**，把 4 个通用集成点抽象到 Host，使新增格式接近机械复制。先建 Host、再填 5 个渲染器（交付一批，但实现有序）。

## 5. 架构：`DocumentViewerHost` + 5 个懒加载渲染器

新增目录 `apps/web/src/components/right-panel/document-viewer/`：

```
document-viewer/
  DocumentViewerHost.tsx        # 统一接入层（封装 4 个通用集成点）
  viewers/
    PdfViewer.tsx               # React.lazy，薄包装 @extend/pdf-viewer
    DocxViewer.tsx
    XlsxViewer.tsx
    PptxViewer.tsx
    CsvViewer.tsx
```

**Host 职责**（封装通用集成点）：
- 解析文件源：`fileRef / guardedRef` → `mediaScope.url`（复用现有 `lume-file://` scope）。
- 按 `kind` 懒加载对应渲染器（`React.lazy` + `Suspense`）。
- 统一 loading / error / 不支持占位（复用 `PreviewStatus`）。
- 注入主题 token（与 Lume 现有 token 同名，直接对齐）。

**渲染器职责（单一）**：
- 接收 `{ src, ...props }`，渲染对应 Extend UI viewer。
- 承担该 viewer 的 primitive import 改写（`@/components/ui/*` → Lume base-ui primitive）。

**边界目标**：渲染器只关心"给定 src 怎么渲染某一种格式"；Host 只关心"文件源 + 分发 + 通用外壳"。两者可独立理解和测试。

## 6. 接入点改动（仅 2 处，surgical）

### ① `classifyFilePreview`（`file-preview-utils.ts:57`）

- `FilePreviewKind` 新增 `'docx' | 'xlsx' | 'pptx' | 'csv'`。
- 按扩展名分类 docx / xlsx / pptx。
- **csv 从 `TEXT_EXTENSIONS`（:17）移除**，改为独立 `'csv'` kind（修正当前误分类）。

### ② `RightPanelFilePreview` 条件链（`:449-452` 附近）

把 pdf 分支 + 新增 docx / xlsx / pptx / csv 分支统一替换为：

```tsx
<DocumentViewerHost
  kind={kind}
  fileRef={fileRef}
  guardedRef={guardedRef}
  mediaScope={mediaScope}
  onOpenFile={onOpenFile}
  /* 其余透传 */
/>
```

Host 内部按 `kind` 分发到懒加载渲染器。原 pdf 的 `<object>` 分支随之移除。

## 7. 四个通用集成点（"怎么优化"的核心）

| 集成点 | 处理方式 |
|---|---|
| **primitive 适配** | Extend UI 组件硬编码 `import { Button } from "@/components/ui/button"` 等 → 核对 Lume `@/components/ui/` 下 base-ui primitive 是否齐全（select / scroll-area / tooltip / dialog），缺的补；记忆 [[reference_baseui-select-value]] 提示 base-ui Select 的 SelectValue 陷阱需注意 |
| **主题** | Lume 与 Extend UI 同属 shadcn token 体系 → token 名直接对齐，零额外映射 |
| **懒加载 / bundle** | 每渲染器 `React.lazy(() => import(...))`，按 `kind` 动态加载；`react-pdf` / `@extend-ai/react-*` 不进主 bundle（参考 [[project_lume-link-openconnector-bundle]] bundle 敏感教训） |
| **文件源** | 复用现有 `mediaScope.url`（`lume-file://` scope）；现有 PDF `<object data>` 已验证此数据流，各 viewer 的 `src` 接同一 URL |

## 8. 新增依赖

- **npm runtime**（全部懒加载）: `react-pdf`、`@extend-ai/react-xlsx`、`@extend-ai/react-pptx`、docx 渲染库、csv 库。
- **shadcn 源码复制**: `@extend/{pdf,docx,xlsx,pptx,csv-tsv}-viewer`。

## 9. 风险

1. **react-pdf worker**: Electron + Vite 需正确配置 pdf.js worker，否则 PDF 渲染白屏（已知踩坑点）。
2. **`@extend-ai/react-*` 私有 npm 包**: 需确认 registry 可访问性、license、版本稳定性 —— 最大外部依赖风险，必要时先单独验证。
3. **primitive 缺口**: Lume base-ui 封装可能缺 Extend UI 所需某个 primitive（ScrollArea / Tooltip 实现差异），需逐组件核对。
4. **viewer `src` 输入类型**: 需确认每个 viewer 接受 URL 还是必须 ArrayBuffer（影响文件源适配层）。

## 10. 验证

- 每格式准备样本文件，右侧面板打开验证：渲染 / 翻页 / 缩放 / sheet 切换 / 幻灯片导航。
- `bun typecheck` 绿（注意：新 worktree 需先 `bun install`，见 [[reference_worktree-bun-install]]）。
- 主 bundle 体积对比（确认懒加载生效、不回归）。

## 11. 非目标（YAGNI）

明确**不引入**以下 Extend UI 组件（与 Lume 定位不符或已有等价实现）：

- `file-thumbnail`、`file-system-block`（Lume 已有文件 Tab）
- `layout-blocks-block`、`bounding-box-citations-block`（文档抽取场景，Lume 非文档抽取产品）
- `file-upload`、`e-signature`、文档拆分

浏览器预览（webview）、源码 / Diff（`@pierre/diffs`）、Markdown（XMarkdown）、HTML（沙箱 iframe）、PDB（3dmol）已有成熟实现，不在本次范围。
