/** 预览支持的内联图片扩展名 → MIME 映射 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

function imageExt(filePath: string): string | undefined {
  return /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase()
}

/** 是否为可内联预览的图片文件（按扩展名判断） */
export function isImageFile(filePath: string): boolean {
  const ext = imageExt(filePath)
  return ext !== undefined && ext in IMAGE_MIME_BY_EXT
}

/** 由扩展名推断图片 MIME；未知扩展名回退 image/png */
export function imageMimeType(filePath: string): string {
  const ext = imageExt(filePath)
  return (ext && IMAGE_MIME_BY_EXT[ext]) || 'image/png'
}

/** 构造 base64 data URL（用于 <img src>） */
export function imageDataUrl(filePath: string, base64: string): string {
  return `data:${imageMimeType(filePath)};base64,${base64}`
}
