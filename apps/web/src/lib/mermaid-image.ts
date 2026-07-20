const DEFAULT_SVG_WIDTH = 1200
const DEFAULT_SVG_HEIGHT = 800
const MAX_RASTER_DIMENSION = 4096
const RASTER_SCALE = 2

function readSvgViewBox(svg: string): { width: number; height: number } | null {
  const match = svg.match(/\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

export async function mermaidSvgToPngDataUrl(svg: string): Promise<string> {
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Mermaid SVG 加载失败'))
      image.src = objectUrl
    })

    const viewBox = readSvgViewBox(svg)
    const sourceWidth = viewBox?.width || image.naturalWidth || DEFAULT_SVG_WIDTH
    const sourceHeight = viewBox?.height || image.naturalHeight || DEFAULT_SVG_HEIGHT
    const scale = Math.min(RASTER_SCALE, MAX_RASTER_DIMENSION / Math.max(sourceWidth, sourceHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sourceWidth * scale))
    canvas.height = Math.max(1, Math.round(sourceHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建图片画布')
    context.fillStyle = getComputedStyle(document.body).backgroundColor
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
