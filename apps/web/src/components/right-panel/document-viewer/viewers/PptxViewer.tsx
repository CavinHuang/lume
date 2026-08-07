import { lazy, Suspense } from "react"
import { PreviewStatus } from "../../RightPanelFilePreview"

// Extend UI PptxViewerPreview（具名导出，无 default）
const ExtPptxViewer = lazy(() =>
  import("@/components/extend/pptx-viewer").then((m) => ({
    default: m.PptxViewerPreview,
  })),
)

export function PptxViewer({
  src,
  className,
}: {
  src: string
  className?: string
}) {
  return (
    <Suspense fallback={<PreviewStatus>正在加载 PPTX 查看器…</PreviewStatus>}>
      <ExtPptxViewer src={src} className={className} />
    </Suspense>
  )
}
