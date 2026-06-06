import { domToPng } from 'modern-screenshot'

export async function renderReadingCardElementToPngBase64(element: HTMLElement): Promise<string> {
  const rect = element.getBoundingClientRect()
  const width = Math.ceil(rect.width)
  const height = Math.ceil(rect.height)
  if (width <= 0 || height <= 0) {
    throw new Error('读书卡片尺寸无效')
  }

  await document.fonts?.ready

  const dataUrl = await domToPng(element, {
    backgroundColor: null,
    scale: Math.max(1, Math.min(window.devicePixelRatio || 1, 2)),
    width,
    height,
  })

  return extractPngBase64FromDataUrl(dataUrl)
}

export function extractPngBase64FromDataUrl(dataUrl: string): string {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) {
    throw new Error('PNG 数据生成失败')
  }
  const base64 = dataUrl.slice(prefix.length)
  if (!base64) {
    throw new Error('PNG 数据生成失败')
  }
  return base64
}
