import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAtom } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Globe,
  Highlighter,
  LockKeyhole,
  MessageSquarePlus,
  MonitorSmartphone,
  MoreHorizontal,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentBrowserAnchor,
  AgentBrowserAnnotationAttachment,
  AgentBrowserDesignChangeAttachment,
  AgentBrowserTabAttachment,
  BrowserHistoryEntry,
  BrowserTabDescriptor,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { browserRuntime, onBrowserEvent, writeClipboardText } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import { normalizeUrl } from './browser-url'
import { BrowserImportModal } from './BrowserImportModal'
import { browserPageDraftsAtom } from '@/atoms'

type AuxiliaryPanel = 'find' | 'device' | 'site' | 'more' | 'annotation' | 'tweaks' | null
type PageSelection = { anchor: AgentBrowserAnchor; originalStyles: Record<string, string> }
type ReviewOverlayResult =
  | { status: 'submit'; body: string }
  | { status: 'submit'; styles: Record<string, string> }
  | { status: 'cancel' }

export function BrowserShell({
  tabId,
  ownerThreadId,
  initialUrl = '',
  initialZoomFactor = 1,
  initialViewport,
  initialNavigationEntries,
  initialNavigationIndex,
  initialScrollPosition,
  surface,
  className,
  onUrlChange,
  onDescriptorChange,
}: {
  tabId: string
  ownerThreadId?: string
  initialUrl?: string
  initialZoomFactor?: number
  initialViewport?: BrowserTabDescriptor['viewport']
  initialNavigationEntries?: string[]
  initialNavigationIndex?: number
  initialScrollPosition?: { x: number; y: number }
  surface: 'main' | 'right-panel'
  className?: string
  onUrlChange?: (url: string) => void
  onDescriptorChange?: (descriptor: BrowserTabDescriptor) => void
}) {
  const [pageDrafts, setPageDrafts] = useAtom(browserPageDraftsAtom)
  const draftKey = `${ownerThreadId ?? 'unscoped'}:${tabId}`
  const initialDraft = pageDrafts[draftKey]
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const currentUrlRef = useRef(initialUrl)
  const initialStateRef = useRef({
    url: initialUrl,
    zoomFactor: initialZoomFactor,
    viewport: initialViewport,
    navigationEntries: initialNavigationEntries,
    navigationIndex: initialNavigationIndex,
    scrollPosition: initialScrollPosition,
  })
  const descriptorRef = useRef<BrowserTabDescriptor>(emptyDescriptor(tabId, initialUrl))
  const onUrlChangeRef = useRef(onUrlChange)
  const onDescriptorChangeRef = useRef(onDescriptorChange)
  const [descriptor, setDescriptor] = useState<BrowserTabDescriptor>(() => emptyDescriptor(tabId, initialUrl))
  const [address, setAddress] = useState(initialUrl)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [auxiliaryPanel, setAuxiliaryPanel] = useState<AuxiliaryPanel>(initialDraft?.purpose ?? null)
  const [importOpen, setImportOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState({ activeMatchOrdinal: 0, matches: 0 })
  const [suggestions, setSuggestions] = useState<BrowserHistoryEntry[]>([])
  const [addressFocused, setAddressFocused] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(390)
  const [viewportHeight, setViewportHeight] = useState(844)
  const [deviceScaleFactor, setDeviceScaleFactor] = useState(3)
  const [pageSelection, setPageSelection] = useState<PageSelection | null>(initialDraft ? { anchor: initialDraft.anchor, originalStyles: initialDraft.originalStyles } : null)
  const [annotationBody, setAnnotationBody] = useState(initialDraft?.body ?? '')
  const [tweakDraft, setTweakDraft] = useState<Record<string, string>>(initialDraft?.proposedStyles ?? {})
  const [selecting, setSelecting] = useState(false)

  useEffect(() => {
    onUrlChangeRef.current = onUrlChange
    onDescriptorChangeRef.current = onDescriptorChange
  }, [onDescriptorChange, onUrlChange])

  useEffect(() => {
    if (!pageSelection || (auxiliaryPanel !== 'annotation' && auxiliaryPanel !== 'tweaks')) return
    setPageDrafts((current) => ({
      ...current,
      [draftKey]: {
        purpose: auxiliaryPanel,
        anchor: pageSelection.anchor,
        originalStyles: pageSelection.originalStyles,
        ...(auxiliaryPanel === 'annotation' ? { body: annotationBody } : { proposedStyles: tweakDraft }),
      },
    }))
  }, [annotationBody, auxiliaryPanel, draftKey, pageSelection, setPageDrafts, tweakDraft])

  useEffect(() => {
    const draft = pageDrafts[draftKey]
    if (!ready || !descriptor.url || !draft) return
    if (draft.anchor.url === descriptor.url && draft.anchor.generation === descriptor.generation) return
    setPageDrafts((current) => {
      if (!current[draftKey]) return current
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    setPageSelection(null)
    setAuxiliaryPanel(null)
  }, [descriptor.generation, descriptor.url, draftKey, pageDrafts, ready, setPageDrafts])

  const clearPageDraft = () => setPageDrafts((current) => {
    if (!current[draftKey]) return current
    const next = { ...current }
    delete next[draftKey]
    return next
  })

  const acceptDescriptor = useCallback((next: BrowserTabDescriptor) => {
    descriptorRef.current = next
    setDescriptor(next)
    currentUrlRef.current = next.url
    setAddress(next.url)
    setLoadError(null)
    onUrlChangeRef.current?.(next.url)
    onDescriptorChangeRef.current?.(next)
    if (next.viewport?.enabled) {
      setViewportWidth(next.viewport.width)
      setViewportHeight(next.viewport.height)
      setDeviceScaleFactor(next.viewport.deviceScaleFactor)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let stopListening: (() => void) | undefined
    const initial = initialStateRef.current
    void browserRuntime<BrowserTabDescriptor>({
      method: 'ensure',
      params: {
        tabId,
        ownerThreadId,
        url: initial.url || undefined,
        navigationEntries: initial.navigationEntries,
        navigationIndex: initial.navigationIndex,
      },
    }).then((next) => {
      if (disposed) return
      acceptDescriptor(next)
      setReady(true)
      if (initial.zoomFactor !== 1) {
        void browserRuntime<{ factor: number }>({ method: 'zoom:set', params: { tabId, factor: initial.zoomFactor } })
          .then(({ factor }) => acceptDescriptor({ ...descriptorRef.current, zoomFactor: factor }))
      }
      if (initial.viewport?.enabled) {
        void browserRuntime<{ viewport: NonNullable<BrowserTabDescriptor['viewport']> }>({ method: 'viewport:set', params: { tabId, ...initial.viewport } })
          .then(({ viewport }) => acceptDescriptor({ ...descriptorRef.current, viewport }))
      }
      if (initial.scrollPosition) {
        void browserRuntime({ method: 'wait:load', params: { tabId, timeoutMs: 10_000 } })
          .catch(() => undefined)
          .then(() => browserRuntime<{ x: number; y: number }>({ method: 'scroll:set', params: { tabId, ...initial.scrollPosition } }))
          .then((scrollPosition) => acceptDescriptor({ ...descriptorRef.current, scrollPosition }))
          .catch(() => undefined)
      }
    }).catch(() => setReady(false))

    void onBrowserEvent((event) => {
      if (event.params.tabId !== tabId) return
      if (event.method === 'browser:tab-changed') acceptDescriptor(event.params as unknown as BrowserTabDescriptor)
      if (event.method === 'browser:find-result') {
        setFindResult({
          activeMatchOrdinal: Number(event.params.activeMatchOrdinal) || 0,
          matches: Number(event.params.matches) || 0,
        })
      }
      if (event.method === 'browser:tab-error') {
        setLoadError(typeof event.params.errorDescription === 'string' ? event.params.errorDescription : '页面加载失败')
      }
      if (event.method === 'browser:popup-request' && typeof event.params.activationToken === 'string') {
        toast('网页请求打开新标签页', {
          description: String(event.params.url ?? ''),
          action: {
            label: '打开',
            onClick: () => void browserRuntime<BrowserTabDescriptor>({
              method: 'openPopup',
              params: { activationToken: event.params.activationToken },
            }).then((popup) => window.dispatchEvent(new CustomEvent('lume:browser-popup-opened', { detail: { ownerThreadId, popup } }))).catch(() => toast.error('弹窗已失效')),
          },
        })
      }
      if (event.method === 'browser:dialog') {
        toast('网页对话框正在等待处理', {
          description: String(event.params.type ?? 'dialog'),
          action: { label: '确定', onClick: () => void browserRuntime({ method: 'dialog:handle', params: { tabId, accept: true } }) },
          cancel: { label: '取消', onClick: () => void browserRuntime({ method: 'dialog:handle', params: { tabId, accept: false } }) },
        })
      }
    }).then((dispose) => {
      if (disposed) dispose()
      else stopListening = dispose
    })

    return () => {
      disposed = true
      stopListening?.()
      void browserRuntime<{ x: number; y: number }>({ method: 'scroll:get', params: { tabId } })
        .then((scrollPosition) => onDescriptorChangeRef.current?.({ ...descriptorRef.current, scrollPosition }))
        .catch(() => undefined)
      void browserRuntime({ method: 'visible', params: { tabId, visible: false } }).catch(() => undefined)
    }
  }, [acceptDescriptor, ownerThreadId, tabId])

  useEffect(() => {
    if (!initialUrl || initialUrl === currentUrlRef.current || !ready) return
    currentUrlRef.current = initialUrl
    void browserRuntime<BrowserTabDescriptor>({ method: 'navigate', params: { tabId, url: initialUrl } })
      .then(acceptDescriptor)
      .catch(() => toast.error('页面打开失败'))
  }, [acceptDescriptor, initialUrl, ready, tabId])

  const syncBounds = useCallback(() => {
    const node = viewportRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    void browserRuntime({
      method: 'bounds',
      params: { tabId, surface, visible: true, x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    }).catch(() => undefined)
  }, [surface, tabId])

  useEffect(() => {
    if (!ready) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncBounds)
    if (viewportRef.current) observer?.observe(viewportRef.current)
    window.addEventListener('resize', syncBounds)
    syncBounds()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [ready, syncBounds])

  useEffect(() => {
    if (!addressFocused) return
    const timer = window.setTimeout(() => {
      void browserRuntime<BrowserHistoryEntry[]>({
        method: 'history:list',
        params: { query: address.trim(), limit: 8 },
      }).then(setSuggestions).catch(() => setSuggestions([]))
    }, 120)
    return () => window.clearTimeout(timer)
  }, [address, addressFocused])

  const navigate = (value = address) => {
    const next = normalizeUrl(value)
    if (!next) return
    setAddressFocused(false)
    setAddress(next)
    void browserRuntime<BrowserTabDescriptor>({ method: 'navigate', params: { tabId, url: next } })
      .then(acceptDescriptor)
      .catch(() => toast.error('页面打开失败'))
  }

  const run = (method: 'back' | 'forward' | 'reload' | 'stop' | 'hardReload') => {
    void browserRuntime<BrowserTabDescriptor>({ method, params: { tabId } })
      .then((next) => {
        if (next?.tabId) acceptDescriptor(next)
      })
      .catch(() => toast.error('浏览器操作失败'))
  }

  const setZoomFactor = (factor: number) => {
    const next = Math.max(0.25, Math.min(5, factor))
    void browserRuntime<{ factor: number }>({ method: 'zoom:set', params: { tabId, factor: next } })
      .then((result) => acceptDescriptor({ ...descriptor, zoomFactor: result.factor }))
      .catch(() => toast.error('缩放失败'))
  }

  const setPanel = (panel: Exclude<AuxiliaryPanel, null>) => {
    setAuxiliaryPanel((current) => current === panel ? null : panel)
  }

  const runFind = (forward: boolean, findNext = true) => {
    void browserRuntime<{ activeMatchOrdinal?: number; matches?: number }>({
      method: 'find',
      params: { tabId, text: findText, forward, findNext },
    }).then((result) => setFindResult({
      activeMatchOrdinal: result.activeMatchOrdinal ?? 0,
      matches: result.matches ?? 0,
    }))
  }

  const setViewport = (patch: { width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; touch?: boolean }) => {
    const nextWidth = patch.width ?? viewportWidth
    const nextHeight = patch.height ?? viewportHeight
    const nextScale = patch.deviceScaleFactor ?? deviceScaleFactor
    setViewportWidth(nextWidth)
    setViewportHeight(nextHeight)
    setDeviceScaleFactor(nextScale)
    void browserRuntime<{ viewport: NonNullable<BrowserTabDescriptor['viewport']> }>({
      method: 'viewport:set',
      params: {
        tabId,
        width: nextWidth,
        height: nextHeight,
        deviceScaleFactor: nextScale,
        mobile: patch.mobile ?? descriptor.viewport?.mobile ?? true,
        touch: patch.touch ?? descriptor.viewport?.touch ?? true,
      },
    }).then(({ viewport }) => acceptDescriptor({ ...descriptor, viewport }))
      .catch(() => toast.error('设备视口设置失败'))
  }

  const selectPage = async (purpose: 'annotation' | 'tweaks', mode: 'element' | 'text' | 'region' = 'element') => {
    setSelecting(true)
    setAuxiliaryPanel(null)
    try {
      const selection = await browserRuntime<PageSelection>({
        method: purpose === 'annotation' ? 'annotation:start' : 'tweaks:start',
        params: { tabId, mode },
      })
      try {
        const composed = await browserRuntime<ReviewOverlayResult>({
          method: 'overlay:compose',
          params: {
            tabId,
            kind: purpose,
            anchor: selection.anchor,
            styles: purpose === 'tweaks' ? tweakDraft : undefined,
            body: purpose === 'annotation' ? annotationBody : undefined,
          },
        })
        if (composed.status === 'submit') {
          if ('body' in composed) addAnnotationSelectionToChat(selection, composed.body)
          else addTweakSelectionToChat(selection, composed.styles)
        }
        return
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('unsupported')) throw error
      }
      setPageSelection(selection)
      setTweakDraft({})
      setAnnotationBody('')
      setAuxiliaryPanel(purpose)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('selection_cancelled')) toast.error('网页选择失败')
    } finally {
      setSelecting(false)
    }
  }

  const tabAttachment = (): AgentBrowserTabAttachment | null => {
    if (!descriptor.providerTabId || !descriptor.url) return null
    return {
      id: `browser-tab:${descriptor.providerTabId}:${descriptor.generation}`,
      origin: 'browser-tab',
      tabId: descriptor.tabId,
      providerTabId: descriptor.providerTabId,
      title: descriptor.title || descriptor.url,
      url: descriptor.url,
      generation: descriptor.generation,
      ...(descriptor.ownerThreadId ? { ownerThreadId: descriptor.ownerThreadId } : {}),
    }
  }

  const addAnnotationToChat = () => {
    if (!pageSelection) return
    addAnnotationSelectionToChat(pageSelection, annotationBody)
  }

  const addAnnotationSelectionToChat = (selection: PageSelection, body: string) => {
    const tab = tabAttachment()
    if (!tab || !body.trim()) return
    const attachment: AgentBrowserAnnotationAttachment = {
      id: `browser-annotation:${crypto.randomUUID()}`,
      origin: 'browser-annotation',
      tab,
      anchor: selection.anchor,
      body: body.trim(),
    }
    window.dispatchEvent(new CustomEvent('lume:add-browser-attachment-to-chat', { detail: { threadId: ownerThreadId, attachment } }))
    setAuxiliaryPanel(null)
    setPageSelection(null)
    setAnnotationBody('')
    clearPageDraft()
    toast.success('网页批注已添加到聊天')
  }

  const applyTweaks = () => {
    if (!pageSelection?.anchor.domPath || Object.keys(tweakDraft).length === 0) return
    void browserRuntime({
      method: 'tweaks:apply',
      params: { tabId, domPath: pageSelection.anchor.domPath, styles: tweakDraft },
    }).then(() => toast.success('预览已应用')).catch(() => toast.error('样式预览失败'))
  }

  const resetTweaks = () => {
    if (!pageSelection?.anchor.domPath) return
    void browserRuntime({ method: 'tweaks:reset', params: { tabId, domPath: pageSelection.anchor.domPath } })
      .then(() => {
        setTweakDraft({})
        toast.success('已恢复原始样式')
      })
      .catch(() => toast.error('恢复失败'))
  }

  const addTweaksToChat = () => {
    if (!pageSelection) return
    addTweakSelectionToChat(pageSelection, tweakDraft)
  }

  const addTweakSelectionToChat = (selection: PageSelection, styles: Record<string, string>) => {
    const tab = tabAttachment()
    if (!tab || Object.keys(styles).length === 0) return
    const attachment: AgentBrowserDesignChangeAttachment = {
      id: `browser-design-change:${crypto.randomUUID()}`,
      origin: 'browser-design-change',
      tab,
      anchor: selection.anchor,
      originalStyles: selection.originalStyles,
      proposedStyles: styles,
    }
    window.dispatchEvent(new CustomEvent('lume:add-browser-attachment-to-chat', { detail: { threadId: ownerThreadId, attachment } }))
    setAuxiliaryPanel(null)
    clearPageDraft()
    toast.success('Design Tweaks 已添加到聊天')
  }

  const securityLabel = descriptor.securityState === 'secure'
    ? '连接安全'
    : descriptor.securityState === 'local'
      ? '本地站点'
      : descriptor.securityState === 'insecure'
        ? '连接不安全'
        : '站点信息'

  const showSuggestions = addressFocused && suggestions.length > 0

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background text-foreground', className)}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <ToolbarButton title="后退" disabled={!descriptor.canGoBack} onClick={() => run('back')}><ArrowLeft size={15} /></ToolbarButton>
        <ToolbarButton title="前进" disabled={!descriptor.canGoForward} onClick={() => run('forward')}><ArrowRight size={15} /></ToolbarButton>
        <ToolbarButton title={descriptor.isLoading ? '停止' : '刷新'} onClick={() => run(descriptor.isLoading ? 'stop' : 'reload')}>
          {descriptor.isLoading ? <Square size={13} /> : <RotateCcw size={15} />}
        </ToolbarButton>
        <ToolbarButton title={securityLabel} onClick={() => setPanel('site')}>
          {descriptor.securityState === 'secure'
            ? <LockKeyhole size={14} />
            : descriptor.securityState === 'insecure'
              ? <ShieldAlert size={15} className="text-amber-500" />
              : <Globe size={15} />}
        </ToolbarButton>
        <form className="relative flex min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); navigate() }}>
          <Input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => window.setTimeout(() => setAddressFocused(false), 120)}
            placeholder="搜索或输入网址"
            className="h-8 min-w-0 flex-1 rounded-lg bg-muted/55 px-3 text-[13px]"
          />
        </form>
        <ToolbarButton title="添加当前标签到聊天" onClick={() => {
          window.dispatchEvent(new CustomEvent('lume:add-browser-tab-to-chat', { detail: descriptor }))
          toast.success('浏览器标签已添加到聊天')
        }}><MessageSquarePlus size={15} /></ToolbarButton>
        <ToolbarButton title={selecting ? '正在选择…' : '页面批注'} disabled={selecting} onClick={() => void selectPage('annotation')}><Highlighter size={15} /></ToolbarButton>
        <ToolbarButton title="响应式设备" active={auxiliaryPanel === 'device'} onClick={() => setPanel('device')}><MonitorSmartphone size={15} /></ToolbarButton>
        <ToolbarButton title="更多" active={auxiliaryPanel === 'more'} onClick={() => setPanel('more')}><MoreHorizontal size={16} /></ToolbarButton>
      </div>

      {showSuggestions && (
        <div className="shrink-0 border-b border-border/60 bg-popover px-2 py-1">
          {suggestions.map((entry) => (
            <Button
              key={entry.id}
              variant="ghost"
              className="flex h-9 w-full justify-start gap-2 px-2 text-left"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => navigate(entry.url)}
            >
              <Globe size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{entry.title || entry.url}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{entry.url}</span>
              </span>
            </Button>
          ))}
        </div>
      )}

      {auxiliaryPanel === 'find' && (
        <form className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 px-2" onSubmit={(event) => { event.preventDefault(); runFind(true) }}>
          <Search size={14} className="text-muted-foreground" />
          <Input
            autoFocus
            value={findText}
            onChange={(event) => {
              setFindText(event.target.value)
              void browserRuntime({ method: 'find', params: { tabId, text: event.target.value, findNext: false } })
            }}
            placeholder="在页面中查找"
            className="h-7 min-w-0 flex-1"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setAuxiliaryPanel(null)
                setFindText('')
                void browserRuntime({ method: 'find:stop', params: { tabId } })
              }
            }}
          />
          <span className="min-w-12 text-center text-[11px] tabular-nums text-muted-foreground">{findResult.matches ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}</span>
          <ToolbarButton title="上一个" onClick={() => runFind(false)}><ChevronUp size={14} /></ToolbarButton>
          <ToolbarButton title="下一个" onClick={() => runFind(true)}><ChevronDown size={14} /></ToolbarButton>
          <ToolbarButton title="关闭" onClick={() => {
            setAuxiliaryPanel(null)
            setFindText('')
            void browserRuntime({ method: 'find:stop', params: { tabId } })
          }}><X size={14} /></ToolbarButton>
        </form>
      )}

      {auxiliaryPanel === 'device' && (
        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
          <DevicePreset label="桌面" onClick={() => void browserRuntime<{ viewport: NonNullable<BrowserTabDescriptor['viewport']> }>({ method: 'viewport:reset', params: { tabId } }).then(({ viewport }) => acceptDescriptor({ ...descriptor, viewport }))} />
          <DevicePreset label="手机" onClick={() => { setViewportWidth(390); setViewportHeight(844); setDeviceScaleFactor(3); void browserRuntime<{ viewport: NonNullable<BrowserTabDescriptor['viewport']> }>({ method: 'emulate', params: { tabId, preset: 'phone' } }).then(({ viewport }) => acceptDescriptor({ ...descriptor, viewport })) }} />
          <DevicePreset label="平板" onClick={() => { setViewportWidth(820); setViewportHeight(1180); setDeviceScaleFactor(2); void browserRuntime<{ viewport: NonNullable<BrowserTabDescriptor['viewport']> }>({ method: 'emulate', params: { tabId, preset: 'tablet' } }).then(({ viewport }) => acceptDescriptor({ ...descriptor, viewport })) }} />
          <NumberField label="宽" value={viewportWidth} min={200} max={4000} onCommit={(value) => setViewport({ width: value })} />
          <span className="text-muted-foreground">×</span>
          <NumberField label="高" value={viewportHeight} min={200} max={4000} onCommit={(value) => setViewport({ height: value })} />
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setViewport({ width: viewportHeight, height: viewportWidth })}>旋转</Button>
          <NumberField label="DPR" value={deviceScaleFactor} min={0.5} max={4} step={0.5} onCommit={(value) => setViewport({ deviceScaleFactor: value })} />
        </div>
      )}

      {auxiliaryPanel === 'site' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-[12px]">
          {descriptor.securityState === 'secure' ? <Check size={14} className="text-emerald-500" /> : <ShieldAlert size={14} className="text-amber-500" />}
          <div className="min-w-0 flex-1">
            <div className="font-medium">{securityLabel}</div>
            <div className="truncate text-[11px] text-muted-foreground">{safeOrigin(descriptor.url) || '尚未打开网页'}</div>
          </div>
          <Button variant="outline" size="sm" className="h-7" onClick={() => void browserRuntime({ method: 'clear-data', params: { categories: ['siteData'], timeRange: 'all' } }).then(() => toast.success('站点数据已清除'))}>清除站点数据</Button>
        </div>
      )}

      {auxiliaryPanel === 'more' && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 bg-muted/20 px-2 py-1.5">
          <ActionButton icon={<Search size={13} />} label="查找" onClick={() => setAuxiliaryPanel('find')} />
          <ActionButton icon={<Camera size={13} />} label="截图" onClick={() => void browserRuntime<{ saved: boolean }>({ method: 'screenshot:save', params: { tabId } }).then((result) => result.saved && toast.success('截图已保存'))} />
          <ActionButton icon={<Copy size={13} />} label="复制截图" onClick={() => void browserRuntime({ method: 'screenshot:clipboard', params: { tabId } }).then(() => toast.success('截图已复制'))} />
          <ActionButton icon={<Printer size={13} />} label="打印" onClick={() => void browserRuntime({ method: 'print', params: { tabId } })} />
          <ActionButton icon={<SlidersHorizontal size={13} />} label="Design Tweaks" onClick={() => void selectPage('tweaks')} />
          <ActionButton icon={<RefreshCw size={13} />} label="硬刷新" onClick={() => run('hardReload')} />
          <ActionButton icon={<ExternalLink size={13} />} label="外部打开" onClick={() => descriptor.url && void browserRuntime({ method: 'openExternal', params: { url: descriptor.url } })} />
          <ActionButton icon={<Globe size={13} />} label="导入 Profile" onClick={() => setImportOpen(true)} />
          <span className="mx-1 h-5 w-px bg-border" />
          <ToolbarButton title="缩小" onClick={() => setZoomFactor((descriptor.zoomFactor ?? 1) - 0.1)}><ZoomOut size={14} /></ToolbarButton>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setZoomFactor(1)}>{Math.round((descriptor.zoomFactor ?? 1) * 100)}%</Button>
          <ToolbarButton title="放大" onClick={() => setZoomFactor((descriptor.zoomFactor ?? 1) + 0.1)}><ZoomIn size={14} /></ToolbarButton>
          <ActionButton icon={<Copy size={13} />} label="复制链接" onClick={() => descriptor.url && void writeClipboardText(descriptor.url).catch(() => toast.error('复制失败'))} />
          <ActionButton icon={<Globe size={13} />} label="开发者工具" onClick={() => void browserRuntime({ method: 'devtools', params: { tabId } })} />
        </div>
      )}

      {auxiliaryPanel === 'annotation' && pageSelection && (
        <div className="shrink-0 space-y-2 border-b border-border/60 bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Highlighter size={13} />
            <span className="min-w-0 flex-1 truncate">
              已选择{pageSelection.anchor.kind === 'text' ? '文本' : pageSelection.anchor.kind === 'region' ? '区域' : '元素'}
              {pageSelection.anchor.textQuote?.exact ? ` · ${pageSelection.anchor.textQuote.exact}` : ''}
            </span>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => void selectPage('annotation', 'element')}>元素</Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => void selectPage('annotation', 'text')}>文本</Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => void selectPage('annotation', 'region')}>区域</Button>
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={annotationBody}
              onChange={(event) => setAnnotationBody(event.target.value)}
              placeholder="写下要让 Agent 处理的网页审阅意见…"
              className="min-h-16 flex-1 resize-y text-[12px]"
            />
            <div className="flex shrink-0 flex-col gap-1">
              <Button size="sm" disabled={!annotationBody.trim()} onClick={addAnnotationToChat}>添加到聊天</Button>
              <Button variant="ghost" size="sm" onClick={() => { setAuxiliaryPanel(null); setPageSelection(null); clearPageDraft() }}>取消</Button>
            </div>
          </div>
        </div>
      )}

      {auxiliaryPanel === 'tweaks' && pageSelection && (
        <div className="shrink-0 space-y-2 border-b border-border/60 bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-2 text-[11px]">
            <SlidersHorizontal size={13} className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{pageSelection.anchor.domPath || '所选区域'}</span>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => void selectPage('tweaks')}>重新选择</Button>
            <Button variant="outline" size="sm" className="h-7" onClick={resetTweaks}>恢复原始</Button>
            <Button variant="outline" size="sm" className="h-7" disabled={Object.keys(tweakDraft).length === 0} onClick={applyTweaks}>应用预览</Button>
            <Button size="sm" className="h-7" disabled={Object.keys(tweakDraft).length === 0} onClick={addTweaksToChat}>添加到聊天</Button>
          </div>
          <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
            {TWEAK_FIELDS.map((field) => (
              <label key={field.key} className="min-w-0 text-[10px] text-muted-foreground">
                {field.label}
                <Input
                  type={field.type ?? 'text'}
                  value={tweakDraft[field.key] ?? ''}
                  placeholder={pageSelection.originalStyles[field.key] ?? ''}
                  className="mt-0.5 h-7 px-1.5 text-[11px]"
                  onChange={(event) => setTweakDraft((current) => {
                    const value = event.target.value
                    if (!value) {
                      const next = { ...current }
                      delete next[field.key]
                      return next
                    }
                    return { ...current, [field.key]: value }
                  })}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <BrowserImportModal open={importOpen} onOpenChange={setImportOpen} />
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {!ready && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">内置浏览器准备中…</div>}
        {loadError && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6">
            <div className="max-w-sm text-center">
              <ShieldAlert className="mx-auto mb-3 text-muted-foreground" size={28} />
              <p className="text-sm font-medium">无法打开此页面</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">{loadError}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => run('reload')}>重新加载</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ToolbarButton({ children, title, active, disabled, onClick }: {
  children: ReactNode
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="icon"
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="size-8 shrink-0"
    >
      {children}
    </Button>
  )
}

function ActionButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[11px]" onClick={onClick}>{icon}{label}</Button>
}

function DevicePreset({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={onClick}>{label}</Button>
}

function NumberField({ label, value, min, max, step = 1, onCommit }: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = Math.max(min, Math.min(max, parsed))
    setDraft(String(next))
    onCommit(next)
  }
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {label}
      <Input
        value={draft}
        type="number"
        min={min}
        max={max}
        step={step}
        className="h-7 w-16 px-1.5 text-[11px]"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      />
    </label>
  )
}

function emptyDescriptor(tabId: string, url: string): BrowserTabDescriptor {
  return {
    tabId,
    backend: 'iab',
    generation: 1,
    url,
    title: '新标签页',
    visible: false,
    surface: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    securityState: 'unknown',
    mediaState: { audible: false, camera: false, microphone: false },
    lifecycle: 'background',
    zoomFactor: 1,
  }
}

function safeOrigin(value: string): string {
  try { return new URL(value).origin } catch { return '' }
}

const TWEAK_FIELDS: Array<{ key: string; label: string; type?: 'text' | 'color' }> = [
  { key: 'textContent', label: '文本' },
  { key: 'color', label: '文字颜色' },
  { key: 'backgroundColor', label: '背景颜色' },
  { key: 'borderColor', label: '边框颜色' },
  { key: 'fontFamily', label: '字体' },
  { key: 'fontSize', label: '字号' },
  { key: 'fontWeight', label: '字重' },
  { key: 'borderRadius', label: '圆角' },
  { key: 'borderWidth', label: '边框宽度' },
  { key: 'borderStyle', label: '边框样式' },
  { key: 'width', label: '宽度' },
  { key: 'height', label: '高度' },
  { key: 'display', label: 'Display' },
  { key: 'flexDirection', label: 'Flex 方向' },
  { key: 'justifyContent', label: '主轴分布' },
  { key: 'alignItems', label: '交叉轴对齐' },
  { key: 'gap', label: 'Gap' },
  { key: 'padding', label: 'Padding' },
  { key: 'margin', label: 'Margin' },
]
