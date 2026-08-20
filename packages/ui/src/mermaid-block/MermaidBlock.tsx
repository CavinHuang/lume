/**
 * MermaidBlock - Mermaid 图表渲染组件
 *
 * 使用 beautiful-mermaid 将 mermaid 源码渲染为 SVG 图表。
 *
 * 核心策略 —— "源码优先，SVG 覆盖淡入"：
 *
 * 布局结构（关键：源码层永远在文档流中，SVG 层永远 absolute）：
 *   <div relative>
 *     <pre>源码（始终 static，提供稳定高度）</pre>
 *     <div absolute inset-0>SVG 覆盖层（不参与布局）</div>
 *   </div>
 *
 * 渲染时序：
 *   流式输出 → 源码自然增长（零跳动）
 *   code 稳定 350ms → 后台 renderMermaid
 *   成功 → SVG 淡入覆盖，源码淡出（一次性过渡）
 *   失败 → 保持源码展示
 *
 * 防竞态：generation 计数器，只有最新一代的渲染结果才会生效
 */

import * as React from 'react'
import DOMPurify from 'dompurify'
import { renderMermaid, THEMES } from 'beautiful-mermaid'
import type { RenderOptions } from 'beautiful-mermaid'

interface MermaidBlockProps {
  /** mermaid 源码 */
  code: string
  /** 由宿主注入剪贴板写入，避免共享组件绕过桌面 IPC */
  onCopy: (code: string) => Promise<void>
  /** 由宿主将 SVG 栅格化后写入系统图片剪贴板 */
  onCopyImage: (svg: string) => Promise<void>
  /** 由宿主使用当前 SVG 打开大屏预览 */
  onPreview?: (svg: string) => void
}

/** 防抖间隔（ms） */
const DEBOUNCE_MS = 350
/** 淡入淡出时长（ms） */
const FADE_MS = 250
/** 缩放范围 */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 0.15
const HEIGHT_MIN = 220
const HEIGHT_MAX = 1200

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark')
}

function getThemeOptions(): RenderOptions {
  const colors = isDarkMode() ? THEMES['github-dark'] : THEMES['github-light']
  return colors ? { ...colors } : {}
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// ===== 图标（与 CodeBlock 一致） =====

const ICON_ATTRS = {
  width: 14, height: 14, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}
const copyIconPath = (
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
)
const checkIconPath = <polyline points="20 6 9 17 4 12" />
const imageIconPath = (
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </>
)
const previewIconPath = (
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>
)
const zoomInPath = (
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </>
)
const zoomOutPath = (
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </>
)

// ===== 缩放平移 =====

interface ViewTransform {
  scale: number
  translateX: number
  translateY: number
}
const INITIAL_TRANSFORM: ViewTransform = { scale: 1, translateX: 0, translateY: 0 }

// ===== 主组件 =====

export async function copyMermaidCode(
  code: string,
  onCopy: (code: string) => Promise<void>,
): Promise<void> {
  await onCopy(code)
}

export async function copyMermaidImage(
  svg: string,
  onCopyImage: (svg: string) => Promise<void>,
): Promise<void> {
  await onCopyImage(svg)
}

export function getResizedMermaidHeight(startHeight: number, deltaY: number): number {
  return clamp(startHeight + deltaY, HEIGHT_MIN, HEIGHT_MAX)
}

export function stripStylesheetImports(svg: string): string {
  // CSS 规范允许字符串形式 @import "foo.css";（不带 url()），两种形式都要剥。
  // 要求 @import 后紧跟空白 + url(/引号，避免误杀节点标签里的 user@important.com 之类文本。
  return svg.replace(/@import\s+(?:url\([^)]*\)|'[^']*'|"[^"]*")\s*;?/gi, '')
}

/**
 * mermaid SVG 消毒配置。svg+html 双 profile + ADD_TAGS foreignObject：
 * flowchart/gantt 等图类的标签文字靠 foreignObject 内的 div/span 渲染，纯 svg
 * profile 不含 foreignObject（且在其黑名单内）会把文字整块剥掉。导出供配置守卫测试。
 */
export const MERMAID_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['foreignObject'],
}

/**
 * mermaid SVG 注入 innerHTML 前的 DOMPurify 二层防御。
 * dompurify 的 default 实例在模块加载时按 window 求值——加载早于 window 的环境
 * （CI bun 对动态 import 的求值时机差异）实例不可用，此时原样返回（浏览器恒可用）。
 */
