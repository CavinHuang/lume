import { lazy, Suspense } from "react"
import { PreviewStatus } from "../../RightPanelFilePreview"

// Extend UI XlsxViewerPreview（具名导出，无 default）。isDark / onIsDarkChange 必填。
const ExtXlsxViewer = lazy(() =>
  import("@/components/extend/xlsx-viewer").then((m) => ({
    default: m.XlsxViewerPreview,
  })),
)

export function XlsxViewer({
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
    <Suspense fallback={<PreviewStatus>正在加载 XLSX 查看器…</PreviewStatus>}>
      <ExtXlsxViewer
        src={src}
        className={className}
        isDark={isDark}
        onIsDarkChange={onIsDarkChange}
      />
    </Suspense>
  )
}
