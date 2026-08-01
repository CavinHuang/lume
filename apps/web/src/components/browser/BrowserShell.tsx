import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download as DownloadIcon,
  Eye,
  ExternalLink,
  Globe,
  Highlighter,
  LockKeyhole,
  MoreHorizontal,
  Minus,
  Plus,
  RotateCw,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentBrowserAnchor,
  AgentBrowserAnnotationAttachment,
  AgentBrowserAttachment,
  AgentBrowserDesignChangeAttachment,
  AgentBrowserTabAttachment,
  BrowserHistoryEntry,
  BrowserTabDescriptor,
  BrowserViewportState,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { browserRuntime, getBrowserSettings, onBrowserEvent } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import { normalizeUrl } from './browser-url'
import { BrowserImportModal } from './BrowserImportModal'
import { BrowserGuestSurface } from './BrowserWebviewPool'
import { activeTabIdAtom, agentBrowserAttachmentsAtom, browserPageDraftsAtom, browserReviewCoachmarkSeenAtom, browserReviewSessionsAtom, settingsInitialTabAtom, tabsAtom } from '@/atoms'
import { BrowserDataManagers, type BrowserDataManagersHandle } from '@/components/settings/BrowserDataManagers'

type AuxiliaryPanel = 'find' | 'annotation' | 'tweaks' | null
type PageSelection = { anchor: AgentBrowserAnchor; originalStyles: Record<string, string> }
type BrowserDownloadItem = { id: string; filename: string; actor: 'user' | 'agent'; state: 'completed' | 'cancelled' | 'interrupted'; receivedBytes: number; createdAt: string }
type BrowserActiveDownload = Omit<BrowserDownloadItem, 'state' | 'createdAt'> & { state: 'progressing'; totalBytes: number }
type DevicePresetId = typeof DEVICE_PRESETS[number]['id']
type ViewportResizeAxis = 'west' | 'east' | 'south' | 'south-west' | 'south-east'
type ViewportDisplayScale = NonNullable<BrowserViewportState['displayScale']>
export function BrowserShell({
  tabId,
  ownerThreadId,
  initialUrl = '',
  surface,
  className,
  onUrlChange,
  onDescriptorChange,
}: {
  tabId: string
  ownerThreadId?: string
  initialUrl?: string
  surface: 'main' | 'right-panel'
  className?: string
  onUrlChange?: (url: string) => void
  onDescriptorChange?: (descriptor: BrowserTabDescriptor) => void
}) {
  const [pageDrafts, setPageDrafts] = useAtom(browserPageDraftsAtom)
  const [reviewSessions, setReviewSessions] = useAtom(browserReviewSessionsAtom)
  const [reviewCoachmarkSeen, setReviewCoachmarkSeen] = useAtom(browserReviewCoachmarkSeenAtom)
  const setPendingBrowserAttachments = useSetAtom(agentBrowserAttachmentsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom)
  const draftKey = `${ownerThreadId ?? 'unscoped'}:${tabId}`
  const initialDraft = pageDrafts[draftKey]
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const deviceCanvasRef = useRef<HTMLDivElement | null>(null)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  const dataManagersRef = useRef<BrowserDataManagersHandle | null>(null)
  const currentUrlRef = useRef(initialUrl)
  const initialUrlRef = useRef(initialUrl)
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
  const [suggestionIndex, setSuggestionIndex] = useState(-1)
  const [addressFocused, setAddressFocused] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(390)
  const [viewportHeight, setViewportHeight] = useState(844)
  const [deviceScaleFactor, setDeviceScaleFactor] = useState(3)
  const [devicePreset, setDevicePreset] = useState<DevicePresetId>('responsive')
  const [viewportDisplayScale, setViewportDisplayScaleState] = useState<ViewportDisplayScale>('fit')
  const [deviceCanvasSize, setDeviceCanvasSize] = useState({ width: 0, height: 0 })
  const [resizingViewport, setResizingViewport] = useState(false)
  const [pageSelection, setPageSelection] = useState<PageSelection | null>(initialDraft ? { anchor: initialDraft.anchor, originalStyles: initialDraft.originalStyles } : null)
  const [annotationBody, setAnnotationBody] = useState(initialDraft?.body ?? '')
  const [tweakDraft, setTweakDraft] = useState<Record<string, string>>(initialDraft?.proposedStyles ?? {})
  const [selecting, setSelecting] = useState(false)
  const [annotationMode, setAnnotationMode] = useState(false)
  const [discardReviewOpen, setDiscardReviewOpen] = useState(false)
  const [showingOriginal, setShowingOriginal] = useState(false)
  const [downloads, setDownloads] = useState<BrowserDownloadItem[]>([])
  const [activeDownloads, setActiveDownloads] = useState<BrowserActiveDownload[]>([])
  const [downloadNoticeCount, setDownloadNoticeCount] = useState(0)
  const showSuggestions = addressFocused && suggestions.length > 0
  const reviewSession = reviewSessions[draftKey]
  const reviewItems = reviewSession?.items ?? []
  const staleReviewCount = reviewItems.filter((item) => item.status === 'stale').length

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

  useEffect(() => {
    const session = reviewSessions[draftKey]
    if (!session || !descriptor.url) return
    const items = session.items.map((item) => ({
      ...item,
      status: item.attachment.tab.url === descriptor.url && item.attachment.tab.generation === descriptor.generation ? 'valid' as const : 'stale' as const,
    }))
    if (session.items.every((item, index) => item.status === items[index]?.status)) return
    setReviewSessions((current) => ({
      ...current,
      [draftKey]: {
        ...session,
        items,
        updatedAt: new Date().toISOString(),
      },
    }))
  }, [descriptor.generation, descriptor.url, draftKey, reviewSessions, setReviewSessions])

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
      setDevicePreset(resolveDevicePreset(next.viewport))
      setViewportDisplayScaleState(next.viewport.displayScale ?? 'fit')
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let stopListening: (() => void) | undefined
    const restoreWorkspace = ownerThreadId
      ? browserRuntime({ method: 'workspace:get', params: { ownerThreadId } }).catch(() => undefined)
      : Promise.resolve()
    void restoreWorkspace.then(() => browserRuntime<BrowserTabDescriptor>({
      method: 'ensure',
      params: {
        tabId,
        ownerThreadId,
        url: initialUrlRef.current || undefined,
      },
    })).then((next) => {
      if (disposed) return
      acceptDescriptor(next)
      setReady(true)
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
      if (event.method === 'browser:shortcut') {
        if (event.params.action === 'focus-address') {
          setAddressFocused(true)
          requestAnimationFrame(() => addressInputRef.current?.select())
        } else if (event.params.action === 'find') {
          setAuxiliaryPanel('find')
        } else if (event.params.action === 'reload' || event.params.action === 'hard-reload') {
          void browserRuntime<BrowserTabDescriptor>({ method: event.params.action === 'hard-reload' ? 'hardReload' : 'reload', params: { tabId } })
            .then(acceptDescriptor)
            .catch(() => toast.error('页面重新加载失败'))
        }
      }
      if (event.method === 'browser:tab-error') {
        setLoadError(typeof event.params.errorDescription === 'string' ? event.params.errorDescription : '页面加载失败')
      }
      if (event.method === 'browser:download') {
        const id = typeof event.params.id === 'string' ? event.params.id : ''
        const filename = typeof event.params.filename === 'string' ? event.params.filename : '文件'
        if (event.params.state === 'progressing' && id) {
          const progress: BrowserActiveDownload = {
            id,
            filename,
            actor: event.params.actor === 'agent' ? 'agent' : 'user',
            state: 'progressing',
            receivedBytes: Number(event.params.receivedBytes) || 0,
            totalBytes: Number(event.params.totalBytes) || 0,
          }
          setActiveDownloads((current) => [...current.filter((download) => download.id !== id), progress])
          return
        }
        if (id) setActiveDownloads((current) => current.filter((download) => download.id !== id))
        setDownloadNoticeCount((count) => Math.min(9, count + 1))
        void browserRuntime<BrowserDownloadItem[]>({ method: 'downloads:list' }).then(setDownloads).catch(() => undefined)
        if (event.params.state === 'completed') toast.success(`下载完成：${filename}`)
        else toast.error(`下载未完成：${filename}`)
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
      params: {
        tabId,
        surface,
        visible: ready && Boolean(descriptor.url) && !loadError && descriptor.lifecycle !== 'crashed' && !importOpen,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
    }).catch(() => undefined)
  }, [descriptor.lifecycle, descriptor.url, importOpen, loadError, ready, surface, tabId])

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
    const node = deviceCanvasRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const update = () => setDeviceCanvasSize({ width: node.clientWidth, height: node.clientHeight })
    const observer = new ResizeObserver(update)
    observer.observe(node)
    update()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!addressFocused) return
    const timer = window.setTimeout(() => {
      void browserRuntime<BrowserHistoryEntry[]>({
        method: 'history:list',
        params: { query: address.trim(), limit: 8 },
      }).then((entries) => {
        setSuggestions(entries)
        setSuggestionIndex(entries.length ? 0 : -1)
      }).catch(() => {
        setSuggestions([])
        setSuggestionIndex(-1)
      })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [address, addressFocused])

  const navigate = (value = address) => {
    const next = normalizeUrl(value)
    if (!next) return
    setAddressFocused(false)
    setSuggestions([])
    setSuggestionIndex(-1)
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (modifier && key === 'l') {
        event.preventDefault()
        setAddressFocused(true)
        requestAnimationFrame(() => addressInputRef.current?.select())
        return
      }
      if (modifier && key === 'f') {
        event.preventDefault()
        setAuxiliaryPanel('find')
        return
      }
      if ((modifier && key === 'r') || event.key === 'F5') {
        event.preventDefault()
        run(event.shiftKey ? 'hardReload' : 'reload')
        return
      }
      if (event.key === 'Escape' && auxiliaryPanel === 'find') {
        setAuxiliaryPanel(null)
        setFindText('')
        void browserRuntime({ method: 'find:stop', params: { tabId } })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [auxiliaryPanel, tabId])

  const setZoomFactor = (factor: number) => {
    const next = Math.max(0.25, Math.min(5, factor))
    void browserRuntime<{ factor: number }>({ method: 'zoom:set', params: { tabId, factor: next } })
      .then((result) => acceptDescriptor({ ...descriptor, zoomFactor: result.factor }))
      .catch(() => toast.error('缩放失败'))
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

  const commitViewport = (viewport: BrowserViewportState, failureMessage: string) => {
    const previous = descriptorRef.current
    const revision = (previous.viewportRevision ?? 0) + 1
    const optimistic = { ...previous, viewport, viewportRevision: revision }
    acceptDescriptor(optimistic)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      void browserRuntime<{ viewport: BrowserViewportState; revision: number }>({
        method: 'viewport:commit',
        params: {
          tabId,
          expectedGeneration: previous.generation,
          revision,
          state: viewport,
        },
      }).then((result) => {
        if (descriptorRef.current.generation !== previous.generation) return
        acceptDescriptor({ ...descriptorRef.current, viewport: result.viewport, viewportRevision: result.revision })
      }).catch(() => {
        if (descriptorRef.current.generation === previous.generation && descriptorRef.current.viewportRevision === revision) acceptDescriptor(previous)
        toast.error(failureMessage)
      })
    }))
  }

  const setViewport = (
    patch: { width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; touch?: boolean },
    options?: { preservePreset?: boolean },
  ) => {
    const nextWidth = patch.width ?? viewportWidth
    const nextHeight = patch.height ?? viewportHeight
    const nextScale = patch.deviceScaleFactor ?? deviceScaleFactor
    const nextPreset = options?.preservePreset ? devicePreset : 'responsive'
    setViewportWidth(nextWidth)
    setViewportHeight(nextHeight)
    setDeviceScaleFactor(nextScale)
    setDevicePreset(nextPreset)
    commitViewport({
      enabled: true,
      width: nextWidth,
      height: nextHeight,
      deviceScaleFactor: nextScale,
      mobile: patch.mobile ?? descriptorRef.current.viewport?.mobile ?? false,
      touch: patch.touch ?? descriptorRef.current.viewport?.touch ?? false,
      preset: nextPreset,
      displayScale: viewportDisplayScale,
    }, '设备视口设置失败')
  }

  const applyDevicePreset = (presetId: DevicePresetId) => {
    const preset = DEVICE_PRESETS.find((candidate) => candidate.id === presetId)
    if (!preset) return
    setDevicePreset(presetId)
    setViewportWidth(preset.width)
    setViewportHeight(preset.height)
    setDeviceScaleFactor(preset.deviceScaleFactor)
    const mobile = !['responsive', '4k', 'laptop-l', 'laptop'].includes(preset.id)
    commitViewport({
      enabled: true,
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile,
      touch: mobile,
      preset: preset.id,
      displayScale: viewportDisplayScale,
    }, '设备视口设置失败')
  }

  const toggleDeviceMode = () => {
    if (descriptor.viewport?.enabled) {
      commitViewport({ enabled: false, width: 0, height: 0, deviceScaleFactor: 1, mobile: false, touch: false, preset: 'desktop', displayScale: 'fit' }, '无法关闭设备模式')
      return
    }
    const availableWidth = Math.max(240, Math.min(1280, Math.floor(deviceCanvasSize.width - 40)))
    const availableHeight = Math.max(160, Math.min(1200, Math.floor(deviceCanvasSize.height - 40)))
    setDevicePreset('responsive')
    setViewportWidth(availableWidth)
    setViewportHeight(availableHeight)
    setDeviceScaleFactor(1)
    commitViewport({
      enabled: true,
      width: availableWidth,
      height: availableHeight,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
      preset: 'responsive',
      displayScale: 'fit',
    }, '无法打开设备模式')
  }

  const setViewportDisplayScale = (displayScale: ViewportDisplayScale) => {
    setViewportDisplayScaleState(displayScale)
    const viewport = descriptorRef.current.viewport
    if (viewport?.enabled) commitViewport({ ...viewport, displayScale }, '设备显示缩放设置失败')
  }

  const openBrowserSettings = () => {
    setSettingsInitialTab('browser')
    setTabs((tabs) => tabs.some((tab) => tab.id === '__settings__')
      ? tabs
      : [...tabs, { id: '__settings__', type: 'settings', title: '设置' }])
    setActiveTabId('__settings__')
  }

  const beginViewportResize = (axis: ViewportResizeAxis, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const startWidth = viewportWidth
    const startHeight = viewportHeight
    const startScale = Math.max(0.2, deviceFrame.scale)
    let nextWidth = startWidth
    let nextHeight = startHeight
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = axis === 'west' || axis === 'east' ? 'ew-resize' : axis === 'south' ? 'ns-resize' : axis === 'south-west' ? 'nesw-resize' : 'nwse-resize'
    document.body.style.userSelect = 'none'
    setResizingViewport(true)
    setDevicePreset('responsive')

    const onMove = (moveEvent: PointerEvent) => {
      const horizontalDelta = Math.round(((moveEvent.clientX - startX) * 2) / startScale)
      const verticalDelta = Math.round((moveEvent.clientY - startY) / startScale)
      if (axis === 'west' || axis === 'south-west') nextWidth = clampViewportWidth(startWidth - horizontalDelta)
      if (axis === 'east' || axis === 'south-east') nextWidth = clampViewportWidth(startWidth + horizontalDelta)
      if (axis === 'south' || axis === 'south-west' || axis === 'south-east') nextHeight = clampViewportHeight(startHeight + verticalDelta)
      setViewportWidth(nextWidth)
      setViewportHeight(nextHeight)
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setResizingViewport(false)
      setViewport({ width: nextWidth, height: nextHeight })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const selectPage = async (purpose: 'annotation' | 'tweaks', mode: 'element' | 'text' | 'region' = 'element') => {
    setSelecting(true)
    setAuxiliaryPanel(null)
    try {
      const selection = await browserRuntime<PageSelection>({
        method: purpose === 'annotation' ? 'annotation:start' : 'tweaks:start',
        params: { tabId, mode },
      })
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

  const startAnnotationSelection = (mode: 'element' | 'text' | 'region' = 'element') => {
    setAnnotationMode(true)
    if (!reviewCoachmarkSeen) {
      toast('网页审阅', { description: '连续选择元素、文本或区域，完成后点 Send 将整批审阅加入聊天编辑器。' })
      setReviewCoachmarkSeen(true)
    }
    void selectPage('annotation', mode)
  }

  const exitAnnotationMode = () => {
    setAnnotationMode(false)
    setSelecting(false)
    setAuxiliaryPanel((current) => current === 'annotation' ? null : current)
    void browserRuntime({ method: 'annotation:stop', params: { tabId } }).catch(() => undefined)
  }

  const clearReviewSession = () => {
    const screenshotRef = reviewSessions[draftKey]?.screenshotRef
    if (screenshotRef) void browserRuntime({ method: 'screenshot:attachment:delete', params: { tabId, screenshotRef } }).catch(() => undefined)
    setReviewSessions((current) => {
      if (!current[draftKey]) return current
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    setAnnotationMode(false)
    setAuxiliaryPanel(null)
    setPageSelection(null)
    clearPageDraft()
    void setOriginalPreview(true).finally(() => setShowingOriginal(false))
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

  const enqueueBrowserAttachment = (attachment: AgentBrowserAttachment) => {
    if (!ownerThreadId) {
      window.dispatchEvent(new CustomEvent('lume:add-browser-attachment-to-chat', { detail: { attachment } }))
      return
    }
    setPendingBrowserAttachments((current) => ({
      ...current,
      [ownerThreadId]: [
        ...(current[ownerThreadId] ?? []).filter((item) => item.id !== attachment.id && !(item.origin === 'browser-tab' && attachment.origin === 'browser-tab' && item.tabId === attachment.tabId)),
        attachment,
      ],
    }))
  }

  const enqueueReviewAttachment = (attachment: AgentBrowserAnnotationAttachment | AgentBrowserDesignChangeAttachment) => {
    if (!ownerThreadId) return enqueueBrowserAttachment(attachment)
    const now = new Date().toISOString()
    setReviewSessions((current) => {
      const existing = current[draftKey]
      return {
        ...current,
        [draftKey]: {
          ownerThreadId,
          tabId,
          url: descriptor.url,
          generation: descriptor.generation,
          ...(existing?.screenshotRef ? { screenshotRef: existing.screenshotRef } : {}),
          items: [
            ...(existing?.items ?? []).filter((item) => item.id !== attachment.id),
            { id: attachment.id, status: 'valid', attachment, createdAt: now },
          ],
          updatedAt: now,
        },
      }
    })
    setAnnotationMode(true)
  }

  const promoteReviewQueue = async () => {
    const session = reviewSessions[draftKey]
    if (!session?.items.length) return
    if (session.items.some((item) => item.status === 'stale')) {
      toast.error('存在已失效的批注，请移除后重新选择')
      return
    }
    let screenshotRef = session.screenshotRef
    if (!screenshotRef) {
      const screenshotMode = await getBrowserSettings().then((value) => value.annotationScreenshots).catch(() => 'necessary' as const)
      const shouldCapture = screenshotMode === 'always'
        || ((screenshotMode === 'necessary' || screenshotMode === 'ask') && session.items.some((item) => item.attachment.anchor.kind === 'region'))
      if (shouldCapture) {
        screenshotRef = await captureReviewScreenshot(true)
        if (!screenshotRef) return
      }
    }
    for (const item of session.items) {
      const attachment = screenshotRef
        ? { ...item.attachment, screenshotRef }
        : item.attachment
      enqueueBrowserAttachment(attachment)
    }
    setReviewSessions((current) => {
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    setAnnotationMode(false)
    toast.success(`${session.items.length} 项网页审阅已添加到当前消息`)
  }

  const removeReviewItem = (id: string) => setReviewSessions((current) => {
    const session = current[draftKey]
    if (!session) return current
    const items = session.items.filter((item) => item.id !== id)
    if (!items.length) {
      const next = { ...current }
      delete next[draftKey]
      return next
    }
    return { ...current, [draftKey]: { ...session, items, updatedAt: new Date().toISOString() } }
  })

  const setOriginalPreview = async (original: boolean) => {
    setShowingOriginal(original)
    const tweaks = reviewItems.filter((item): item is typeof item & { attachment: AgentBrowserDesignChangeAttachment } => item.attachment.origin === 'browser-design-change')
    await Promise.all(tweaks.map((item) => {
      const domPath = item.attachment.anchor.domPath
      if (!domPath) return Promise.resolve()
      return browserRuntime({
        method: original ? 'tweaks:reset' : 'tweaks:apply',
        params: original
          ? { tabId, domPath }
          : { tabId, domPath, styles: item.attachment.proposedStyles },
      }).catch(() => undefined)
    }))
  }

  const captureReviewScreenshot = async (quiet = false): Promise<string | undefined> => {
    if (!ownerThreadId || !reviewItems.length) {
      if (!quiet) toast.error('请先添加至少一项网页审阅')
      return undefined
    }
    try {
      const result = await browserRuntime<{ screenshotRef: string }>({ method: 'screenshot:attachment', params: { tabId, ownerThreadId } })
      setReviewSessions((current) => {
        const session = current[draftKey]
        return session ? { ...current, [draftKey]: { ...session, screenshotRef: result.screenshotRef, updatedAt: new Date().toISOString() } } : current
      })
      if (!quiet) toast.success('截图已附加到当前审阅')
      return result.screenshotRef
    } catch {
      toast.error(quiet ? '自动附加网页截图失败，审阅队列已保留' : '无法附加网页截图')
      return undefined
    }
  }

  const highlightReviewItem = (item: typeof reviewItems[number] | null) => {
    void browserRuntime({
      method: 'annotation:highlight',
      params: { tabId, anchor: item?.attachment.anchor ?? null },
    }).catch(() => undefined)
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
    enqueueReviewAttachment(attachment)
    setAuxiliaryPanel(null)
    setPageSelection(null)
    setAnnotationBody('')
    clearPageDraft()
    toast.success('网页批注已加入审阅队列')
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
    enqueueReviewAttachment(attachment)
    setAuxiliaryPanel(null)
    clearPageDraft()
    toast.success('Design Tweaks 已加入审阅队列')
  }

  const securityLabel = descriptor.securityState === 'secure'
    ? '连接安全'
    : descriptor.securityState === 'local'
      ? '本地站点'
      : descriptor.securityState === 'insecure'
        ? '连接不安全'
        : '站点信息'

  const viewportEnabled = descriptor.viewport?.enabled === true
  const deviceFrame = getDeviceFrameSize(
    viewportWidth,
    viewportHeight,
    deviceCanvasSize.width,
    deviceCanvasSize.height,
    viewportDisplayScale,
  )

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background text-foreground', className)}>
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border px-2 text-muted-foreground">
        {annotationMode ? (
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(120px,auto)_minmax(0,1fr)] items-center gap-2 text-[11px]">
            <div className="flex min-w-0 items-center gap-1">
              <ToolbarButton title="退出批注" onClick={exitAnnotationMode}><X size={14} /></ToolbarButton>
              {reviewItems.length > 0 && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => setDiscardReviewOpen(true)}>
                  <Trash2 size={12} />丢弃全部
                </Button>
              )}
            </div>
            <div className="min-w-0 truncate text-center text-muted-foreground">
              <span className="font-medium text-foreground">{showingOriginal ? 'Original' : 'Annotating'}</span>
              <span> · {safeHost(descriptor.url) || '网页审阅'}</span>
            </div>
            <div className="flex min-w-0 justify-end gap-1">
              <ToolbarButton title="为当前审阅附加截图" onClick={() => void captureReviewScreenshot()}><Camera size={14} /></ToolbarButton>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onPointerDown={() => void setOriginalPreview(true)}
                onPointerUp={() => void setOriginalPreview(false)}
                onPointerLeave={() => showingOriginal && void setOriginalPreview(false)}
              >
                <Eye size={13} />按住查看原始页面
              </Button>
              <Button size="sm" className="relative h-7 px-2.5 text-[11px]" disabled={!reviewItems.length || staleReviewCount > 0} onClick={() => void promoteReviewQueue()}>
                Send
                {reviewItems.length > 0 && <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 text-[9px]">{reviewItems.length}</span>}
              </Button>
            </div>
          </div>
        ) : (
          <>
        <div className="flex shrink-0 items-center gap-px">
          <ToolbarButton title="后退" disabled={!descriptor.canGoBack} onClick={() => run('back')}><ArrowLeft size={15} /></ToolbarButton>
          <ToolbarButton title="前进" disabled={!descriptor.canGoForward} onClick={() => run('forward')}><ArrowRight size={15} /></ToolbarButton>
        </div>
        <ToolbarButton title="重新加载页面" disabled={descriptor.isLoading} onClick={() => run('reload')}><RotateCcw size={15} /></ToolbarButton>
        <form className="group/address relative mx-auto flex min-w-0 max-w-[770px] flex-1 items-center px-1" onSubmit={(event) => { event.preventDefault(); navigate() }}>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button
              variant="ghost"
              size="icon"
              type="button"
              className={cn(
                'absolute left-1 z-10 size-7 rounded-l-[10px] rounded-r-none text-muted-foreground transition-opacity hover:bg-foreground/5 hover:text-foreground',
                !descriptor.url && 'invisible',
                descriptor.url && !addressFocused && 'opacity-0 group-hover/address:opacity-100 group-focus-within/address:opacity-100',
              )}
              title={securityLabel}
              aria-label={securityLabel}
            />}>
              {descriptor.securityState === 'secure'
                ? <LockKeyhole size={13} />
                : descriptor.securityState === 'insecure'
                  ? <ShieldAlert size={14} className="text-amber-500" />
                  : <Globe size={14} />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <div className="px-3 py-2">
                <div className="text-xs font-medium text-foreground">{securityLabel}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{safeOrigin(descriptor.url) || '尚未打开网页'}</div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openBrowserSettings}>站点设置<span className="ml-auto text-[10px] text-muted-foreground">权限</span></DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => void browserRuntime({ method: 'clear-data', params: { categories: ['siteData'], timeRange: 'all' } }).then(() => toast.success('站点数据已清除'))}>清除站点数据</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Input
            ref={addressInputRef}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => window.setTimeout(() => setAddressFocused(false), 120)}
            placeholder="输入 URL"
            className={cn(
              'h-7 min-w-0 flex-1 rounded-[10px] border-transparent bg-transparent px-9 text-sm shadow-none transition-colors',
              'hover:bg-muted/60 focus-visible:border-border focus-visible:bg-transparent focus-visible:ring-1 focus-visible:ring-border',
              !addressFocused && 'text-center',
            )}
            onKeyDown={(event) => {
              if (!showSuggestions) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setSuggestionIndex((current) => (current + direction + suggestions.length) % suggestions.length)
              } else if (event.key === 'Enter' && suggestionIndex >= 0) {
                event.preventDefault()
                const selected = suggestions[suggestionIndex]
                if (selected) navigate(selected.url)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setSuggestions([])
                setSuggestionIndex(-1)
              }
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            type="button"
            title="在默认浏览器中打开"
            aria-label="在默认浏览器中打开"
            disabled={!descriptor.url}
            onClick={() => descriptor.url && void browserRuntime({ method: 'openExternal', params: { url: descriptor.url } })}
            className={cn(
              'absolute right-1 z-10 size-7 rounded-l-none rounded-r-[10px] text-muted-foreground transition-all hover:bg-foreground/5 hover:text-foreground disabled:hidden',
              addressFocused ? 'opacity-100' : 'opacity-0 group-hover/address:opacity-100',
            )}
          >
            <ExternalLink size={13} />
          </Button>
          {showSuggestions && (
            <div className="absolute top-[calc(100%+6px)] right-1 left-1 z-[9998] max-h-80 overflow-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
              {suggestions.map((entry, index) => (
                <Button
                  key={entry.id}
                  type="button"
                  variant="ghost"
                  className={cn('h-auto w-full justify-start rounded-lg px-3 py-2 text-left', index === suggestionIndex && 'bg-accent')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => navigate(entry.url)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{entry.title || entry.url}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{entry.url}</span>
                  </span>
                </Button>
              ))}
            </div>
          )}
        </form>
        <div className="flex shrink-0 items-center justify-end gap-1.5">
        <ToolbarButton
          title={!descriptor.url ? '打开页面后可添加批注' : selecting ? '正在选择…' : annotationMode ? '退出批注模式' : reviewItems.length ? `${reviewItems.length} 项待加入聊天` : '页面批注'}
          active={annotationMode || reviewItems.length > 0 || selecting}
          disabled={selecting || !descriptor.url}
          expanded={annotationMode || reviewItems.length > 0}
          onClick={annotationMode ? exitAnnotationMode : () => startAnnotationSelection()}
        >
          <Highlighter size={15} />
          {(annotationMode || reviewItems.length > 0) && (
            <span>{annotationMode ? '批注中' : '批注'}{reviewItems.length ? ` · ${reviewItems.length}` : ''}</span>
          )}
        </ToolbarButton>
        <DropdownMenu onOpenChange={(open) => {
          if (!open) return
          setDownloadNoticeCount(0)
          void browserRuntime<BrowserDownloadItem[]>({ method: 'downloads:list' }).then(setDownloads).catch(() => undefined)
        }}>
          <DropdownMenuTrigger render={<Button
            variant="ghost"
            size="icon"
            className="relative size-7 shrink-0"
            title={activeDownloads.length ? `${activeDownloads.length} 个下载进行中` : '下载'}
            aria-label="下载"
          />}>
              <DownloadIcon size={15} className={activeDownloads.length ? 'text-primary' : undefined} />
              {activeDownloads.length > 0 && <span className="absolute right-0.5 bottom-0.5 size-1.5 animate-pulse rounded-full bg-primary" />}
              {downloadNoticeCount > 0 && <span className="absolute -top-0.5 -right-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[8px] leading-3.5 font-semibold text-primary-foreground">{downloadNoticeCount}</span>}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[340px]">
            <div className="px-3 py-2 text-xs font-medium">下载</div>
            {[...activeDownloads, ...downloads.slice(0, 10)].length === 0 && <DropdownMenuItem disabled>尚无下载记录</DropdownMenuItem>}
            {activeDownloads.map((download) => (
              <DropdownMenuItem key={download.id} disabled className="items-start">
                <span className="min-w-0"><span className="block truncate">{download.filename}</span><span className="block text-[10px] text-muted-foreground">{formatDownloadBytes(download.receivedBytes)} · 下载中</span></span>
              </DropdownMenuItem>
            ))}
            {downloads.slice(0, 10).map((download) => (
              <DropdownMenuItem key={download.id} disabled className="items-start">
                <span className="min-w-0"><span className="block truncate">{download.filename}</span><span className="block text-[10px] text-muted-foreground">{downloadStateLabel(download.state)} · {formatDownloadBytes(download.receivedBytes)}</span></span>
              </DropdownMenuItem>
            ))}
            {downloads.length > 0 && <><DropdownMenuSeparator /><DropdownMenuItem destructive onSelect={() => void browserRuntime({ method: 'downloads:clear' }).then(() => { setDownloads([]); toast.success('下载历史已清除') })}>清除下载历史</DropdownMenuItem></>}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-7 shrink-0" title="更多" aria-label="更多" />}>
            <MoreHorizontal size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-[240px] p-1.5">
            <DropdownMenuItem disabled={!descriptor.url} onSelect={() => setAuxiliaryPanel('find')}>在页面中查找</DropdownMenuItem>
            <DropdownMenuItem disabled={!descriptor.url} onSelect={() => void browserRuntime({ method: 'print', params: { tabId } })}>打印</DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="flex h-9 items-center gap-1 rounded-lg px-3 text-[12px] text-[var(--text-2)]">
              <span className="min-w-0 flex-1">缩放</span>
              <Button variant="ghost" size="icon-xs" aria-label="缩小" onClick={() => setZoomFactor((descriptor.zoomFactor ?? 1) - .1)}><Minus size={12} /></Button>
              <Button variant="ghost" size="sm" className="h-6 min-w-12 px-1 text-[11px] tabular-nums" disabled={(descriptor.zoomFactor ?? 1) === 1} onClick={() => setZoomFactor(1)}>{Math.round((descriptor.zoomFactor ?? 1) * 100)}%</Button>
              <Button variant="ghost" size="icon-xs" aria-label="放大" onClick={() => setZoomFactor((descriptor.zoomFactor ?? 1) + .1)}><Plus size={12} /></Button>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={toggleDeviceMode}>
              <span className="min-w-0 flex-1">{viewportEnabled ? '隐藏设备工具栏' : '显示设备工具栏'}</span>
              {viewportEnabled && <Check size={13} />}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!descriptor.url} onSelect={() => void browserRuntime({ method: 'screenshot:clipboard', params: { tabId } }).then(() => toast.success('屏幕截图已保存到剪贴板')).catch(() => toast.error('无法捕获屏幕截图'))}>捕获屏幕截图</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setImportOpen(true)}>导入 Cookie 和密码…</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><span className="flex-1">密码和自动填充</span><ChevronRight size={13} /></DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-[220px]">
                <DropdownMenuItem onSelect={() => dataManagersRef.current?.open('passwords')}>密码管理器</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => dataManagersRef.current?.open('contacts')}>联系信息</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => dataManagersRef.current?.open('downloads')}>下载内容</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><span className="flex-1">扩展程序</span><ChevronRight size={13} /></DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-[220px]">
                <DropdownMenuItem onSelect={() => dataManagersRef.current?.open('extensions')}>管理扩展程序</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => dataManagersRef.current?.open('history')}>历史记录</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => dataManagersRef.current?.open('clear')}>清除浏览数据</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openBrowserSettings}>浏览器设置</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        {descriptor.isLoading && <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15"><div className="h-full w-1/2 animate-pulse bg-primary" /></div>}
          </>
        )}
      </div>

      {annotationMode && (
        <div className="relative flex min-h-9 shrink-0 items-center gap-1.5 border-b border-border/60 bg-muted/20 px-2">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={selecting} onClick={() => startAnnotationSelection('element')}>元素</Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={selecting} onClick={() => startAnnotationSelection('text')}>文本</Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={selecting} onClick={() => startAnnotationSelection('region')}>区域</Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={selecting} onClick={() => void selectPage('tweaks')}>Design Tweaks</Button>
          <div className="file-tree-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
            {selecting && <span className="px-2 text-[11px] text-muted-foreground">在页面中选择…</span>}
            {reviewItems.map((item, index) => (
              <div
                key={item.id}
                className={cn('flex h-6 shrink-0 items-center gap-1 rounded-full border bg-background px-2 text-[10px]', item.status === 'stale' && 'border-destructive/50 text-destructive')}
                onMouseEnter={() => highlightReviewItem(item)}
                onMouseLeave={() => highlightReviewItem(null)}
              >
                <span className="max-w-40 truncate">
                  {index + 1}. {item.attachment.origin === 'browser-design-change' ? 'Design' : item.attachment.anchor.kind === 'text' ? '文本' : item.attachment.anchor.kind === 'region' ? '区域' : '元素'}
                  {item.status === 'stale' ? ' · 已失效' : ''}
                </span>
                <Button type="button" variant="ghost" size="icon-xs" className="size-4 rounded-full" aria-label="移除审阅项" onClick={() => removeReviewItem(item.id)}><X size={10} /></Button>
              </div>
            ))}
          </div>
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
              if (event.key === 'Enter') {
                event.preventDefault()
                runFind(!event.shiftKey)
                return
              }
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

      {viewportEnabled && (
        <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-muted/35 px-2.5 text-sm">
          <span className={cn('max-w-28 shrink-0 truncate font-medium', deviceCanvasSize.width < 460 && 'sr-only')}>尺寸：</span>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={cn('h-7 min-w-[100px] max-w-44 justify-between font-medium text-muted-foreground', deviceCanvasSize.width < 600 && 'w-[100px] max-w-[100px]')} />}>
              <span className="truncate">{DEVICE_PRESETS.find((preset) => preset.id === devicePreset)?.label ?? '响应式'}</span><ChevronDown size={12} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[240px]">
              {DEVICE_PRESETS.map((preset) => <DropdownMenuItem key={preset.id} onSelect={() => applyDevicePreset(preset.id)}><span className="flex-1">{preset.label}</span>{preset.id === devicePreset && <Check size={13} />}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <NumberField label="视口宽度" value={viewportWidth} min={240} max={4096} onCommit={(value) => setViewport({ width: value })} />
          <span className="text-muted-foreground">×</span>
          <NumberField label="视口高度" value={viewportHeight} min={160} max={4096} onCommit={(value) => setViewport({ height: value })} />
          <ToolbarButton title="旋转设备" onClick={() => setViewport({ width: viewportHeight, height: viewportWidth }, { preservePreset: true })}><RotateCw size={13} /></ToolbarButton>
          {deviceCanvasSize.width >= 600 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="设备显示缩放" className="h-7 w-[74px] font-medium text-muted-foreground" />}>
                {viewportDisplayScale === 'fit' ? 'Fit' : `${Math.round(viewportDisplayScale * 100)}%`}<ChevronDown size={11} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[180px]">
                {(['fit', .5, .75, 1, 1.25, 1.5, 2] as const).map((scale) => <DropdownMenuItem key={scale} onSelect={() => setViewportDisplayScale(scale)}><span className="flex-1">{scale === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}</span>{scale === viewportDisplayScale && <Check size={13} />}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <ToolbarButton title="退出设备工具栏模式" onClick={toggleDeviceMode}><X size={14} /></ToolbarButton>
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
            <Button variant="ghost" size="sm" className="h-7" onClick={() => startAnnotationSelection('element')}>元素</Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => startAnnotationSelection('text')}>文本</Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => startAnnotationSelection('region')}>区域</Button>
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
      <BrowserDataManagers ref={dataManagersRef} showLauncher={false} onImport={() => setImportOpen(true)} />
      <ConfirmDialog
        open={discardReviewOpen}
        onOpenChange={setDiscardReviewOpen}
        title="丢弃本页全部审阅？"
        description="所有尚未加入聊天的批注和 Design Tweaks 都会被移除，临时样式将恢复。"
        confirmLabel="丢弃全部"
        destructive
        onConfirm={clearReviewSession}
      />
      <div
        ref={deviceCanvasRef}
        className={cn(
          'relative min-h-0 flex-1',
          viewportEnabled ? 'file-tree-scrollbar flex overflow-auto bg-muted/35 p-5' : 'overflow-hidden bg-white',
        )}
      >
        <div
          className={cn(
            'relative',
            viewportEnabled ? 'm-auto shrink-0' : 'size-full',
          )}
          style={viewportEnabled ? { width: deviceFrame.width, height: deviceFrame.height } : undefined}
        >
          <div
            ref={viewportRef}
            className={cn(
              'relative size-full overflow-hidden bg-white',
              viewportEnabled && 'rounded-md shadow-[0_14px_36px_-18px_rgba(0,0,0,0.55)] ring-1 ring-black/15',
            )}
          >
            {ready && (
              <BrowserGuestSurface
                tabId={tabId}
                generation={descriptor.generation}
                guestState={descriptor.guestState}
                className="absolute inset-0"
              />
            )}
            {!ready && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">内置浏览器准备中…</div>}
            {ready && !descriptor.url && !loadError && (
              <div className="absolute inset-0 flex items-center justify-center bg-background p-8 text-center">
                <div className="flex w-full max-w-72 flex-col items-center gap-3">
                  <Globe aria-hidden="true" className="size-8 text-muted-foreground" />
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-lg leading-6 font-medium">开始浏览</p>
                    <p className="text-sm text-muted-foreground">在地址栏中输入网址以打开页面</p>
                  </div>
                </div>
              </div>
            )}
            {loadError && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6">
                <div className="max-w-sm">
                  <ShieldAlert className="mb-4 text-muted-foreground" size={30} />
                  <p className="text-[16px] font-medium">此网站无法访问</p>
                  <p className="mt-1 break-words text-[12px] text-muted-foreground">{safeHost(descriptor.url) || '页面'} 暂时无法响应。</p>
                  <p className="mt-4 text-[11px] text-muted-foreground">你可以尝试：</p>
                  <ul className="mt-1 list-inside list-disc space-y-1 text-[11px] text-muted-foreground">
                    <li>检查网络连接</li>
                    <li>检查代理服务器和防火墙</li>
                    <li>稍后重新加载页面</li>
                  </ul>
                  <p className="mt-3 break-words font-mono text-[10px] text-muted-foreground/70">{loadError}</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => run('reload')}>重新加载</Button>
                </div>
              </div>
            )}
            {!loadError && descriptor.lifecycle === 'crashed' && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6 text-center">
                <div className="max-w-xs">
                  <ShieldAlert className="mx-auto mb-4 text-muted-foreground" size={30} />
                  <p className="text-[16px] font-medium">页面发生崩溃</p>
                  <p className="mt-1 text-[12px] text-muted-foreground">重新加载页面即可创建新的渲染进程。</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => run('reload')}>重新加载</Button>
                </div>
              </div>
            )}
          </div>
          {viewportEnabled && devicePreset === 'responsive' && <ViewportResizeHandles active={resizingViewport} onResizeStart={beginViewportResize} />}
        </div>
        {viewportEnabled && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border/70 bg-background/90 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground shadow-sm backdrop-blur">
            {viewportWidth} × {viewportHeight} · {Math.round(deviceFrame.scale * 100)}%
          </div>
        )}
      </div>
    </div>
  )
}

