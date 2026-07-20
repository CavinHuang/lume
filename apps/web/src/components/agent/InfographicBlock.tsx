import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy, Download, Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  isDesktopRuntime,
  saveFilePathDialog,
  saveTextFileDialog,
  writeBinaryFile,
  writeClipboardImage,
  writeClipboardText,
} from '@/lib/desktop-api'
import {
  InfographicSyntaxError,
  LUME_INFOGRAPHIC_FONT_FAMILY,
  prepareInfographic,
  type PreparedInfographic,
} from './infographic-syntax'
import type { InfographicSyntaxRuntime } from './infographic-syntax'
import type { Font, InfographicOptions } from '@antv/infographic'

export interface InfographicBlockProps {
  code: string
  streaming: boolean
}

export interface InfographicInstance {
  rendered: boolean
  render: (options?: string | Partial<InfographicOptions>) => void
  toDataURL: (options: { type: 'svg'; embedResources: boolean } | { type: 'png'; dpr: number }) => Promise<string>
  destroy: () => void
}

interface InfographicRenderRuntime extends InfographicSyntaxRuntime {
  Infographic: new (options: Record<string, unknown>) => InfographicInstance
}

interface InfographicRuntimeModule extends InfographicRenderRuntime {
  getFonts: () => Font[]
  registerFont: (font: Font) => Font
  setDefaultFont: (font: string) => void
}

interface RenderInfographicInput {
  runtime: InfographicRenderRuntime
  code: string
  streaming: boolean
  container: Element
  previous?: InfographicInstance | null
}

const RENDER_DEBOUNCE_MS = 150
const INFOGRAPHIC_BROWSER_RUNTIME_URL = new URL(
  '../../../node_modules/@antv/infographic/dist/infographic.min.js',
  import.meta.url,
).href
const INFOGRAPHIC_BROWSER_SCRIPT_ID = 'lume-antv-infographic-runtime'

let infographicRuntimePromise: Promise<InfographicRuntimeModule> | null = null

function loadInfographicRuntime(): Promise<InfographicRuntimeModule> {
  const runtimeWindow = window as Window & { AntVInfographic?: InfographicRuntimeModule }
  if (runtimeWindow.AntVInfographic) {
    configureInfographicRuntime(runtimeWindow.AntVInfographic)
    return Promise.resolve(runtimeWindow.AntVInfographic)
  }

  infographicRuntimePromise ??= new Promise<InfographicRuntimeModule>((resolve, reject) => {
    const existing = document.getElementById(INFOGRAPHIC_BROWSER_SCRIPT_ID) as HTMLScriptElement | null
    existing?.remove()
    const script = document.createElement('script')
    const handleLoad = () => {
      const runtime = runtimeWindow.AntVInfographic
      if (!runtime) {
        reject(new Error('AntV Infographic 浏览器运行时加载失败'))
        return
      }
      configureInfographicRuntime(runtime)
      resolve(runtime)
    }
    const handleError = () => reject(new Error('无法加载 AntV Infographic 浏览器运行时'))

    script.addEventListener('load', handleLoad, { once: true })
    script.addEventListener('error', handleError, { once: true })
    script.id = INFOGRAPHIC_BROWSER_SCRIPT_ID
    script.src = INFOGRAPHIC_BROWSER_RUNTIME_URL
    script.async = true
    document.head.appendChild(script)
  }).catch((error) => {
    infographicRuntimePromise = null
    throw error
  })
  return infographicRuntimePromise
}

