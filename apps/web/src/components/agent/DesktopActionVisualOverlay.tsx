import { useAtomValue } from 'jotai'
import { Check, CircleAlert, MousePointer2, Sparkles } from 'lucide-react'
import { desktopActionVisualAtom } from '@/atoms'
import type { DesktopActionKind } from '@lume/shared'
import type { DesktopActionVisualOverlayState } from '@/hooks/desktop-action-visual-state'

const OFFICIAL_CURSOR_ARTWORK_URL = new URL(
  '../../../../../crates/lume-desktop-host/assets/official-software-cursor-window-252.png',
  import.meta.url,
).href

const ACTION_LABELS: Record<DesktopActionKind, string> = {
  launch_app: '启动应用',
  activate_window: '切换窗口',
  move_pointer: '移动鼠标',
  click: '点击',
  press_key: '按键',
  type_text: '输入内容',
  scroll: '滚动页面',
  set_value: '填写内容',
  drag: '拖拽',
  perform_secondary_action: '执行更多操作',
}

export function DesktopActionVisualOverlay() {
  const state = useAtomValue(desktopActionVisualAtom)
  return state ? <DesktopActionVisualOverlayFrame state={state} /> : null
}

export function DesktopActionVisualOverlayFrame({
  state,
}: {
  state: DesktopActionVisualOverlayState
}) {
  const completed = state.phase === 'completed'
  const failed = state.phase === 'failed'
  const title = completed ? '操作完成' : failed ? '操作未完成' : 'Lume 正在操作'
  const detail = `${ACTION_LABELS[state.action]}${state.targetLabel ? ` · ${state.targetLabel}` : ''}`
  const frameClassName = failed
    ? 'border-red-300/60 bg-[#321515]/95 shadow-[0_18px_55px_rgba(80,7,18,0.34)]'
    : completed
      ? 'border-emerald-200/60 bg-[#102a20]/95 shadow-[0_18px_55px_rgba(3,45,25,0.34)]'
      : 'border-[#9ee9d8]/70 bg-[#102a2a]/95 shadow-[0_18px_55px_rgba(3,34,32,0.38)]'
  const iconClassName = failed
    ? 'bg-red-100 text-red-700 shadow-[0_0_24px_rgba(255,127,127,0.26)]'
    : 'bg-[#caffec] text-[#0d574c] shadow-[0_0_24px_rgba(127,255,218,0.34)]'
  const trail = buildTrail(state.path)
  const stage = buildStageTrail(state.path, state.point)

  return (
    <>
      {stage ? (
        <div
          data-desktop-action-stage="true"
          className="pointer-events-none fixed inset-0 z-[119] overflow-hidden"
          aria-hidden="true"
        >
          {stage.pathD ? (
            <svg className="absolute inset-0 size-full" role="presentation">
              <path d={stage.pathD} fill="none" stroke="rgba(186,255,237,0.18)" strokeWidth="10" strokeLinecap="round" />
              <path
                data-desktop-action-stage-trail="true"
                d={stage.pathD}
                fill="none"
                stroke="#baffed"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray="8 10"
              />
            </svg>
          ) : null}
          <span
            className="absolute size-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#baffed]/10 blur-xl"
            style={{ left: `${stage.cursor.x}px`, top: `${stage.cursor.y}px` }}
          />
          <img
            data-desktop-action-stage-cursor="true"
            data-desktop-action-cursor-artwork="open-codex-computer-use"
            src={OFFICIAL_CURSOR_ARTWORK_URL}
            alt=""
            draggable={false}
            className="absolute size-10 select-none drop-shadow-[0_0_18px_rgba(186,255,237,0.72)]"
            style={{ left: `${stage.cursor.x - 3}px`, top: `${stage.cursor.y - 3}px` }}
          />
        </div>
      ) : null}
      <div
        className="pointer-events-none fixed inset-x-0 top-12 z-[120] flex justify-center px-4"
        aria-live="polite"
        aria-label={`${title} ${state.appName}`}
      >
        <div
          data-phase={state.phase}
          className={`relative flex min-w-[300px] max-w-[min(520px,calc(100vw-32px))] items-center gap-3 overflow-hidden rounded-[18px] border px-3.5 py-3 text-white ${frameClassName} backdrop-blur-xl`}
        >
          <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[#b8ffe7] to-transparent" />
          <span className={`relative grid size-10 shrink-0 place-items-center rounded-[13px] ${iconClassName}`}>
            {completed ? <Check size={19} strokeWidth={2.5} /> : failed ? <CircleAlert size={19} /> : <Sparkles size={18} className="animate-pulse" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[13px] font-semibold tracking-[0.01em]">
              {title}
              <span className="truncate rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-[#d6fff2]">
                {state.appName}
              </span>
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px] text-white/65">
              <span className="truncate">{detail}</span>
              {state.status ? (
                <span className="shrink-0 rounded-full border border-white/10 bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-white/70">
                  {state.status}
                </span>
              ) : null}
            </span>
          </span>
          {trail ? (
            <span
              data-desktop-action-trail="true"
              className="relative h-12 w-20 shrink-0 overflow-hidden rounded-[14px] border border-[#bfffea]/20 bg-black/25"
              aria-hidden="true"
            >
              <svg className="absolute inset-0 size-full" viewBox="0 0 80 48" role="presentation">
                <path d={trail.pathD} fill="none" stroke="rgba(190,255,234,0.35)" strokeWidth="5" strokeLinecap="round" />
                <path d={trail.pathD} fill="none" stroke="#baffed" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 5" />
              </svg>
              <img
                data-desktop-action-cursor="true"
                data-desktop-action-cursor-artwork="open-codex-computer-use"
                src={OFFICIAL_CURSOR_ARTWORK_URL}
                alt=""
                draggable={false}
                className="absolute size-7 select-none drop-shadow-[0_0_10px_rgba(186,255,237,0.75)]"
                style={{ left: `${trail.cursor.x}px`, top: `${trail.cursor.y}px` }}
              />
            </span>
          ) : null}
          <span className="relative flex shrink-0 items-center gap-1.5 rounded-full border border-[#bfffea]/25 bg-black/20 px-2.5 py-1.5 text-[10px] font-medium text-[#d7fff4]">
            <MousePointer2 size={14} className={state.phase === 'started' ? 'animate-pulse' : ''} />
            <span>代理鼠标</span>
            {state.point && <span className="font-mono text-white/45">{Math.round(state.point.x)},{Math.round(state.point.y)}</span>}
          </span>
        </div>
      </div>
    </>
  )
}

function buildStageTrail(
  path: DesktopActionVisualOverlayState['path'],
  point: DesktopActionVisualOverlayState['point'],
): { pathD?: string; cursor: { x: number; y: number } } | undefined {
  const points = path && path.length >= 2 ? path : point ? [point] : []
  const cursor = points[points.length - 1]
  if (!cursor) return undefined
  return {
    ...(points.length >= 2
      ? { pathD: curvedPathD(points) }
      : {}),
    cursor,
  }
}

function buildTrail(path: DesktopActionVisualOverlayState['path']): { pathD: string; cursor: { x: number; y: number } } | undefined {
  if (!path || path.length < 2) return undefined
  const xs = path.map((point) => point.x)
  const ys = path.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  const points = path.map((point) => ({
    x: 10 + ((point.x - minX) / width) * 56,
    y: 8 + ((point.y - minY) / height) * 30,
  }))
  const pathD = curvedPathD(points)
  const cursor = points[points.length - 1]
  return { pathD, cursor: { x: cursor.x - 2, y: cursor.y - 2 } }
}

function curvedPathD(points: Array<{ x: number; y: number }>): string {
  const [first, ...rest] = points
  if (!first) return ''
  let path = `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`
  let previous = first
  rest.forEach((point, index) => {
    const curve = curveControls(previous, point, index)
    path += ` C ${curve.c1.x.toFixed(1)} ${curve.c1.y.toFixed(1)} ${curve.c2.x.toFixed(1)} ${curve.c2.y.toFixed(1)} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    previous = point
  })
  return path
}

function curveControls(
  from: { x: number; y: number },
  to: { x: number; y: number },
  index: number,
): { c1: { x: number; y: number }; c2: { x: number; y: number } } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  const arc = Math.min(140, Math.max(18, distance * 0.24)) * (index % 2 === 0 ? 1 : -1)
  const normal = { x: -dy / distance, y: dx / distance }
  return {
    c1: {
      x: from.x + dx * 0.36 + normal.x * arc,
      y: from.y + dy * 0.36 + normal.y * arc,
    },
    c2: {
      x: from.x + dx * 0.76 + normal.x * arc,
      y: from.y + dy * 0.76 + normal.y * arc,
    },
  }
}
