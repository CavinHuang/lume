import { useEffect, useRef, useState } from 'react'
import type { AgentIslandPhase } from '@lume/shared'

const SIZE = 18
const FPS = 10

const SPRITES = {
  idle: {
    src: new URL('./sprites/idle.png', import.meta.url).href,
    x: [179, 462, 745, 1012, 1304],
    y: [261, 534, 803],
  },
  processing: {
    src: new URL('./sprites/processing.png', import.meta.url).href,
    x: [124, 415, 708, 1002, 1295],
    y: [233, 477, 718],
  },
  thinling: {
    src: new URL('./sprites/thinling.png', import.meta.url).href,
    x: [150, 481, 754, 1009, 1298],
    y: [309, 661],
  },
  working: {
    src: new URL('./sprites/working.png', import.meta.url).href,
    x: [222, 506, 766, 1028, 1302],
    y: [226, 504, 785],
  },
  listening: {
    src: new URL('./sprites/listening.png', import.meta.url).href,
    x: [204, 518, 815, 1107, 1388],
    y: [159, 478, 815],
  },
  notion: {
    src: new URL('./sprites/notion.png', import.meta.url).href,
    x: [203, 516, 774, 1032, 1290],
    y: [183, 487, 790],
  },
  success: {
    src: new URL('./sprites/success.png', import.meta.url).href,
    x: [182, 490, 796, 1069, 1359],
    y: [253, 502, 757],
  },
} as const

type SpriteName = keyof typeof SPRITES
type FrameBounds = { x: number; y: number; width: number; height: number }
type CalibratedSprite = { image: HTMLImageElement; frames: FrameBounds[]; cellSize: number }

