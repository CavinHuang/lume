import type { PreviewData } from './useAnnotationInteraction'

// 评论预览卡：marker hover 后显示评论 body 纯文本。偏移定位（marker 左侧 -308，无 translate）。
export function PreviewCard({ data }: { data: PreviewData }) {
  return <div className="preview" style={{ left: data.rect.x, top: data.rect.y }}>{data.body}</div>
}