function ToolbarButton({ children, title, active, expanded, disabled, onClick }: {
  children: ReactNode
  title: string
  active?: boolean
  expanded?: boolean
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
      className={cn('h-7 shrink-0 gap-1 px-1.5', expanded ? 'w-auto' : 'w-7')}
    >
      {children}
    </Button>
  )
}

function ViewportResizeHandles({ active, onResizeStart }: {
  active: boolean
  onResizeStart: (axis: ViewportResizeAxis, event: ReactPointerEvent<HTMLElement>) => void
}) {
  const handleClass = cn(
    'absolute z-20 flex touch-none items-center justify-center rounded-none bg-muted-foreground/45 p-0 text-background outline-none hover:bg-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-ring',
    active && 'bg-primary/60 hover:bg-primary/70',
  )
  return (
    <>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从左侧调整设备视口" className={cn(handleClass, '-left-5 top-0 bottom-0 w-5 cursor-ew-resize')} onPointerDown={(event) => onResizeStart('west', event)}>
        <span className="flex h-9 w-5 items-center justify-center gap-0.5"><span className="h-8 w-0.5 rounded-full bg-background/75" /><span className="h-8 w-0.5 rounded-full bg-background/75" /></span>
      </Button>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从右侧调整设备视口" className={cn(handleClass, '-right-5 top-0 bottom-0 w-5 cursor-ew-resize')} onPointerDown={(event) => onResizeStart('east', event)}>
        <span className="flex h-9 w-5 items-center justify-center gap-0.5"><span className="h-8 w-0.5 rounded-full bg-background/75" /><span className="h-8 w-0.5 rounded-full bg-background/75" /></span>
      </Button>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从底部调整设备视口" className={cn(handleClass, 'top-full -right-5 -left-5 h-5 w-auto cursor-ns-resize')} onPointerDown={(event) => onResizeStart('south', event)}>
        <span className="flex h-5 w-9 flex-col items-center justify-center gap-0.5"><span className="h-0.5 w-8 rounded-full bg-background/75" /><span className="h-0.5 w-8 rounded-full bg-background/75" /></span>
      </Button>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从左下角调整设备视口" className={cn(handleClass, 'top-full -left-5 size-5 cursor-nesw-resize')} onPointerDown={(event) => onResizeStart('south-west', event)}>
        <ResizeCornerIcon flip />
      </Button>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从右下角调整设备视口" className={cn(handleClass, 'top-full -right-5 size-5 cursor-nwse-resize')} onPointerDown={(event) => onResizeStart('south-east', event)}>
        <ResizeCornerIcon />
      </Button>
    </>
  )
}