const RUNNING_VARIANTS: SpriteName[] = ['processing', 'thinling', 'working', 'listening']
const spriteCache = new Map<SpriteName, Promise<CalibratedSprite>>()

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Unable to load mascot sprite: ${src}`))
    image.src = src
  })
}

function cuts(centers: readonly number[], size: number): number[] {
  const result = [0]
  for (let index = 1; index < centers.length; index++) {
    result.push(Math.round((centers[index - 1] + centers[index]) / 2))
  }
  result.push(size)
  return result
}

/**
 * Find meaningful alpha components inside one coarse frame region. The generated source
 * sheets contain a few edge specks, so tiny isolated components are deliberately ignored.
 */
function findContentBounds(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): FrameBounds {
  const width = x1 - x0
  const height = y1 - y0
  const visited = new Uint8Array(width * height)
  const stack = new Int32Array(width * height)
  let left = x1
  let top = y1
  let right = x0
  let bottom = y0
  let found = false
  const isOpaque = (x: number, y: number) => pixels[((y0 + y) * imageWidth + x0 + x) * 4 + 3] > 10

  for (let startY = 0; startY < height; startY++) {
    for (let startX = 0; startX < width; startX++) {
      const start = startY * width + startX
      if (visited[start]) continue
      visited[start] = 1
      if (!isOpaque(startX, startY)) continue

      let head = 0
      let tail = 0
      let area = 0
      let minX = startX
      let maxX = startX
      let minY = startY
      let maxY = startY
      stack[tail++] = start

      while (head < tail) {
        const index = stack[head++]
        const y = Math.floor(index / width)
        const x = index - y * width
        area++
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)

        const neighbors = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]
        for (const [nextX, nextY] of neighbors) {
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue
          const neighbor = nextY * width + nextX
          if (visited[neighbor]) continue
          visited[neighbor] = 1
          if (isOpaque(nextX, nextY)) stack[tail++] = neighbor
        }
      }

      if (area < 24) continue
      found = true
      left = Math.min(left, x0 + minX)
      top = Math.min(top, y0 + minY)
      right = Math.max(right, x0 + maxX + 1)
      bottom = Math.max(bottom, y0 + maxY + 1)
    }
  }

  if (!found) return { x: x0, y: y0, width, height }
  const padding = 2
  const x = Math.max(x0, left - padding)
  const y = Math.max(y0, top - padding)
  const paddedRight = Math.min(x1, right + padding)
  const paddedBottom = Math.min(y1, bottom + padding)
  return { x, y, width: paddedRight - x, height: paddedBottom - y }
}

async function loadSprite(name: SpriteName): Promise<CalibratedSprite> {
  const cached = spriteCache.get(name)
  if (cached) return cached

  const pending = (async () => {
    const layout = SPRITES[name]
    // Use onload instead of Image.decode(): the latter is unreliable for the custom
    // app:// protocol used by packaged Electron windows on some Chromium versions.
    const image = await loadImage(layout.src)

    const source = document.createElement('canvas')
    source.width = image.naturalWidth
    source.height = image.naturalHeight
    const context = source.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Unable to create mascot calibration canvas')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, source.width, source.height).data
    const xCuts = cuts(layout.x, source.width)
    const yCuts = cuts(layout.y, source.height)
    const frames: FrameBounds[] = []

    for (let row = 0; row < layout.y.length; row++) {
      for (let column = 0; column < layout.x.length; column++) {
        frames.push(
          findContentBounds(
            pixels,
            source.width,
            xCuts[column],
            yCuts[row],
            xCuts[column + 1],
            yCuts[row + 1],
          ),
        )
      }
    }

    return {
      image,
      frames,
      cellSize: Math.max(...frames.map((frame) => Math.max(frame.width, frame.height))) + 8,
    }
  })()
  spriteCache.set(name, pending)
  return pending
}

function drawFrame(canvas: HTMLCanvasElement, sprite: CalibratedSprite, frameIndex: number) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  const pixels = Math.round(SIZE * pixelRatio)
  if (canvas.width !== pixels || canvas.height !== pixels) {
    canvas.width = pixels
    canvas.height = pixels
  }
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, SIZE, SIZE)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'

  const frame = sprite.frames[frameIndex]
  const scale = SIZE / sprite.cellSize
  const width = frame.width * scale
  const height = frame.height * scale
  context.drawImage(
    sprite.image,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    (SIZE - width) / 2,
    (SIZE - height) / 2,
    width,
    height,
  )
}

function resolveSprite(phase: AgentIslandPhase, runningVariant: SpriteName) {
  switch (phase) {
    case 'idle':
      return { name: 'idle' as const, animate: true }
    case 'running':
      return { name: runningVariant, animate: true }
    case 'needs-interaction':
      return { name: 'notion' as const, animate: true }
    case 'completed':
      return { name: 'success' as const, animate: true }
    case 'error':
      return { name: 'idle' as const, animate: false }
  }
}

export function IslandMascot({ phase }: { phase: AgentIslandPhase }) {
  const [runningVariant, setRunningVariant] = useState<SpriteName>(RUNNING_VARIANTS[0])
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (phase === 'running') {
      setRunningVariant(RUNNING_VARIANTS[Math.floor(Math.random() * RUNNING_VARIANTS.length)])
    }
  }, [phase])

  const sprite = resolveSprite(phase, runningVariant)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let requestId = 0

    void loadSprite(sprite.name)
      .then((loaded) => {
        if (disposed) return
        let frameIndex = 0
        drawFrame(canvas, loaded, frameIndex)
        if (!sprite.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

        let lastTime = 0
        let elapsed = 0
        const step = 1000 / FPS
        const tick = (time: number) => {
          if (lastTime) {
            elapsed += time - lastTime
            while (elapsed >= step) {
              elapsed -= step
              frameIndex = (frameIndex + 1) % loaded.frames.length
              drawFrame(canvas, loaded, frameIndex)
            }
          }
          lastTime = time
          requestId = requestAnimationFrame(tick)
        }
        requestId = requestAnimationFrame(tick)
      })
      .catch((error) => {
        console.error('[agent-island] mascot sprite failed to load', error)
      })

    return () => {
      disposed = true
      cancelAnimationFrame(requestId)
    }
  }, [sprite.animate, sprite.name])

  return (
    <canvas
      ref={canvasRef}
      className="island-mascot"
      aria-hidden="true"
      style={{ width: SIZE, height: SIZE, flexShrink: 0 }}
    />
  )
}
