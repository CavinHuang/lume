/** 预览支持的内联图片扩展名集合（用于判断是否走图片渲染分支） */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

function imageExt(filePath: string): string | undefined {
  return /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase()
}

/** 是否为可内联预览的图片文件（按扩展名判断） */
export function isImageFile(filePath: string): boolean {
  const ext = imageExt(filePath)
  return ext !== undefined && IMAGE_EXTENSIONS.has(ext)
}

/**
 * 构造 lume-file:// 协议 URL，交由 Electron main 流式读取并交 Chromium 解码。
 * 仅适用于 .lume/agent-workspaces 可信根内的文件（thread/workspace）。
 */
export function lumeFileUrl(absPath: string): string {
  return `lume-file://file/${encodeURIComponent(absPath)}`
}
