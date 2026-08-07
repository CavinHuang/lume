import type { FilePreviewKind } from "../file-preview-utils"

/** 由 DocumentViewerHost 接管的文件预览类型 */
export const DOCUMENT_VIEWER_KINDS = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
] as const
export type DocumentViewerKind = (typeof DOCUMENT_VIEWER_KINDS)[number]

export function isDocumentViewerKind(
  kind: FilePreviewKind,
): kind is DocumentViewerKind {
  return (DOCUMENT_VIEWER_KINDS as readonly string[]).includes(kind)
}
