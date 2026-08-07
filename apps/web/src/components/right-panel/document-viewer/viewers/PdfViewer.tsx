import { lazy, Suspense } from "react"
import { PreviewStatus } from "../../RightPanelFilePreview"

// Extend UI PDFViewer（forwardRef 具名导出，无 default）
const ExtPdfViewer = lazy(() =>
  import("@/components/extend/pdf-viewer").then((m) => ({
    default: m.PDFViewer,
  })),
)

export function PdfViewer({
  src,
  className,
}: {
  src: string
  className?: string
}) {
  return (
    <Suspense fallback={<PreviewStatus>正在加载 PDF 查看器…</PreviewStatus>}>
      <ExtPdfViewer src={src} className={className} />
    </Suspense>
  )
}
