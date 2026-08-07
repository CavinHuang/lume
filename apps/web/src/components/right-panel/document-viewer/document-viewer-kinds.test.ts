import { describe, expect, it } from "bun:test"
import {
  DOCUMENT_VIEWER_KINDS,
  isDocumentViewerKind,
} from "./document-viewer-kinds"

describe("isDocumentViewerKind", () => {
  it("文档格式返回 true", () => {
    for (const kind of ["pdf", "docx", "xlsx", "pptx", "csv"] as const) {
      expect(isDocumentViewerKind(kind)).toBe(true)
    }
  })

  it("非文档格式返回 false", () => {
    expect(isDocumentViewerKind("image")).toBe(false)
    expect(isDocumentViewerKind("text")).toBe(false)
    expect(isDocumentViewerKind("unsupported")).toBe(false)
  })

  it("DOCUMENT_VIEWER_KINDS 恰好 5 项", () => {
    expect(DOCUMENT_VIEWER_KINDS).toHaveLength(5)
  })
})