function ResizeCornerIcon({ flip = false }: { flip?: boolean }) {
  return (
    <svg aria-hidden="true" className={cn('size-5', flip && '-scale-x-100')} fill="none" viewBox="0 0 20 20">
      <path d="M6 11.75 11.75 6" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
      <path d="M7 15.5 15.5 7" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
    </svg>
  )
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
    <label>
      <span className="sr-only">{label}</span>
      <Input
        aria-label={label}
        value={draft}
        type="number"
        min={min}
        max={max}
        step={step}
        className="h-6 w-[72px] rounded-lg border-transparent bg-foreground/5 px-2 text-center text-sm font-semibold tabular-nums hover:bg-accent focus-visible:bg-background"
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

function safeHost(value: string): string {
  try { return new URL(value).host } catch { return '' }
}

function downloadStateLabel(state: BrowserDownloadItem['state']): string {
  if (state === 'completed') return '已完成'
  if (state === 'cancelled') return '已取消'
  return '已中断'
}

function formatDownloadBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function getDeviceFrameSize(width: number, height: number, canvasWidth: number, canvasHeight: number, displayScale: ViewportDisplayScale) {
  if (displayScale !== 'fit') return { width: Math.round(width * displayScale), height: Math.round(height * displayScale), scale: displayScale }
  if (!canvasWidth || !canvasHeight) return { width, height, scale: 1 }
  const scale = Math.min(1, Math.max(0.2, (canvasWidth - 40) / width), Math.max(0.2, (canvasHeight - 40) / height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

function clampViewportWidth(value: number): number {
  return Math.max(240, Math.min(4096, value))
}

function clampViewportHeight(value: number): number {
  return Math.max(160, Math.min(4096, value))
}

function resolveDevicePreset(viewport: BrowserViewportState): DevicePresetId {
  const rawPreset = viewport.preset as string | undefined
  const persistedPreset = rawPreset === 'laptop-large'
    ? 'laptop-l'
    : rawPreset === 'galaxy-s24-ultra'
      ? 'samsung-galaxy-s24-ultra'
      : rawPreset
  if (persistedPreset && DEVICE_PRESETS.some((preset) => preset.id === persistedPreset)) return persistedPreset as DevicePresetId
  const exact = DEVICE_PRESETS.find((preset) => preset.width === viewport.width && preset.height === viewport.height && preset.deviceScaleFactor === viewport.deviceScaleFactor)
  return exact?.id ?? 'responsive'
}

const DEVICE_PRESETS = [
  { id: 'responsive', label: '响应式', width: 390, height: 844, deviceScaleFactor: 1 },
  { id: '4k', label: '4K', width: 2560, height: 1440, deviceScaleFactor: 1 },
  { id: 'laptop-l', label: 'Laptop L', width: 1440, height: 900, deviceScaleFactor: 1 },
  { id: 'laptop', label: 'Laptop', width: 1024, height: 768, deviceScaleFactor: 1 },
  { id: 'surface-pro-7', label: 'Surface Pro 7', width: 912, height: 1368, deviceScaleFactor: 2 },
  { id: 'ipad-air', label: 'iPad Air', width: 820, height: 1180, deviceScaleFactor: 2 },
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024, deviceScaleFactor: 2 },
  { id: 'surface-duo', label: 'Surface Duo', width: 540, height: 720, deviceScaleFactor: 2.5 },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', width: 430, height: 932, deviceScaleFactor: 3 },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915, deviceScaleFactor: 2.625 },
  { id: 'iphone-15-pro', label: 'iPhone 15 Pro', width: 393, height: 852, deviceScaleFactor: 3 },
  { id: 'samsung-galaxy-s24-ultra', label: 'Samsung Galaxy S24 Ultra', width: 384, height: 824, deviceScaleFactor: 3 },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, deviceScaleFactor: 2 },
] as const

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
