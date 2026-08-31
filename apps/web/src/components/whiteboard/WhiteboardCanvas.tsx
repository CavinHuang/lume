/**
 * 白板画布 —— ZCode `bn`(Q2 §1)的 pointer 涂鸦面。
 *
 * 规格:固定 1280×800 逻辑尺寸(16:10)白底,devicePixelRatio 缩放;
 * setPointerCapture 实时拖绘,draft stroke 仅本地预渲,onPointerUp 才提交;
 * 橡皮 = 画白线(source-over + 底色),非真擦除(ZCode 同款)。
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  eraserWidth,
  type WhiteboardBoard,
  type WhiteboardPoint,
  type WhiteboardStroke,
  type WhiteboardTool,
} from './whiteboard-store'

const BACKGROUND_COLOR = '#ffffff'

interface WhiteboardCanvasProps {
  board: WhiteboardBoard
  tool: WhiteboardTool
  color: string
  width: number
  /** 提交一笔(onPointerUp);由宿主写入 store。 */
  onCommitStroke: (stroke: Omit<WhiteboardStroke, 'id'>) => void
}

export function WhiteboardCanvas({ board, tool, color, width, onCommitStroke }: WhiteboardCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const draftRef = useRef<WhiteboardStroke | null>(null)
  const sizeRef = useRef({ tool, color, width })
  sizeRef.current = { tool, color, width }

  const drawStroke = useCallback((context: CanvasRenderingContext2D, stroke: WhiteboardStroke) => {
    if (stroke.points.length === 0) return
    context.globalCompositeOperation = 'source-over'
    context.strokeStyle = stroke.tool === 'eraser' ? BACKGROUND_COLOR : stroke.color
    context.lineWidth = stroke.tool === 'eraser' ? eraserWidth(stroke.width) : stroke.width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    const first = stroke.points[0]!
    context.moveTo(first.x, first.y)
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y)
    if (stroke.points.length === 1) context.lineTo(first.x + 0.01, first.y)
    context.stroke()
  }, [])

  // 重绘(幂等):DPR 缩放后铺底色 + 重放已提交 strokes;board 任何变更触发。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== board.width * dpr || canvas.height !== board.height * dpr) {
      canvas.width = board.width * dpr
      canvas.height = board.height * dpr
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = BACKGROUND_COLOR
    context.fillRect(0, 0, board.width, board.height)
    for (const stroke of board.strokes) drawStroke(context, stroke)
  }, [board, drawStroke])

  const toBoardPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>): WhiteboardPoint => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * board.width,
      y: ((event.clientY - rect.top) / rect.height) * board.height,
    }
  }, [board.width, board.height])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const size = sizeRef.current
    draftRef.current = {
      id: '',
      tool: size.tool,
      color: size.color,
      width: size.width,
      points: [toBoardPoint(event)],
    }
  }, [toBoardPoint])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!draft || !canvas || !context) return
    draft.points.push(toBoardPoint(event))
    // 实时预渲:全量重绘已提交 + draft(笔画量级下可接受;增量路径可后续优化)。
    context.fillStyle = BACKGROUND_COLOR
    context.fillRect(0, 0, board.width, board.height)
    for (const stroke of board.strokes) drawStroke(context, stroke)
    drawStroke(context, draft)
  }, [board.strokes, board.width, board.height, drawStroke, toBoardPoint])

  const handlePointerUp = useCallback(() => {
    const draft = draftRef.current
    draftRef.current = null
    if (draft) onCommitStroke({ tool: draft.tool, color: draft.color, width: draft.width, points: draft.points })
  }, [onCommitStroke])

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full rounded-md border border-[var(--lume-border-subtle)] bg-white shadow-sm"
        style={{ aspectRatio: `${board.width} / ${board.height}`, touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  )
}
