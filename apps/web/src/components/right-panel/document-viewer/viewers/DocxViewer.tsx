import { lazy, Suspense } from "react"
import { PreviewStatus } from "../../RightPanelFilePreview"

// Extend UI DocxViewerPreview（具名导出，无 default）。isDark / onIsDarkChange 必填。
const ExtDocxViewer = lazy(() =>
  import("@/components/extend/docx-viewer").then((m) => ({
    default: m.DocxViewerPreview,
  })),
)

export function DocxViewer({
  src,
  className,
  isDark,
  onIsDarkChange,
}: {
  src: string
  className?: string
  isDark: boolean
  onIsDarkChange: (value: boolean) => void
}) {
  return (
    <Suspense fallback={<PreviewStatus>正在加载 DOCX 查看器…</PreviewStatus>}>
      <ExtDocxViewer
        src={src}
        className={className}
        isDark={isDark}
        onIsDarkChange={onIsDarkChange}
      />
    </Suspense>
  )
}
