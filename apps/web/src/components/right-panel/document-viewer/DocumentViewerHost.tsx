import { useEffect, useState } from "react"
import type { FileRef, GuardedFileRef } from "@lume/shared"
import type { FilePreviewKind } from "../file-preview-utils"
import type { RightPanelFileTarget } from "../right-panel-files-state"
import { PreviewStatus } from "../RightPanelFilePreview"
import { isDocumentViewerKind } from "./document-viewer-kinds"
import { PdfViewer } from "./viewers/PdfViewer"
import { DocxViewer } from "./viewers/DocxViewer"
import { XlsxViewer } from "./viewers/XlsxViewer"
import { PptxViewer } from "./viewers/PptxViewer"
import { CsvViewer } from "./viewers/CsvViewer"

type MediaScope = { token: string; url: string } | null

/**
 * 读取 Lume 当前主题（初始值）。Lume 通过 `document.documentElement.classList`
 * 的 `dark` 类切换深浅色（见 `lib/theme-mode.ts`），无 React 状态式 theme API。
 * DOCX/XLSX 的 `onIsDarkChange` 回调会更新 Host 持有的 isDark state，
 * 用户在查看器内切换夜间模式后以最后一次切换为准。
 */
function readInitialIsDark(): boolean {
  if (typeof document === "undefined") return false
  return document.documentElement.classList.contains("dark")
}

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
  const [isDark, setIsDark] = useState<boolean>(readInitialIsDark)

  // CSV 文本获取：lume-file:// 协议在 desktop 注册为 supportFetchAPI + corsEnabled，
  // 这里通过 fetch(text) 取得 CSV/TSV 内容交给 CsvViewer。
  const [csvData, setCsvData] = useState<string | null>(null)
  const [csvError, setCsvError] = useState<string | null>(null)

  useEffect(() => {
    if (kind !== "csv" || !mediaScope) return
    let cancelled = false
    setCsvData(null)
    setCsvError(null)
    fetch(mediaScope.url)
      .then((response) => {
        if (!response.ok) throw new Error(`CSV 加载失败：HTTP ${response.status}`)
        return response.text()
      })
      .then((text) => {
        if (!cancelled) setCsvData(text)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCsvError(
            error instanceof Error ? error.message : "CSV 加载失败",
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [kind, mediaScope])

  if (!isDocumentViewerKind(kind)) return null
  if (!mediaScope) return <PreviewStatus>正在准备文档…</PreviewStatus>

  const cls = "h-full w-full"
  switch (kind) {
    case "pdf":
      return <PdfViewer src={mediaScope.url} className={cls} />
    case "docx":
      return (
        <DocxViewer
          src={mediaScope.url}
          className={cls}
          isDark={isDark}
          onIsDarkChange={setIsDark}
        />
      )
    case "xlsx":
      return (
        <XlsxViewer
          src={mediaScope.url}
          className={cls}
          isDark={isDark}
          onIsDarkChange={setIsDark}
        />
      )
    case "pptx":
      return <PptxViewer src={mediaScope.url} className={cls} />
    case "csv":
      if (csvError) return <PreviewStatus>{csvError}</PreviewStatus>
      if (csvData === null) {
        return <PreviewStatus>正在加载 CSV…</PreviewStatus>
      }
      return <CsvViewer data={csvData} className={cls} />
    default:
      return null
  }
}
