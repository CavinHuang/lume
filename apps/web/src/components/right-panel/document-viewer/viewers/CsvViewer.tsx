import { lazy, Suspense } from "react"
import { PreviewStatus } from "../../RightPanelFilePreview"

// Extend UI CsvViewer（具名导出，无 default）。data 为 CSV/TSV 文本内容（非 URL）。
const ExtCsvViewer = lazy(() =>
  import("@/components/extend/csv-viewer").then((m) => ({
    default: m.CsvViewer,
  })),
)

export function CsvViewer({
  data,
  className,
}: {
  data: string
  className?: string
}) {
  return (
    <Suspense fallback={<PreviewStatus>正在加载 CSV 查看器…</PreviewStatus>}>
      <ExtCsvViewer data={data} className={className} />
    </Suspense>
  )
}
