/**
 * 白板面板 —— ZCode `WDt`(Q2 §1)的 Lume 落法。
 *
 * 工具条:行内改名、pen/eraser、6 色盘、宽度滑条(2..18)、撤销/重做/清空、
 * 导出 PNG。偏差(ZCode「加入聊天」= composer PNG 附件 CustomEvent):Lume
 * composer 尚无附件暂存通道,先落地为 PNG 文件下载,接通道后切换。
 */
import { Download, Eraser, MessageSquarePlus, PenTool, Redo2, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveBinaryFileDialog } from '@/lib/desktop-api/native'
import { cn } from '@/lib/utils'
import {
  getWhiteboardBoard,
  getWhiteboardStoreVersion,
  WHITEBOARD_DEFAULT_COLOR,
  WHITEBOARD_DEFAULT_WIDTH,
  WHITEBOARD_MAX_WIDTH,
  WHITEBOARD_MIN_WIDTH,
  WHITEBOARD_PALETTE,
  subscribeWhiteboards,
  addWhiteboardStroke,
  clearWhiteboardBoard,
  redoWhiteboardStroke,
  renameWhiteboardBoard,
  undoWhiteboardStroke,
} from './whiteboard-store'
import { WhiteboardCanvas } from './WhiteboardCanvas'

interface WhiteboardPanelProps {
  workspaceKey: string
  boardId: string
  /** 改名后同步宿主(实例 tab 标题随 board 名)。 */
  onRename?: (name: string) => void
}

export function WhiteboardPanel({ workspaceKey, boardId, onRename }: WhiteboardPanelProps) {
  useSyncExternalStore(subscribeWhiteboards, getWhiteboardStoreVersion)
  const board = getWhiteboardBoard(workspaceKey, boardId)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [color, setColor] = useState<string>(WHITEBOARD_DEFAULT_COLOR)
  const [width, setWidth] = useState(WHITEBOARD_DEFAULT_WIDTH)
  const [renaming, setRenaming] = useState(false)

  const commitStroke = useCallback((stroke: Parameters<typeof addWhiteboardStroke>[2]) => {
    addWhiteboardStroke(workspaceKey, boardId, stroke)
  }, [boardId, workspaceKey])

  const exportPngDataUrl = useCallback((): string | null => {
    if (!board) return null
    const offscreen = document.createElement('canvas')
    offscreen.width = board.width
    offscreen.height = board.height
    const context = offscreen.getContext('2d')
    if (!context) return null
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, board.width, board.height)
    for (const stroke of board.strokes) {
      context.globalCompositeOperation = 'source-over'
      context.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color
      context.lineWidth = stroke.tool === 'eraser' ? Math.max(14, stroke.width * 3) : stroke.width
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      const first = stroke.points[0]
      if (!first) continue
      context.moveTo(first.x, first.y)
      for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y)
      if (stroke.points.length === 1) context.lineTo(first.x + 0.01, first.y)
      context.stroke()
    }
    return offscreen.toDataURL('image/png')
  }, [board])

  const exportPng = useCallback(() => {
    const dataUrl = exportPngDataUrl()
    if (!dataUrl || !board) return
    void saveBinaryFileDialog(`${board.name}.png`, dataUrl.slice(dataUrl.indexOf(',') + 1)).catch(() => undefined)
  }, [board, exportPngDataUrl])

  // 加入聊天(ZCode wn:派发 CustomEvent 由 composer 暂存为 PNG 附件);聊天未挂载时回退下载。
  const addToChat = useCallback(() => {
    const dataUrl = exportPngDataUrl()
    if (!dataUrl || !board) return
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const detail = { file: new File([bytes], `${board.name}.png`, { type: 'image/png' }), handled: false }
    window.dispatchEvent(new CustomEvent('lume:add-whiteboard-to-chat', { detail }))
    if (detail.handled) return
    void saveBinaryFileDialog(`${board.name}.png`, base64).catch(() => undefined)
  }, [board, exportPngDataUrl])

  const canUndo = useMemo(() => (board?.strokes.length ?? 0) > 0, [board?.strokes.length])
  const canRedo = useMemo(() => (board?.undoneStrokes.length ?? 0) > 0, [board?.undoneStrokes.length])

  if (!board) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--lume-text-muted)]">
        白板不存在或已被回收
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--lume-bg-panel)]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--lume-border-subtle)] px-2">
        {renaming ? (
          <Input
            defaultValue={board.name}
            autoFocus
            onBlur={(event) => {
              renameWhiteboardBoard(workspaceKey, boardId, event.target.value)
              onRename?.(event.target.value)
              setRenaming(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setRenaming(false)
            }}
            className="h-7 w-36 text-xs"
          />
        ) : (
          <button
            type="button"
            className="max-w-40 truncate rounded px-1 text-[13px] font-medium hover:bg-[color-mix(in_srgb,var(--lume-text-primary)_5%,transparent)]"
            title="点击重命名"
            onClick={() => setRenaming(true)}
          >
            {board.name}
          </button>
        )}
        <Button variant={tool === 'pen' ? 'secondary' : 'ghost'} size="icon-xs" type="button" title="画笔" onClick={() => setTool('pen')}>
          <PenTool size={13} />
        </Button>
        <Button variant={tool === 'eraser' ? 'secondary' : 'ghost'} size="icon-xs" type="button" title="橡皮" onClick={() => setTool('eraser')}>
          <Eraser size={13} />
        </Button>
        {WHITEBOARD_PALETTE.map((paletteColor) => (
          <button
            key={paletteColor}
            type="button"
            aria-label={`颜色 ${paletteColor}`}
            title={`颜色 ${paletteColor}`}
            onClick={() => { setColor(paletteColor); setTool('pen') }}
            className={cn(
              'size-3.5 shrink-0 rounded-full border',
              tool === 'pen' && color === paletteColor
                ? 'border-[var(--lume-text-primary)] ring-1 ring-[var(--lume-text-primary)]'
                : 'border-transparent',
            )}
            style={{ backgroundColor: paletteColor }}
          />
        ))}
        <input
          type="range"
          min={WHITEBOARD_MIN_WIDTH}
          max={WHITEBOARD_MAX_WIDTH}
          value={width}
          title={`笔宽 ${width}`}
          onChange={(event) => setWidth(Number(event.target.value))}
          className="w-16 shrink-0 accent-[var(--lume-text-primary)]"
        />
        <div className="flex-1" />
        <Button variant="ghost" size="icon-xs" type="button" title="撤销" disabled={!canUndo} onClick={() => undoWhiteboardStroke(workspaceKey, boardId)}>
          <Undo2 size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" type="button" title="重做" disabled={!canRedo} onClick={() => redoWhiteboardStroke(workspaceKey, boardId)}>
          <Redo2 size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" type="button" title="清空" disabled={!canUndo} onClick={() => clearWhiteboardBoard(workspaceKey, boardId)}>
          <Trash2 size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" type="button" title="加入聊天(导出 PNG 附件)" onClick={addToChat}>
          <MessageSquarePlus size={13} />
        </Button>
        <Button variant="ghost" size="icon-xs" type="button" title="导出 PNG" onClick={exportPng}>
          <Download size={13} />
        </Button>
      </div>
      <WhiteboardCanvas board={board} tool={tool} color={color} width={width} onCommitStroke={commitStroke} />
    </div>
  )
}