export function configureInfographicRuntime(
  runtime: Pick<InfographicRuntimeModule, 'getFonts' | 'registerFont' | 'setDefaultFont'>,
): void {
  // AntV 0.2.x registers remote font stylesheets by default. Lume already bundles
  // Geist and supplies CJK system fallbacks, so remove only the network sources.
  for (const font of runtime.getFonts()) {
    runtime.registerFont({
      ...font,
      fontFamily: font.fontFamily.replace(/^(["'])(.*)\1$/, '$2'),
      baseUrl: '',
      fontWeight: {},
    })
  }
  runtime.setDefaultFont(LUME_INFOGRAPHIC_FONT_FAMILY)
}

export function InfographicBlock({ code, streaming }: InfographicBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<InfographicInstance | null>(null)
  const generationRef = useRef(0)
  const hasSuccessfulRenderRef = useRef(false)
  const preparedRef = useRef<PreparedInfographic | null>(null)
  const [status, setStatus] = useState<'rendering' | 'ready' | 'error'>('rendering')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'svg' | 'png' | null>(null)
  const [copying, setCopying] = useState<'dsl' | 'svg' | 'png' | null>(null)
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false)

  useEffect(() => {
    const generation = ++generationRef.current
    setStatus('rendering')
    setErrorMessage(null)

    const timeoutId = window.setTimeout(() => {
      void loadInfographicRuntime()
        .then((runtime) => {
          if (generation !== generationRef.current || !containerRef.current) return
          const { instance: nextInstance, prepared } = renderInfographic({
            runtime,
            code,
            streaming,
            container: containerRef.current,
            previous: instanceRef.current,
          })
          if (generation !== generationRef.current) {
            nextInstance.destroy()
            return
          }

          instanceRef.current = nextInstance
          preparedRef.current = prepared
          hasSuccessfulRenderRef.current = true
          setStatus('ready')
        })
        .catch((error) => {
          if (generation !== generationRef.current) return
          const message = error instanceof Error ? error.message : String(error)
          if (streaming && hasSuccessfulRenderRef.current) {
            setStatus('ready')
            return
          }
          setStatus('error')
          setErrorMessage(message)
        })
    }, RENDER_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [code, streaming])

  useEffect(() => () => {
    generationRef.current += 1
    instanceRef.current?.destroy()
    instanceRef.current = null
  }, [])

  const handleCopyDsl = async () => {
    if (copying) return
    setCopying('dsl')
    try {
      await copyInfographicDsl(code, writeClipboardText)
      toast.success('已复制信息图 DSL')
    } catch (error) {
      console.error('[InfographicBlock] 复制 DSL 失败:', error)
      toast.error('复制失败')
    } finally {
      setCopying(null)
    }
  }

  const handleCopyImage = async (type: 'svg' | 'png') => {
    const instance = instanceRef.current
    if (!instance || copying) return
    setCopying(type)
    try {
      if (type === 'svg') {
        const dataUrl = await instance.toDataURL({ type: 'svg', embedResources: true })
        await writeClipboardText(svgDataUrlToText(dataUrl))
        toast.success('已复制 SVG 源码')
      } else {
        const dataUrl = await instance.toDataURL({ type: 'png', dpr: 2 })
        await writeClipboardImage({ dataUrl })
        toast.success('已复制 PNG 图片')
      }
    } catch (error) {
      console.error(`[InfographicBlock] 复制 ${type.toUpperCase()} 失败:`, error)
      toast.error('复制失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setCopying(null)
    }
  }

  const handleExport = async (type: 'svg' | 'png') => {
    const instance = instanceRef.current
    const prepared = preparedRef.current
    if (!instance || !prepared || exporting) return
    setExporting(type)
    try {
      const filename = `${sanitizeInfographicFilename(prepared.title)}.${type}`
      const dataUrl = type === 'svg'
        ? await instance.toDataURL({ type: 'svg', embedResources: true })
        : await instance.toDataURL({ type: 'png', dpr: 2 })

      if (isDesktopRuntime()) {
        if (type === 'svg') {
          const result = await saveTextFileDialog(filename, svgDataUrlToText(dataUrl))
          toast.success('信息图已导出', { description: result.path })
        } else {
          const selected = await saveFilePathDialog(filename, [{ name: 'PNG 图片', extensions: ['png'] }])
          if (!selected.path) return
          const result = await writeBinaryFile(selected.path, dataUrlToBase64(dataUrl))
          toast.success('信息图已导出', { description: result.path })
        }
      } else {
        downloadDataUrl(dataUrl, filename)
        toast.success('信息图已导出')
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('取消')) return
      console.error(`[InfographicBlock] 导出 ${type.toUpperCase()} 失败:`, error)
      toast.error('导出失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setExporting(null)
    }
  }

  const hasRendered = hasSuccessfulRenderRef.current
  const showSource = !hasRendered || (status === 'error' && !streaming)
  const canExport = hasRendered && status === 'ready'

  return (
    <section className="group/infographic relative my-3 overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)]">
      <div
        className={cn(
          'absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-1 shadow-sm transition-opacity',
          copyMenuOpen || downloadMenuOpen
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover/infographic:pointer-events-auto group-hover/infographic:opacity-100 group-focus-within/infographic:pointer-events-auto group-focus-within/infographic:opacity-100',
        )}
      >
        <DropdownMenu open={copyMenuOpen} onOpenChange={setCopyMenuOpen}>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="xs" type="button" disabled={copying !== null} title="复制信息图" />}
          >
            {copying ? <Loader2 className="animate-spin" /> : <Copy />}
            <span>复制</span>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void handleCopyDsl()}>复制 DSL</DropdownMenuItem>
            <DropdownMenuItem disabled={!canExport} onSelect={() => void handleCopyImage('svg')}>复制 SVG 源码</DropdownMenuItem>
            <DropdownMenuItem disabled={!canExport} onSelect={() => void handleCopyImage('png')}>复制 PNG 图片（2×）</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu open={downloadMenuOpen} onOpenChange={setDownloadMenuOpen}>
          <DropdownMenuTrigger
            render={(
              <Button
                variant="ghost"
                size="xs"
                type="button"
                disabled={!canExport || exporting !== null}
                title="下载信息图"
              />
            )}
          >
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            <span>下载</span>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void handleExport('svg')}>下载 SVG</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleExport('png')}>下载 PNG（2×）</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative min-h-32 bg-white p-3 dark:bg-neutral-950">
        <div
          ref={containerRef}
          aria-hidden={showSource}
          className={cn(
            'overflow-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-h-[720px] [&_svg]:max-w-full [&_svg]:w-full',
            showSource && 'pointer-events-none absolute inset-3 opacity-0',
          )}
          aria-label="信息图预览"
        />
        {showSource && (
          <pre className="m-0 max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-transparent p-2 text-xs text-[var(--lume-text-secondary)]">
            <code>{code}</code>
          </pre>
        )}
      </div>

      {status === 'error' && errorMessage && (
        <div className="flex items-start gap-2 border-t border-[var(--lume-border-subtle)] px-3 py-2 text-xs text-[var(--lume-danger)]">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>信息图渲染失败：{errorMessage}</span>
        </div>
      )}
    </section>
  )
}

export function renderInfographic(input: RenderInfographicInput): {
  instance: InfographicInstance
  prepared: PreparedInfographic
} {
  const prepared = prepareInfographic(input.code, input.runtime, { enableIcons: !input.streaming })
  const renderOptions = {
    ...prepared.options,
    container: input.container,
  }

  if (input.previous) {
    // Reuse AntV's render(options) streaming path so the last successful SVG
    // remains mounted while an incomplete chunk is being parsed.
    input.previous.render(renderOptions)
    return { instance: input.previous, prepared }
  }

  const instance = new input.runtime.Infographic({
    ...renderOptions,
  })
  instance.render()
  if (!instance.rendered) {
    instance.destroy()
    throw new InfographicSyntaxError('信息图数据不完整，暂时无法渲染')
  }
  return { instance, prepared }
}

export async function copyInfographicDsl(
  code: string,
  writer: (text: string) => Promise<void>,
): Promise<void> {
  await writer(code)
}

export function sanitizeInfographicFilename(title: string): string {
  const sanitized = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80)
  if (!sanitized) return 'lume-infographic'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)
    ? `lume-${sanitized}`
    : sanitized
}

export function svgDataUrlToText(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:image/svg+xml') || commaIndex < 0) throw new Error('无效的 SVG 导出数据')
  const metadata = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (metadata.includes(';base64')) {
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  return decodeURIComponent(payload)
}

export function dataUrlToBase64(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/)
  if (!match?.[1]) throw new Error('无效的 PNG 导出数据')
  return match[1]
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()
}