export function sanitizeMermaidSvg(svg: string): string {
  if (typeof window === 'undefined' || typeof DOMPurify?.sanitize !== 'function') return svg
  return DOMPurify.sanitize(svg, MERMAID_SANITIZE_CONFIG)
}

export function MermaidBlock({ code, onCopy, onCopyImage, onPreview }: MermaidBlockProps): React.ReactElement {
  const [svgHtml, setSvgHtml] = React.useState<string | null>(null)
  const [svgVisible, setSvgVisible] = React.useState(false)
  const [copied, setCopied] = React.useState<'code' | 'image' | null>(null)
  const [contentHeight, setContentHeight] = React.useState<number | null>(null)
  const [transform, setTransform] = React.useState<ViewTransform>(INITIAL_TRANSFORM)

  const codeRef = React.useRef(code)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** generation 计数器：每次 code 变化递增，防止异步竞态 */
  const generationRef = React.useRef(0)
  const dragRef = React.useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(null)
  const svgContainerRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const resizeRef = React.useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)

  codeRef.current = code

  // ==== 唯一的渲染 effect：全部走防抖，generation 防竞态 ====
  React.useEffect(() => {
    // 每次 code 变化递增 generation，作废所有旧的异步渲染
    generationRef.current++
    const currentGen = generationRef.current
    setSvgHtml(null)
    setSvgVisible(false)
    setTransform(INITIAL_TRANSFORM)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const svg = sanitizeMermaidSvg(stripStylesheetImports(await renderMermaid(codeRef.current, getThemeOptions())))
        // 只有最新一代的结果才生效，旧的全部丢弃
        if (generationRef.current !== currentGen) return
        if (typeof svg === 'string' && svg.length > 0) {
          setSvgHtml(svg)
          requestAnimationFrame(() => setSvgVisible(true))
        }
      } catch {
        // 渲染失败 → 保持源码展示（不做任何操作）
      }
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [code])

  // ---- 主题变化：重新渲染当前 code ----
  React.useEffect(() => {
    const observer = new MutationObserver(async () => {
      generationRef.current++
      const gen = generationRef.current
      try {
        const svg = sanitizeMermaidSvg(stripStylesheetImports(await renderMermaid(codeRef.current, getThemeOptions())))
        if (generationRef.current !== gen) return
        if (typeof svg === 'string' && svg.length > 0) {
          setSvgHtml(svg)
          setSvgVisible(true)
        }
      } catch { /* 忽略 */ }
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // ---- 滚轮缩放 ----
  React.useEffect(() => {
    const el = svgContainerRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      setTransform((prev) => ({
        ...prev,
        scale: clamp(prev.scale + (e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP), ZOOM_MIN, ZOOM_MAX),
      }))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [svgVisible])

  // ---- 拖拽平移 ----
  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startTx: transform.translateX, startTy: transform.translateY,
    }
    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const translateX = drag.startTx + ev.clientX - drag.startX
      const translateY = drag.startTy + ev.clientY - drag.startY
      setTransform((prev) => ({
        ...prev,
        translateX,
        translateY,
      }))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [transform.translateX, transform.translateY])

  const handleZoomIn = React.useCallback(() => {
    setTransform((prev) => ({ ...prev, scale: clamp(prev.scale + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX) }))
  }, [])
  const handleZoomOut = React.useCallback(() => {
    setTransform((prev) => ({ ...prev, scale: clamp(prev.scale - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX) }))
  }, [])
  const handleZoomReset = React.useCallback(() => setTransform(INITIAL_TRANSFORM), [])

  const handleCopy = React.useCallback(async () => {
    try {
      await copyMermaidCode(code, onCopy)
      setCopied('code')
      setTimeout(() => setCopied(null), 2000)
    } catch (error) {
      console.error('[MermaidBlock] 复制失败:', error)
    }
  }, [code, onCopy])

  const handleCopyImage = React.useCallback(async () => {
    if (!svgHtml) return
    try {
      await copyMermaidImage(svgHtml, onCopyImage)
      setCopied('image')
      setTimeout(() => setCopied(null), 2000)
    } catch (error) {
      console.error('[MermaidBlock] 复制图片失败:', error)
    }
  }, [onCopyImage, svgHtml])

  const handleResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !contentRef.current) return
    event.preventDefault()
    resizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: contentRef.current.getBoundingClientRect().height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handleResizeMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    setContentHeight(getResizedMermaidHeight(resize.startHeight, event.clientY - resize.startY))
  }, [])

  const handleResizeEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const zoomPercent = Math.round(transform.scale * 100)

  return (
    <div className="mermaid-block-wrapper group/mermaid rounded-lg overflow-hidden my-2 border border-border/50">
      {/* 头部栏 */}
      <div className="flex items-center justify-between h-[34px] px-2 py-1 bg-muted/60 text-muted-foreground text-xs">
        <span className="font-medium select-none">Mermaid</span>
        <div className="flex items-center gap-1">
          {svgVisible && (
            <div className="flex items-center gap-0.5 mr-2">
              <button type="button" onClick={handleZoomOut} className="p-0.5 rounded hover:bg-foreground/10 transition-colors" title="缩小">
                <svg {...ICON_ATTRS}>{zoomOutPath}</svg>
              </button>
              <button type="button" onClick={handleZoomReset} className="px-1 py-0.5 rounded hover:bg-foreground/10 transition-colors min-w-[40px] text-center tabular-nums" title="重置缩放">
                {zoomPercent}%
              </button>
              <button type="button" onClick={handleZoomIn} className="p-0.5 rounded hover:bg-foreground/10 transition-colors" title="放大">
                <svg {...ICON_ATTRS}>{zoomInPath}</svg>
              </button>
            </div>
          )}
          {svgVisible && onPreview && (
            <button
              type="button"
              onClick={() => svgHtml && onPreview(svgHtml)}
              className="p-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
              title="大屏预览"
              aria-label="大屏预览 Mermaid 图表"
            >
              <svg {...ICON_ATTRS}>{previewIconPath}</svg>
            </button>
          )}
          {svgVisible && (
            <button type="button" onClick={handleCopyImage} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground">
              <svg {...ICON_ATTRS}>{copied === 'image' ? checkIconPath : imageIconPath}</svg>
              <span>{copied === 'image' ? '已复制' : '复制图片'}</span>
            </button>
          )}
          <button type="button" onClick={handleCopy} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground">
            <svg {...ICON_ATTRS}>{copied === 'code' ? checkIconPath : copyIconPath}</svg>
            <span>{copied === 'code' ? '已复制' : '复制源码'}</span>
          </button>
        </div>
      </div>

      {/*
        内容区 —— 双层叠加，永不切换 position
        源码层：永远 static（提供稳定高度，零跳动）
        SVG 层：永远 absolute（不影响布局）
        两层只通过 opacity 交叉淡入淡出
      */}
      <div
        ref={contentRef}
        className="relative overflow-hidden"
        style={{ height: contentHeight ?? 'clamp(280px,45vw,520px)' }}
      >
        {/* 源码层 —— 始终在文档流中，流式输出时自然增长 */}
        <pre
          className="h-full overflow-auto p-4 m-0 text-ui leading-[1.8] bg-muted/30 text-foreground/80"
          style={{
            opacity: svgVisible ? 0 : 1,
            transition: `opacity ${FADE_MS}ms ease`,
          }}
        >
          <code>{code}</code>
        </pre>

        {/* SVG 层 —— absolute 覆盖，渲染成功后淡入，不影响文档流 */}
        {svgHtml && (
          <div
            ref={svgContainerRef}
            className="absolute inset-0 bg-background overflow-hidden select-none"
            style={{
              opacity: svgVisible ? 1 : 0,
              transition: `opacity ${FADE_MS}ms ease`,
              cursor: svgVisible ? 'grab' : 'default',
              pointerEvents: svgVisible ? 'auto' : 'none',
            }}
            onMouseDown={svgVisible ? handleMouseDown : undefined}
          >
            <div
              className="flex h-full justify-center items-center p-4 origin-center"
              style={{
                transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`,
              }}
            >
              <div
                className="mermaid-svg flex h-full w-full items-center justify-center [&>svg]:max-h-full [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:w-auto"
                dangerouslySetInnerHTML={{ __html: svgHtml }}
              />
            </div>
          </div>
        )}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整 Mermaid 图表高度"
        className="group/resize flex h-2 touch-none cursor-row-resize items-center justify-center bg-muted/30"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      >
        <span className="h-0.5 w-10 rounded-full bg-foreground/15 transition-colors group-hover/resize:bg-foreground/30" />
      </div>
    </div>
  )
}
