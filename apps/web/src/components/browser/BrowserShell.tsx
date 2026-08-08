import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  ExternalLink,
  Globe,
  MoreHorizontal,
  MessageCirclePlus,
  MessageCircle,
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
  BrowserAnnotationSessionSnapshot,
  BrowserHistoryEntry,
  BrowserTabDescriptor,
  BrowserViewportState,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { browserRuntime, createBrowserReferenceGrant, listBrowserReferenceCandidates, onBrowserEvent } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import { normalizeUrl } from './browser-url'
import { BrowserImportModal } from './BrowserImportModal'
import { BrowserGuestSurface } from './BrowserWebviewPool'
import { CommentList } from './CommentList'
import { activeTabIdAtom, agentBrowserAttachmentsAtom, browserPageDraftsAtom, browserReviewCoachmarkSeenAtom, browserReviewSessionsAtom, settingsInitialTabAtom, tabsAtom } from '@/atoms'
import { BrowserDataManagers, type BrowserDataManagersHandle } from '@/components/settings/BrowserDataManagers'

type AuxiliaryPanel = 'find' | 'annotation' | 'tweaks' | null
type PageSelection = { anchor: AgentBrowserAnchor; originalStyles: Record<string, string> }
type BrowserActiveDownload = { id: string; filename: string; actor: 'user' | 'agent'; state: 'progressing'; receivedBytes: number; totalBytes: number }
type BrowserPageDialog = {
  id: string
  type: 'alert' | 'beforeunload' | 'confirm' | 'prompt'
  message: string
  promptText: string
}
type DevicePresetId = typeof DEVICE_PRESETS[number]['id']
type ViewportResizeAxis = 'west' | 'east' | 'south' | 'south-west' | 'south-east'
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
  const [pendingBrowserAttachments, setPendingBrowserAttachments] = useAtom(agentBrowserAttachmentsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom)
  const draftKey = `${ownerThreadId ?? 'unscoped'}:${tabId}`
  const initialDraft = pageDrafts[draftKey]
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const deviceCanvasRef = useRef<HTMLDivElement | null>(null)
  const responsiveViewportSizeRef = useRef<{ width: number; height: number } | null>(null)
  const annotationModeRef = useRef(false)
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
  const [deviceCanvasSize, setDeviceCanvasSize] = useState({ width: 0, height: 0 })
  const [viewportRotationKey, setViewportRotationKey] = useState(0)
  const [pageSelection, setPageSelection] = useState<PageSelection | null>(initialDraft ? { anchor: initialDraft.anchor, originalStyles: initialDraft.originalStyles } : null)
  const [annotationBody, setAnnotationBody] = useState(initialDraft?.body ?? '')
  const [tweakDraft, setTweakDraft] = useState<Record<string, string>>(initialDraft?.proposedStyles ?? {})
  const [selecting, setSelecting] = useState(false)
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotationSession, setAnnotationSession] = useState<BrowserAnnotationSessionSnapshot | null>(null)
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false)
  const [editingReviewItemId, setEditingReviewItemId] = useState<string | null>(null)
  const [discardReviewOpen, setDiscardReviewOpen] = useState(false)
  const [showingOriginal, setShowingOriginal] = useState(false)
  const [activeDownloads, setActiveDownloads] = useState<BrowserActiveDownload[]>([])
  const [downloadNoticeCount, setDownloadNoticeCount] = useState(0)
  const [pageDialog, setPageDialog] = useState<BrowserPageDialog | null>(null)
  const [pageDialogBusy, setPageDialogBusy] = useState(false)
  const showSuggestions = addressFocused && suggestions.length > 0
  const reviewSession = reviewSessions[draftKey]
  const reviewItems = reviewSession?.items ?? []
  const pendingThreadAttachments = ownerThreadId ? pendingBrowserAttachments[ownerThreadId] : undefined
  const pendingPageAnnotations = (pendingThreadAttachments ?? []).filter((attachment): attachment is AgentBrowserAnnotationAttachment => (
    attachment.origin === 'browser-annotation'
      && attachment.tab.tabId === tabId
      && attachment.tab.url === descriptor.url
  ))
  const sessionPageAnnotations = annotationSession?.comments.filter((comment) => comment.tab.tabId === tabId && comment.tab.url === descriptor.url) ?? []
  const currentAnnotationCount = new Set([...sessionPageAnnotations.map((comment) => comment.id), ...pendingPageAnnotations.map((comment) => comment.id)]).size
  // Task 94：未读批注计数（!readAt && !isResolved）。线程整体 resolved 时由 CommentList
  // deriveThreads 内部归零；此处用同语义的 per-comment 过滤（与徽标显示一致即可，不重复线程分组逻辑）。
  const unreadAnnotationCount = (annotationSession?.comments ?? []).filter((comment) => !comment.readAt && !comment.isResolved).length
  const annotationComments = annotationSession?.comments ?? []
  const hasPendingReview = reviewItems.length > 0 || currentAnnotationCount > 0 || Boolean(reviewSession?.screenshotRef)
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
        ...(auxiliaryPanel === 'annotation'
          ? { body: annotationBody }
          : { proposedStyles: tweakDraft, ...(annotationBody.trim() ? { body: annotationBody } : {}) }),
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
    if (!ready || !session || !descriptor.url) return
    const screenshotStale = Boolean(session.screenshotRef) && (session.url !== descriptor.url || session.generation !== descriptor.generation)
    const items = session.items.map((item) => ({
      ...item,
      status: item.attachment.tab.url === descriptor.url && item.attachment.tab.generation === descriptor.generation ? 'valid' as const : 'stale' as const,
    }))
    if (!screenshotStale && session.items.every((item, index) => item.status === items[index]?.status)) return
    if (screenshotStale && session.screenshotRef) {
      void browserRuntime({ method: 'screenshot:attachment:delete', params: { tabId, screenshotRef: session.screenshotRef } }).catch(() => undefined)
    }
    setReviewSessions((current) => ({
      ...current,
      [draftKey]: {
        ...session,
        ...(screenshotStale ? { screenshotRef: undefined } : {}),
        items,
        updatedAt: new Date().toISOString(),
      },
    }))
  }, [descriptor.generation, descriptor.url, draftKey, ready, reviewSessions, setReviewSessions])

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
      const preset = resolveDevicePreset(next.viewport)
      setDevicePreset(preset)
      if (preset === 'responsive') responsiveViewportSizeRef.current = { width: next.viewport.width, height: next.viewport.height }
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let established = false
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
      established = true
      if (disposed) return
      acceptDescriptor(next)
      setReady(true)
    }).catch(() => setReady(false))

    void onBrowserEvent((event) => {
      if (event.params.tabId !== tabId) return
      if (event.method === 'browser:annotation-state' && event.params.threadId === ownerThreadId) {
        const snapshot = event.params as unknown as BrowserAnnotationSessionSnapshot
        const inAnnotationMode = snapshot.mode === 'comment'
        setAnnotationSession(snapshot)
        annotationModeRef.current = inAnnotationMode
        setAnnotationMode(inAnnotationMode)
        if (!inAnnotationMode) setSelecting(false)
      }
      if (event.method === 'browser:annotation-selection' && event.params.threadId === ownerThreadId && event.params.purpose === 'tweaks' && event.params.anchor && typeof event.params.anchor === 'object') {
        const originalStyles = event.params.originalStyles && typeof event.params.originalStyles === 'object' && !Array.isArray(event.params.originalStyles)
          ? Object.fromEntries(Object.entries(event.params.originalStyles as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string>
          : {}
        setPageSelection({ anchor: event.params.anchor as AgentBrowserAnchor, originalStyles })
        setAuxiliaryPanel('tweaks')
        annotationModeRef.current = true
        setAnnotationMode(true)
      }
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
        const dialogId = typeof event.params.dialogId === 'string' ? event.params.dialogId : ''
        const type = event.params.type === 'prompt' || event.params.type === 'confirm' || event.params.type === 'beforeunload'
          ? event.params.type
          : 'alert'
        if (dialogId) setPageDialog({
          id: dialogId,
          type,
          message: typeof event.params.message === 'string' ? event.params.message : '',
          promptText: typeof event.params.defaultValue === 'string' ? event.params.defaultValue : '',
        })
      }
      if (event.method === 'browser:dialog-closed') {
        setPageDialog((current) => !current || current.id === event.params.dialogId ? null : current)
      }
    }).then((dispose) => {
      if (disposed) dispose()
      else stopListening = dispose
    })

    return () => {
      disposed = true
      stopListening?.()
      if (established) {
        if (descriptorRef.current.guestState === 'ready') {
          void browserRuntime<{ x: number; y: number }>({ method: 'scroll:get', params: { tabId } })
            .then((scrollPosition) => onDescriptorChangeRef.current?.({ ...descriptorRef.current, scrollPosition }))
            .catch(() => undefined)
        }
        void browserRuntime({ method: 'visible', params: { tabId, visible: false } }).catch(() => undefined)
      }
    }
  }, [acceptDescriptor, ownerThreadId, tabId])

  useEffect(() => {
    if (!ready || !ownerThreadId) return
    void browserRuntime<BrowserAnnotationSessionSnapshot>({ method: 'annotation:session', params: { tabId, threadId: ownerThreadId } })
      .then(setAnnotationSession)
      .catch(() => undefined)
    const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem('browser-review-sessions-v1') : null
    if (!legacy) return
    try {
      void browserRuntime({ method: 'annotation:migrate', params: { sessions: JSON.parse(legacy) } }).then(async () => {
        localStorage.removeItem('browser-review-sessions-v1')
        const refreshed = await browserRuntime<BrowserAnnotationSessionSnapshot>({ method: 'annotation:session', params: { tabId, threadId: ownerThreadId } })
        setAnnotationSession(refreshed)
      }).catch(() => undefined)
    } catch { localStorage.removeItem('browser-review-sessions-v1') }
  }, [ownerThreadId, ready, tabId])

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

  const handlePageDialog = (accept: boolean) => {
    const current = pageDialog
    if (!current || pageDialogBusy) return
    setPageDialogBusy(true)
    void browserRuntime({
      method: 'dialog:handle',
      params: {
        tabId,
        dialogId: current.id,
        accept,
        ...(current.type === 'prompt' && accept ? { promptText: current.promptText } : {}),
      },
    }).catch(() => toast.error('网页对话框已失效')).finally(() => {
      setPageDialog((value) => value?.id === current.id ? null : value)
      setPageDialogBusy(false)
    })
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
      .then((result) => acceptDescriptor({ ...descriptorRef.current, zoomFactor: result.factor }))
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
        if (descriptorRef.current.generation !== previous.generation || descriptorRef.current.viewportRevision !== revision) return
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
    const nextPreset = options?.preservePreset ? devicePreset : 'responsive'
    const nextScale = patch.deviceScaleFactor ?? (nextPreset === 'responsive' ? 1 : deviceScaleFactor)
    const nextMobile = patch.mobile ?? (nextPreset === 'responsive' ? false : descriptorRef.current.viewport?.mobile ?? false)
    const nextTouch = patch.touch ?? (nextPreset === 'responsive' ? false : descriptorRef.current.viewport?.touch ?? false)
    setViewportWidth(nextWidth)
    setViewportHeight(nextHeight)
    setDeviceScaleFactor(nextScale)
    setDevicePreset(nextPreset)
    if (nextPreset === 'responsive') responsiveViewportSizeRef.current = { width: nextWidth, height: nextHeight }
    commitViewport({
      enabled: true,
      width: nextWidth,
      height: nextHeight,
      deviceScaleFactor: nextScale,
      mobile: nextMobile,
      touch: nextTouch,
      preset: nextPreset,
      displayScale: descriptorRef.current.viewport?.displayScale ?? 'fit',
    }, '设备视口设置失败')
  }

  const applyDevicePreset = (presetId: DevicePresetId) => {
    const preset = DEVICE_PRESETS.find((candidate) => candidate.id === presetId)
    if (!preset) return
    setDevicePreset(presetId)
    if (presetId === 'responsive') {
      setDeviceScaleFactor(1)
      responsiveViewportSizeRef.current = { width: viewportWidth, height: viewportHeight }
      commitViewport({
        enabled: true,
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
        preset: presetId,
        displayScale: descriptorRef.current.viewport?.displayScale ?? 'fit',
      }, '设备视口设置失败')
      return
    }
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
      displayScale: descriptorRef.current.viewport?.displayScale ?? 'fit',
    }, '设备视口设置失败')
  }

  const setDeviceDisplayScale = (displayScale: BrowserViewportState['displayScale']) => {
    const viewport = descriptorRef.current.viewport
    if (!viewport?.enabled) return
    commitViewport({ ...viewport, displayScale }, '设备显示缩放设置失败')
  }

  const toggleDeviceMode = () => {
    if (descriptor.viewport?.enabled) {
      if (devicePreset === 'responsive') responsiveViewportSizeRef.current = { width: viewportWidth, height: viewportHeight }
      commitViewport({ enabled: false, width: 0, height: 0, deviceScaleFactor: 1, mobile: false, touch: false, preset: 'desktop', displayScale: 'fit' }, '无法关闭设备模式')
      return
    }
    const responsiveViewport = responsiveViewportSizeRef.current ?? (deviceCanvasSize.width > 0 && deviceCanvasSize.height > 0
      ? {
          width: clampViewportWidth(deviceCanvasSize.width - 40),
          height: clampViewportHeight(deviceCanvasSize.height - 20),
        }
      : { width: RESPONSIVE_DEVICE_PRESET.width, height: RESPONSIVE_DEVICE_PRESET.height })
    setDevicePreset('responsive')
    setViewportWidth(responsiveViewport.width)
    setViewportHeight(responsiveViewport.height)
    setDeviceScaleFactor(1)
    responsiveViewportSizeRef.current = responsiveViewport
    commitViewport({
      enabled: true,
      width: responsiveViewport.width,
      height: responsiveViewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
      preset: 'responsive',
      displayScale: 'fit',
    }, '无法打开设备模式')
  }

  const rotateViewport = () => {
    setViewportRotationKey((current) => current + 1)
    setViewport({ width: viewportHeight, height: viewportWidth }, { preservePreset: true })
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
    const maximumDragWidth = Math.max(240, (deviceCanvasSize.width - 40) / startScale)
    const maximumDragHeight = Math.max(160, (deviceCanvasSize.height - 20) / startScale)
    let nextWidth = startWidth
    let nextHeight = startHeight
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = axis === 'west' || axis === 'east' ? 'ew-resize' : axis === 'south' ? 'ns-resize' : axis === 'south-west' ? 'nesw-resize' : 'nwse-resize'
    document.body.style.userSelect = 'none'
    setDevicePreset('responsive')

    const onMove = (moveEvent: PointerEvent) => {
      const horizontalDelta = Math.round(((moveEvent.clientX - startX) * 2) / startScale)
      const verticalDelta = Math.round((moveEvent.clientY - startY) / startScale)
      if (axis === 'west' || axis === 'south-west') nextWidth = clampViewportWidth(Math.min(maximumDragWidth, startWidth - horizontalDelta))
      if (axis === 'east' || axis === 'south-east') nextWidth = clampViewportWidth(Math.min(maximumDragWidth, startWidth + horizontalDelta))
      if (axis === 'south' || axis === 'south-west' || axis === 'south-east') nextHeight = clampViewportHeight(Math.min(maximumDragHeight, startHeight + verticalDelta))
      setViewportWidth(nextWidth)
      setViewportHeight(nextHeight)
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      setViewport({ width: nextWidth, height: nextHeight })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const startAnnotationSelection = async (mode: 'auto' | 'element' | 'text' | 'region' = 'auto') => {
    annotationModeRef.current = true
    setAnnotationMode(true)
    if (!reviewCoachmarkSeen) setReviewCoachmarkSeen(true)
    try {
      await browserRuntime({ method: 'annotation:mode', params: { tabId, threadId: ownerThreadId, mode: 'comment', purpose: 'annotation', selectionMode: mode, theme: browserAnnotationThemeColor() } })
    } catch {
      annotationModeRef.current = false
      setAnnotationMode(false)
      setSelecting(false)
      toast.error('批注模式启动失败')
    }
  }

  const startDesignSelection = async () => {
    annotationModeRef.current = true
    setAnnotationMode(true)
    try {
      await browserRuntime({ method: 'annotation:mode', params: { tabId, threadId: ownerThreadId, mode: 'comment', purpose: 'tweaks', selectionMode: 'element', theme: browserAnnotationThemeColor() } })
    } catch {
      annotationModeRef.current = false
      setAnnotationMode(false)
      toast.error('设计调整模式启动失败')
    }
  }

  const exitAnnotationMode = () => {
    annotationModeRef.current = false
    setAnnotationMode(false)
    setSelecting(false)
    setAuxiliaryPanel((current) => current === 'annotation' || current === 'tweaks' ? null : current)
    void browserRuntime({ method: 'annotation:mode', params: { tabId, threadId: ownerThreadId, mode: 'browse' } }).catch(() => undefined)
  }

  useEffect(() => {
    const handleAnnotationShortcut = (event: globalThis.KeyboardEvent) => {
      if (!descriptorRef.current.url || event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key !== '.') return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      if (annotationModeRef.current) exitAnnotationMode()
      else startAnnotationSelection()
    }
    window.addEventListener('keydown', handleAnnotationShortcut)
    return () => window.removeEventListener('keydown', handleAnnotationShortcut)
  }, [descriptor.url])

  const clearReviewSession = () => {
    const screenshotRef = reviewSessions[draftKey]?.screenshotRef
    if (screenshotRef) void browserRuntime({ method: 'screenshot:attachment:delete', params: { tabId, screenshotRef } }).catch(() => undefined)
    setReviewSessions((current) => {
      if (!current[draftKey]) return current
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    annotationModeRef.current = false
    setAnnotationMode(false)
    setAuxiliaryPanel(null)
    setPageSelection(null)
    setEditingReviewItemId(null)
    clearPageDraft()
    if (ownerThreadId) void browserRuntime({ method: 'annotation:clear', params: { tabId, threadId: ownerThreadId } }).catch(() => undefined)
    void setOriginalPreview(true).finally(() => setShowingOriginal(false))
  }

  const tabAttachment = (): AgentBrowserTabAttachment | null => {
    if (!descriptor.providerTabId || !descriptor.url) return null
    return {
      id: `browser-tab:${descriptor.providerTabId}:${descriptor.generation}`,
      origin: 'browser-tab',
      backend: 'iab',
      browserId: 'lume-iab',
      tabId: descriptor.tabId,
      providerTabId: descriptor.providerTabId,
      title: descriptor.title || descriptor.url,
      url: descriptor.url,
      generation: descriptor.generation,
      ...(descriptor.ownerThreadId ? { ownerThreadId: descriptor.ownerThreadId } : {}),
    }
  }

  const authorizeTabAttachment = async (tab: AgentBrowserTabAttachment): Promise<AgentBrowserTabAttachment> => {
    if (!ownerThreadId || tab.referenceGrantId || !tab.providerTabId || tab.generation === undefined) return tab
    const candidate = (await listBrowserReferenceCandidates(ownerThreadId)).find((item) => (
      item.backend === 'iab'
      && item.tabId === tab.tabId
      && item.providerTabId === tab.providerTabId
      && item.generation === tab.generation
      && item.title === tab.title
      && item.url === tab.url
    ))
    if (!candidate) return tab
    const grant = await createBrowserReferenceGrant({
      ...candidate,
      threadId: ownerThreadId,
      access: 'control',
    })
    return { ...tab, referenceGrantId: grant.referenceGrantId, access: 'control' }
  }

  const addCurrentTabToChat = async () => {
    const tab = tabAttachment()
    if (!tab) return
    try {
      enqueueBrowserAttachment(await authorizeTabAttachment(tab))
    } catch {
      toast.error('网页引用授权失败，页面可能已变化')
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
    try {
      const authorizedTabs = new Map<string, AgentBrowserTabAttachment>()
      const attachments: AgentBrowserAttachment[] = []
      for (const item of session.items) {
        const originalTab = item.attachment.tab
        const tab = item.attachment.origin === 'browser-annotation' || item.attachment.origin === 'browser-design-change'
          ? originalTab
          : authorizedTabs.get(originalTab.tabId) ?? await authorizeTabAttachment(originalTab)
        authorizedTabs.set(originalTab.tabId, tab)
        attachments.push({
          ...item.attachment,
          tab,
        })
      }
      attachments.forEach(enqueueBrowserAttachment)
    } catch {
      toast.error('网页批注授权失败，批注仍保留在审阅队列')
      return
    }
    setReviewSessions((current) => {
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    annotationModeRef.current = false
    setAnnotationMode(false)
    toast.success(`${session.items.length} 项网页审阅已添加到当前消息`)
  }

  const removeReviewItem = (id: string) => {
    const removed = reviewItems.find((item) => item.id === id)
    if (removed?.attachment.origin === 'browser-annotation' && ownerThreadId) void browserRuntime({ method: 'annotation:delete', params: { tabId, threadId: ownerThreadId, annotationId: id } }).catch(() => undefined)
    const domPath = removed?.attachment.origin === 'browser-design-change' ? removed.attachment.anchor.domPath : undefined
    if (domPath) void browserRuntime({ method: 'tweaks:reset', params: { tabId, domPath } }).catch(() => undefined)
    setReviewSessions((current) => {
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
    if (editingReviewItemId === id) closeReviewEditor()
  }

  const setOriginalPreview = async (original: boolean) => {
    setShowingOriginal(original)
    if (surface === 'right-panel' && ownerThreadId) {
      await browserRuntime({ method: 'annotation:preview', params: { tabId, threadId: ownerThreadId, original } }).catch(() => undefined)
      return
    }
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

  const closeReviewEditor = () => {
    setAuxiliaryPanel(null)
    setPageSelection(null)
    setAnnotationBody('')
    setTweakDraft({})
    setEditingReviewItemId(null)
    clearPageDraft()
  }

  const discardCurrentPageAnnotations = () => {
    const annotationIds = new Set(pendingPageAnnotations.map((attachment) => attachment.id))
    if (ownerThreadId && annotationIds.size > 0) {
      setPendingBrowserAttachments((current) => ({
        ...current,
        [ownerThreadId]: (current[ownerThreadId] ?? []).filter((attachment) => !annotationIds.has(attachment.id)),
      }))
    }
    const screenshotRef = reviewSessions[draftKey]?.screenshotRef
    if (screenshotRef) void browserRuntime({ method: 'screenshot:attachment:delete', params: { tabId, screenshotRef } }).catch(() => undefined)
    setReviewSessions((current) => {
      if (!current[draftKey]) return current
      const next = { ...current }
      delete next[draftKey]
      return next
    })
    setAuxiliaryPanel(null)
    setPageSelection(null)
    setAnnotationBody('')
    setEditingReviewItemId(null)
    clearPageDraft()
    if (ownerThreadId) void browserRuntime({ method: 'annotation:clear', params: { tabId, threadId: ownerThreadId } }).catch(() => undefined)
  }

  const sendCurrentPageAnnotations = () => {
    if (!ownerThreadId || currentAnnotationCount === 0) return
    void browserRuntime({ method: 'annotation:submit', params: { tabId, threadId: ownerThreadId } }).then(() => exitAnnotationMode()).catch(() => toast.error('网页批注发送失败'))
  }

  // Task 94：评审面板回调 → IPC → manager store。CommentList 传线程根评论 id（root.id）作为
  // annotationId；store resolveComment/markRead 据此翻 isResolved/readAt，deriveThreads 再以
  // group.some 把整线显示为已解决。失败只 toast，不退出面板（用户可重试）。
  const handleResolveThread = (annotationId: string) => {
    if (!ownerThreadId) return
    void browserRuntime({ method: 'annotation:resolve', params: { tabId, threadId: ownerThreadId, annotationId, resolvedBy: 'user' } })
      .then((snapshot) => setAnnotationSession(snapshot as BrowserAnnotationSessionSnapshot))
      .catch(() => toast.error('解决线程失败'))
  }
  const handleMarkThreadRead = (annotationId: string) => {
    if (!ownerThreadId) return
    void browserRuntime({ method: 'annotation:mark-read', params: { tabId, threadId: ownerThreadId, annotationId } })
      .then((snapshot) => setAnnotationSession(snapshot as BrowserAnnotationSessionSnapshot))
      .catch(() => toast.error('标记已读失败'))
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
    const existing = editingReviewItemId ? reviewItems.find((item) => item.id === editingReviewItemId && item.attachment.origin === 'browser-design-change') : undefined
    const attachment: AgentBrowserDesignChangeAttachment = {
      id: existing?.id ?? `browser-design-change:${crypto.randomUUID()}`,
      origin: 'browser-design-change',
      tab,
      anchor: selection.anchor,
      originalStyles: selection.originalStyles,
      proposedStyles: styles,
      ...(annotationBody.trim() ? { body: annotationBody.trim() } : {}),
    }
    enqueueReviewAttachment(attachment)
    closeReviewEditor()
  }

  const securityLabel = descriptor.securityState === 'secure'
    ? '连接安全'
    : descriptor.securityState === 'local'
      ? '本地站点'
      : descriptor.securityState === 'insecure'
        ? '连接不安全'
        : '站点信息'

  const viewportEnabled = descriptor.viewport?.enabled === true
  const deviceDisplayScale = descriptor.viewport?.displayScale ?? 'fit'
  const deviceFrame = getDeviceFrameSize(
    viewportWidth,
    viewportHeight,
    deviceCanvasSize.width,
    deviceCanvasSize.height,
    deviceDisplayScale,
  )
  const reviewSurfaceWidth = viewportEnabled ? deviceFrame.width : deviceCanvasSize.width
  const reviewSurfaceHeight = viewportEnabled ? deviceFrame.height : deviceCanvasSize.height
  const reviewScale = viewportEnabled ? deviceFrame.scale : 1
  const reviewEditorPosition = pageSelection && reviewSurfaceWidth > 0 && reviewSurfaceHeight > 0 && (auxiliaryPanel === 'annotation' || auxiliaryPanel === 'tweaks')
    ? getBrowserReviewOverlayPosition(
        pageSelection.anchor.rect,
        reviewScale,
        reviewSurfaceWidth,
        reviewSurfaceHeight,
        auxiliaryPanel === 'tweaks' ? 344 : surface === 'right-panel' ? 368 : 294,
        auxiliaryPanel === 'tweaks' ? 420 : 150,
      )
    : null
  const currentZoomPercent = Math.round((descriptor.zoomFactor ?? 1) * 100)
  const pageActionsDisabled = !descriptor.url
  const hasQueuedTweaks = reviewItems.some((item) => item.attachment.origin === 'browser-design-change')
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background text-foreground', className)}>
      <div className={cn(
        'relative z-10 flex h-[50px] shrink-0 items-center gap-2 border-b border-border/70 px-3 text-muted-foreground',
        surface === 'right-panel' && 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] text-muted-foreground',
        annotationMode && 'bg-primary/10 px-3 text-foreground',
        annotationMode && surface === 'right-panel' && 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] text-foreground',
      )}>
        {annotationMode ? (
          <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-1.5">
              {surface === 'right-panel' && <>
                <ToolbarButton title="退出批注" onClick={exitAnnotationMode}><X size={15} /></ToolbarButton>
                <ToolbarButton title="删除本页批注" disabled={!hasPendingReview} onClick={discardCurrentPageAnnotations}><Trash2 size={15} /></ToolbarButton>
              </>}
              {surface !== 'right-panel' && <>
                <ToolbarButton title="退出批注" onClick={exitAnnotationMode}><X size={14} /></ToolbarButton>
                <ToolbarButton title="丢弃全部" disabled={!hasPendingReview} onClick={() => setDiscardReviewOpen(true)}><Trash2 size={14} /></ToolbarButton>
              </>}
            </div>
            <div className="min-w-0 truncate text-center text-sm leading-[18px]">
              <span>{surface === 'right-panel' ? `正在批注 · ${browserToolbarTitle(descriptor.url)}` : `${showingOriginal ? '原始页面' : '批注中'} · ${descriptor.url || '网页审阅'}`}</span>
            </div>
            <div className="flex min-w-0 items-center justify-end gap-3">
              {surface !== 'right-panel' && <ToolbarButton
                title="退出注释"
                active
                onClick={exitAnnotationMode}
              >
                <MessageCirclePlus size={15} />
              </ToolbarButton>}
              <ToolbarButton title="为当前批注准备截图" disabled={!ownerThreadId || !currentAnnotationCount} onClick={() => {
                if (!ownerThreadId) return
                void browserRuntime<BrowserAnnotationSessionSnapshot>({ method: 'annotation:screenshot:prepare', params: { tabId, threadId: ownerThreadId } })
                  .then(setAnnotationSession)
                  .then(() => toast.success('截图已准备'))
                  .catch(() => toast.error('无法准备网页截图'))
              }}><Camera size={14} /></ToolbarButton>
              {surface === 'right-panel' && <ToolbarButton
                title="按住查看原始页面"
                active={showingOriginal}
                disabled={!currentAnnotationCount}
                onPointerDown={() => void setOriginalPreview(true)}
                onPointerUp={() => void setOriginalPreview(false)}
                onPointerCancel={() => showingOriginal && void setOriginalPreview(false)}
                onPointerLeave={() => showingOriginal && void setOriginalPreview(false)}
                onBlur={() => showingOriginal && void setOriginalPreview(false)}
                onKeyDown={(event) => {
                  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                    event.preventDefault()
                    void setOriginalPreview(true)
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault()
                    void setOriginalPreview(false)
                  }
                }}
              >
                <span className={cn('inline-flex items-center justify-center transition-transform', showingOriginal && 'scale-[0.8]')}><Eye size={14} /></span>
              </ToolbarButton>}
              <Button
                type="button"
                size="sm"
                className="h-8 rounded-xl px-3 text-xs font-semibold"
                disabled={!currentAnnotationCount}
                onClick={sendCurrentPageAnnotations}
              >
                发送
                {currentAnnotationCount > 0 && <span className="inline-flex size-5 items-center justify-center rounded-full bg-black/15 text-[11px] tabular-nums">{currentAnnotationCount}</span>}
              </Button>
              {surface !== 'right-panel' && <ToolbarButton
                title="按住查看原始页面"
                active={showingOriginal}
                disabled={!hasQueuedTweaks}
                onPointerDown={() => void setOriginalPreview(true)}
                onPointerUp={() => void setOriginalPreview(false)}
                onPointerCancel={() => showingOriginal && void setOriginalPreview(false)}
                onPointerLeave={() => showingOriginal && void setOriginalPreview(false)}
                onBlur={() => showingOriginal && void setOriginalPreview(false)}
                onKeyDown={(event) => {
                  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                    event.preventDefault()
                    void setOriginalPreview(true)
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault()
                    void setOriginalPreview(false)
                  }
                }}
              >
                <span className={cn('inline-flex items-center justify-center transition-transform', showingOriginal && 'scale-[0.8]')}><Eye size={14} /></span>
              </ToolbarButton>}
              {surface !== 'right-panel' && <Button size="sm" className="relative h-7 border-transparent bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90" disabled={!reviewItems.length || staleReviewCount > 0} onClick={() => void promoteReviewQueue()}>
                附加到聊天
                {reviewItems.length > 0 && <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-black/25 px-1 text-[10px] leading-4 font-semibold">{reviewItems.length}</span>}
              </Button>}
            </div>
          </div>
        ) : (
          <>
        <div className="flex shrink-0 items-center gap-px">
          <ToolbarButton title="后退" disabled={!descriptor.canGoBack} onClick={() => run('back')}><ArrowLeft size={15} /></ToolbarButton>
          <ToolbarButton title="前进" disabled={!descriptor.canGoForward} onClick={() => run('forward')}><ArrowRight size={15} /></ToolbarButton>
        </div>
        <ToolbarButton
          title={descriptor.isLoading ? '停止加载' : '重新加载页面'}
          disabled={pageActionsDisabled}
          onClick={() => run(descriptor.isLoading ? 'stop' : 'reload')}
        >
          {descriptor.isLoading ? <X size={15} /> : <RotateCcw size={15} />}
        </ToolbarButton>
        <form
          className={cn(
            'group/address relative flex h-8 min-w-0 max-w-[770px] flex-1 items-center rounded-xl border bg-background/70 shadow-sm transition-[border-color,background-color,box-shadow]',
            surface === 'right-panel' && 'max-w-none rounded-lg border-transparent bg-transparent text-foreground shadow-none',
            addressFocused
              ? surface === 'right-panel' ? 'bg-foreground/10' : 'border-border bg-background ring-1 ring-ring/25'
              : surface === 'right-panel' ? 'hover:bg-foreground/10' : 'border-border/70 hover:border-border hover:bg-muted/20 focus-within:border-border focus-within:bg-background focus-within:ring-1 focus-within:ring-ring/25',
          )}
          onSubmit={(event) => { event.preventDefault(); navigate() }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button
              variant="ghost"
              size="icon"
              type="button"
              className={cn(
                'absolute left-0 z-10 h-7 w-7 rounded-l-xl rounded-r-none text-muted-foreground transition-all hover:bg-foreground/5 hover:text-foreground',
                !descriptor.url && 'invisible',
                descriptor.url && !addressFocused && 'opacity-0 group-hover/address:opacity-100 group-focus-within/address:opacity-100',
                descriptor.securityState === 'insecure' && 'w-[104px] justify-start gap-1.5 px-2 text-xs opacity-100',
              )}
              title={securityLabel}
              aria-label={securityLabel}
            />}>
              {descriptor.securityState === 'insecure'
                ? <><ShieldAlert size={14} className="shrink-0 text-amber-500" /><span className="truncate">不安全</span></>
                : <SlidersHorizontal size={14} />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <div className="px-3 py-2">
                <div className="text-xs font-medium text-foreground">{securityLabel}</div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{safeOrigin(descriptor.url) || '尚未打开网页'}</div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openBrowserSettings}>站点设置<span className="ml-auto text-[10px] text-muted-foreground">权限</span></DropdownMenuItem>
              <DropdownMenuItem disabled={!descriptor.shareable} onSelect={() => void addCurrentTabToChat()}>添加标签页到聊天</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Input
            ref={addressInputRef}
            value={surface === 'right-panel' && !addressFocused ? browserToolbarTitle(address) : address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => window.setTimeout(() => setAddressFocused(false), 120)}
            placeholder="输入 URL"
            className={cn(
              'h-full min-w-0 flex-1 rounded-xl border-0 bg-transparent px-3 py-0 text-sm leading-[18px] shadow-none outline-none transition-none',
              'hover:bg-transparent focus-visible:border-0 focus-visible:bg-transparent focus-visible:ring-0',
              surface === 'right-panel' && 'text-center text-foreground placeholder:text-muted-foreground',
              surface !== 'right-panel' && descriptor.url && 'pl-8',
              surface !== 'right-panel' && descriptor.securityState === 'insecure' && 'pl-[108px]',
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
          {surface !== 'right-panel' && <Button
            variant="ghost"
            size="icon"
            type="button"
            title="在默认浏览器中打开"
            aria-label="在默认浏览器中打开"
            disabled={!descriptor.url}
            onClick={() => descriptor.url && void browserRuntime({ method: 'openExternal', params: { url: descriptor.url } })}
            className="absolute right-0 z-10 size-7 rounded-l-none rounded-r-xl text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-45"
          >
            <ExternalLink size={13} />
          </Button>}
          {showSuggestions && (
            <div className="absolute top-full right-0 left-0 z-[9998] max-h-80 overflow-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl">
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
        <div className="relative flex shrink-0 items-center justify-end gap-1">
        <ToolbarButton
          title={annotationMode ? '退出注释' : '注释  Ctrl+.'}
          active={annotationMode}
          expanded={surface === 'right-panel' && annotationMode}
          disabled={pageActionsDisabled || selecting}
          className={cn(surface === 'right-panel' && annotationMode && 'rounded-xl bg-primary/15 px-3 text-primary hover:bg-primary/25 hover:text-primary')}
          onClick={() => annotationMode ? exitAnnotationMode() : startAnnotationSelection()}
        >
          <MessageCirclePlus size={15} />
          {surface === 'right-panel' && annotationMode && <span className="text-xs font-medium">正在注释</span>}
        </ToolbarButton>
        {surface === 'right-panel' && ownerThreadId && annotationComments.length > 0 && (
          <ToolbarButton
            title={commentsPanelOpen ? '隐藏评论列表' : '查看评论列表'}
            active={commentsPanelOpen}
            onClick={() => setCommentsPanelOpen((open) => !open)}
            className="relative"
          >
            <MessageCircle size={15} />
            {unreadAnnotationCount > 0 && (
              <span
                data-annotation-unread-badge="true"
                className="absolute -top-0.5 -right-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-3.5 font-semibold text-primary-foreground"
              >
                {unreadAnnotationCount > 9 ? '9+' : unreadAnnotationCount}
              </span>
            )}
          </ToolbarButton>
        )}
        <DropdownMenu onOpenChange={(open) => { if (open) setDownloadNoticeCount(0) }}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="relative size-7 shrink-0" title="更多" aria-label="更多" />}>
            <MoreHorizontal size={16} className="rotate-90" />
            {activeDownloads.length > 0 && <span className="absolute right-0.5 bottom-0.5 size-1.5 animate-pulse rounded-full bg-primary" />}
            {downloadNoticeCount > 0 && <span className="absolute -top-0.5 -right-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[8px] leading-3.5 font-semibold text-primary-foreground">{downloadNoticeCount}</span>}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-[240px] p-1.5">
            <DropdownMenuItem disabled={!descriptor.url} onSelect={() => setAuxiliaryPanel('find')}>在页面中查找</DropdownMenuItem>
            <DropdownMenuItem disabled={!descriptor.url} onSelect={() => void browserRuntime({ method: 'print', params: { tabId } })}>打印</DropdownMenuItem>
            <DropdownMenuItem disabled={!descriptor.url || selecting} onSelect={() => startAnnotationSelection()}>
              <span className="min-w-0 flex-1">页面批注</span>
              {reviewItems.length > 0 && <span className="text-[10px] text-muted-foreground">{reviewItems.length}</span>}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!descriptor.url || selecting} onSelect={() => startDesignSelection()}>调整设计</DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="flex h-9 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">缩放</span>
              <div className="flex overflow-hidden rounded-md border border-border bg-foreground/5 text-xs text-foreground">
                <Button variant="ghost" size="icon" className="size-6 rounded-none" aria-label="缩小" disabled={pageActionsDisabled} onClick={() => setZoomFactor((descriptor.zoomFactor ?? 1) - .1)}><Minus size={12} /></Button>
                <div className="w-11 border-x border-border py-0.5 text-center text-[11px] tabular-nums">{currentZoomPercent}%</div>
                <Button variant="ghost" size="icon" className="size-6 rounded-none" aria-label="放大" disabled={pageActionsDisabled} onClick={() => setZoomFactor((descriptor.zoomFactor ?? 1) + .1)}><Plus size={12} /></Button>
              </div>
              <Button variant="ghost" size="icon" className="size-6" aria-label="重置缩放" disabled={pageActionsDisabled || currentZoomPercent === 100} onClick={() => setZoomFactor(1)}><RotateCcw size={12} /></Button>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={pageActionsDisabled} onSelect={toggleDeviceMode}>
              <span className="min-w-0 flex-1">{viewportEnabled ? '隐藏设备工具栏' : '显示设备工具栏'}</span>
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
        {!reviewCoachmarkSeen && descriptor.url && !annotationMode && (
          <div className="absolute top-full right-0 z-[9998] mt-2 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl">
            <span aria-hidden="true" className="absolute -top-1.5 right-2.5 size-3 rotate-45 border-t border-l border-border bg-popover" />
            <div className="text-sm font-medium">页面批注已移入更多菜单</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">可连续选择元素、文本或页面区域，并将评论加入聊天。</p>
            <div className="mt-2 flex justify-end"><Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setReviewCoachmarkSeen(true)}>知道了</Button></div>
          </div>
        )}
        </div>
        {descriptor.isLoading && <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15"><div className="h-full w-full animate-pulse bg-primary" /></div>}
          </>
        )}
      </div>

      {surface === 'right-panel' && ownerThreadId && commentsPanelOpen && annotationComments.length > 0 && (
        <div
          data-annotation-panel="true"
          className="file-tree-scrollbar flex max-h-[280px] shrink-0 flex-col gap-1.5 overflow-y-auto border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] p-2"
        >
          <div className="flex h-6 shrink-0 items-center justify-between px-1 text-xs text-[var(--lume-text-muted)]">
            <span>评论 · {annotationComments.length}</span>
            <button
              type="button"
              aria-label="隐藏评论列表"
              onClick={() => setCommentsPanelOpen(false)}
              className="text-[var(--lume-text-muted)] hover:text-[var(--lume-text-primary)]"
            >
              <X size={12} />
            </button>
          </div>
          <CommentList
            comments={annotationComments}
            onResolve={handleResolveThread}
            onMarkRead={handleMarkThreadRead}
          />
        </div>
      )}

      {auxiliaryPanel === 'find' && (
        <form className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 ps-4 pe-2" onSubmit={(event) => { event.preventDefault(); runFind(true) }}>
          <Search size={16} className="shrink-0 text-foreground" />
          <Input
            autoFocus
            value={findText}
            onChange={(event) => {
              setFindText(event.target.value)
              void browserRuntime({ method: 'find', params: { tabId, text: event.target.value, findNext: false } })
            }}
            aria-label="在页面中查找"
            placeholder="在页面中查找…"
            className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 text-base leading-6 shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
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
          <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">{findResult.matches ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}</span>
          <ToolbarButton title="上一个" disabled={!findResult.matches} onClick={() => runFind(false)}><ChevronUp size={14} /></ToolbarButton>
          <ToolbarButton title="下一个" disabled={!findResult.matches} onClick={() => runFind(true)}><ChevronDown size={14} /></ToolbarButton>
          <ToolbarButton title="关闭" onClick={() => {
            setAuxiliaryPanel(null)
            setFindText('')
            void browserRuntime({ method: 'find:stop', params: { tabId } })
          }}><X size={14} /></ToolbarButton>
        </form>
      )}

      {viewportEnabled && (
        <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-[var(--lume-bg-rail)] px-2.5 text-sm text-foreground">
          <label className={cn('max-w-28 min-w-0 shrink truncate font-medium', deviceCanvasSize.width < 460 && 'sr-only')} htmlFor={`browser-device-preset-${tabId}`}>尺寸：</label>
          <Select value={devicePreset} onValueChange={(value) => value && applyDevicePreset(value as DevicePresetId)}>
            <SelectTrigger
              id={`browser-device-preset-${tabId}`}
              size="sm"
              className={cn(
                'h-7 min-w-[100px] max-w-44 border-transparent bg-transparent px-1 font-medium shadow-none hover:bg-accent focus-visible:border-transparent focus-visible:ring-0',
                deviceCanvasSize.width < 600 && 'w-[100px] max-w-[100px]',
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-[180px]">
              {DEVICE_PRESETS.map((preset) => <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <NumberField label="视口宽度" value={viewportWidth} min={240} max={4096} onCommit={(value) => setViewport({ width: value })} />
          <span className="text-sm text-muted-foreground">×</span>
          <NumberField label="视口高度" value={viewportHeight} min={160} max={4096} onCommit={(value) => setViewport({ height: value })} />
          <ToolbarButton title="旋转视口" onClick={rotateViewport}>
            <RotateCw className="size-4 transition-transform duration-300 ease-out motion-reduce:transition-none" style={{ transform: `rotate(${viewportRotationKey * 180}deg)` }} />
          </ToolbarButton>
          {deviceCanvasSize.width >= 600 && (
            <Select value={String(deviceDisplayScale)} onValueChange={(value) => value && setDeviceDisplayScale(value === 'fit' ? 'fit' : Number(value))}>
              <SelectTrigger size="sm" aria-label="设备显示缩放" className="h-7 shrink-0 border-transparent bg-transparent px-1 font-medium text-muted-foreground shadow-none hover:bg-accent focus-visible:border-transparent focus-visible:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="fit">适合</SelectItem>
                {DEVICE_DISPLAY_SCALES.map((scale) => <SelectItem key={scale} value={String(scale)}>{Math.round(scale * 100)}%</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <div className="ml-auto">
            <ToolbarButton title="退出设备工具栏模式" onClick={toggleDeviceMode}><X size={14} /></ToolbarButton>
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
      <Dialog open={Boolean(pageDialog)} onOpenChange={(open) => { if (!open) handlePageDialog(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pageDialogTitle(pageDialog?.type)}</DialogTitle>
            <DialogDescription className="max-h-48 whitespace-pre-wrap break-words overflow-y-auto">
              {pageDialog?.message || safeHost(descriptor.url) || '此网页需要你的确认。'}
            </DialogDescription>
          </DialogHeader>
          {pageDialog?.type === 'prompt' && (
            <Input
              autoFocus
              value={pageDialog.promptText}
              disabled={pageDialogBusy}
              aria-label="网页输入"
              onChange={(event) => setPageDialog((current) => current ? { ...current, promptText: event.target.value.slice(0, 10_000) } : current)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handlePageDialog(true) } }}
            />
          )}
          <DialogFooter>
            {pageDialog?.type !== 'alert' && <Button variant="outline" disabled={pageDialogBusy} onClick={() => handlePageDialog(false)}>{pageDialog?.type === 'beforeunload' ? '留在此页' : '取消'}</Button>}
            <Button disabled={pageDialogBusy} onClick={() => handlePageDialog(true)}>{pageDialog?.type === 'beforeunload' ? '离开' : '确定'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div
        ref={deviceCanvasRef}
        className={cn(
          'relative min-h-0 flex-1',
          viewportEnabled
            ? cn('flex items-start bg-[#303030] px-5 pb-5', deviceDisplayScale === 'fit' ? 'justify-center overflow-hidden' : 'justify-start overflow-auto')
            : 'overflow-hidden bg-white',
        )}
      >
        <div
          className={cn(
            'relative',
            viewportEnabled ? 'mx-auto mb-auto shrink-0' : 'size-full',
          )}
          style={viewportEnabled ? { width: deviceFrame.width, height: deviceFrame.height } : undefined}
        >
          <div
            ref={viewportRef}
            className="relative size-full overflow-hidden bg-white"
          >
            {ready && descriptor.url && !loadError && descriptor.lifecycle !== 'crashed' && (
              <BrowserGuestSurface
                tabId={tabId}
                generation={descriptor.generation}
                guestState={descriptor.guestState}
                className="absolute inset-0"
              />
            )}
            {annotationMode && staleReviewCount > 0 && (
              <div className="absolute top-2 left-1/2 z-[75] flex max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-amber-500/30 bg-popover px-3 py-2 text-xs shadow-lg">
                <ShieldAlert className="size-4 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1 truncate">{staleReviewCount} 项批注已因页面变化失效</span>
                <div className="file-tree-scrollbar flex min-w-0 gap-1 overflow-x-auto">
                  {reviewItems.filter((item) => item.status === 'stale').map((item, index) => (
                    <Button key={item.id} type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => removeReviewItem(item.id)}>
                      移除 {index + 1}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {reviewEditorPosition && pageSelection && auxiliaryPanel === 'tweaks' && (
              <div
                data-browser-design-editor
                className="absolute z-[80] flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
                style={{ left: reviewEditorPosition.left, top: reviewEditorPosition.top, width: reviewEditorPosition.width, maxHeight: reviewEditorPosition.maxHeight }}
              >
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
                  <SlidersHorizontal className="size-3.5 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">调整元素</span>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label="恢复原始样式" onClick={resetTweaks}><RotateCcw size={12} /></Button>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label="关闭调整" onClick={() => closeReviewEditor()}><X size={12} /></Button>
                </div>
                <Textarea
                  value={annotationBody}
                  onChange={(event) => setAnnotationBody(event.target.value)}
                  placeholder="描述这些更改…"
                  className="min-h-14 shrink-0 resize-none rounded-none border-x-0 border-t-0 bg-transparent px-3 py-2 text-sm shadow-none focus-visible:ring-0"
                />
                <div className="file-tree-scrollbar grid min-h-0 flex-1 grid-cols-2 gap-x-2 gap-y-2 overflow-y-auto p-3">
                  {TWEAK_FIELDS.map((field) => (
                    <label key={field.key} className="min-w-0 text-[11px] text-muted-foreground">
                      {field.label}
                      <Input
                        type={field.type ?? 'text'}
                        value={tweakDraft[field.key] ?? ''}
                        placeholder={pageSelection.originalStyles[field.key] ?? ''}
                        className="mt-1 h-7 px-2 text-xs"
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
                <div className="flex h-11 shrink-0 items-center justify-between border-t border-border/60 px-2">
                  <div className="flex items-center gap-1">
                    {editingReviewItemId && <Button type="button" variant="ghost" size="icon-xs" aria-label="删除调整" onClick={() => removeReviewItem(editingReviewItemId)}><Trash2 size={13} /></Button>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button type="button" variant="outline" size="sm" className="h-7" onClick={applyTweaks} disabled={!Object.keys(tweakDraft).length}>预览</Button>
                    <Button type="button" size="sm" className="h-7 bg-primary text-primary-foreground hover:bg-primary/90" onClick={addTweaksToChat} disabled={!Object.keys(tweakDraft).length}>添加</Button>
                  </div>
                </div>
              </div>
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
          {viewportEnabled && devicePreset === 'responsive' && <ViewportResizeHandles onResizeStart={beginViewportResize} />}
        </div>
      </div>
    </div>
  )
}

function getBrowserReviewOverlayPosition(
  rect: AgentBrowserAnchor['rect'],
  scale: number,
  surfaceWidth: number,
  surfaceHeight: number,
  preferredWidth: number,
  preferredHeight: number,
) {
  const margin = 8
  const gap = 8
  const width = Math.max(180, Math.min(preferredWidth, Math.max(180, surfaceWidth - margin * 2)))
  const maxHeight = Math.max(120, surfaceHeight - margin * 2)
  const estimatedHeight = Math.min(preferredHeight, maxHeight)
  const anchorLeft = rect.x * scale
  const anchorTop = rect.y * scale
  const anchorBottom = (rect.y + rect.height) * scale
  const left = Math.max(margin, Math.min(surfaceWidth - width - margin, anchorLeft))
  const preferredTop = anchorBottom + gap
  const top = preferredTop + estimatedHeight <= surfaceHeight - margin
    ? preferredTop
    : Math.max(margin, anchorTop - estimatedHeight - gap)
  return { left, top, width, maxHeight }
}

function ToolbarButton({ children, title, active, expanded, disabled, className, onClick, onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, onBlur, onKeyDown, onKeyUp }: {
  children: ReactNode
  title: string
  active?: boolean
  expanded?: boolean
  disabled?: boolean
  className?: string
  onClick?: () => void
  onPointerDown?: () => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  onPointerLeave?: () => void
  onBlur?: () => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  onKeyUp?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
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
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className={cn('h-7 shrink-0 gap-1 px-1.5', expanded ? 'w-auto max-w-40' : 'w-7 max-w-7', className)}
    >
      {children}
    </Button>
  )
}

function ViewportResizeHandles({ onResizeStart }: {
  onResizeStart: (axis: ViewportResizeAxis, event: ReactPointerEvent<HTMLElement>) => void
}) {
  const handleClass = 'absolute z-20 flex touch-none items-center justify-center rounded-none bg-[#414141] p-0 text-[#afafaf] outline-none hover:bg-[#4f4f4f] focus-visible:ring-1 focus-visible:ring-ring'
  return (
    <>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从左侧调整设备视口" className={cn(handleClass, '-left-5 top-0 bottom-0 w-5 cursor-ew-resize')} onPointerDown={(event) => onResizeStart('west', event)}>
        <span className="flex h-9 w-5 items-center justify-center gap-0.5"><span className="h-8 w-0.5 rounded-full bg-[#afafaf]" /><span className="h-8 w-0.5 rounded-full bg-[#afafaf]" /></span>
      </Button>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从右侧调整设备视口" className={cn(handleClass, '-right-5 top-0 bottom-0 w-5 cursor-ew-resize')} onPointerDown={(event) => onResizeStart('east', event)}>
        <span className="flex h-9 w-5 items-center justify-center gap-0.5"><span className="h-8 w-0.5 rounded-full bg-[#afafaf]" /><span className="h-8 w-0.5 rounded-full bg-[#afafaf]" /></span>
      </Button>
      <Button type="button" variant="ghost" size="icon" tabIndex={-1} aria-label="从底部调整设备视口" className={cn(handleClass, 'top-full -right-5 -left-5 h-5 w-auto cursor-ns-resize')} onPointerDown={(event) => onResizeStart('south', event)}>
        <span className="flex h-5 w-9 flex-col items-center justify-center gap-0.5"><span className="h-0.5 w-8 rounded-full bg-[#afafaf]" /><span className="h-0.5 w-8 rounded-full bg-[#afafaf]" /></span>
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
    const next = Math.round(Math.max(min, Math.min(max, parsed)))
    setDraft(String(next))
    if (next !== value) onCommit(next)
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
        onChange={(event) => {
          setDraft(event.target.value)
          const parsed = event.currentTarget.valueAsNumber
          if (!Number.isNaN(parsed) && parsed >= min && parsed <= max && Math.round(parsed) !== value) onCommit(Math.round(parsed))
        }}
        onFocus={() => setDraft(String(value))}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
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

function pageDialogTitle(type: BrowserPageDialog['type'] | undefined): string {
  if (type === 'prompt') return '此网页要求输入内容'
  if (type === 'beforeunload') return '要离开此网页吗？'
  if (type === 'confirm') return '此网页要求确认'
  return '此网页显示'
}

function safeHost(value: string): string {
  try { return new URL(value).host } catch { return '' }
}

function browserToolbarTitle(value: string): string {
  return safeHost(value) || value || '新标签页'
}

function browserAnnotationThemeColor(): string | undefined {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--lume-accent').trim()
  return color || undefined
}

function getDeviceFrameSize(
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
  displayScale: BrowserViewportState['displayScale'],
) {
  if (!canvasWidth || !canvasHeight) return { width, height, scale: 1 }
  const fitWidth = Math.max(0, canvasWidth - 40)
  const fitHeight = Math.max(0, canvasHeight - 20)
  const scale = displayScale === 'fit' || displayScale === undefined
    ? Math.min(1, fitWidth / width, fitHeight / height)
    : Math.max(0.5, Math.min(2, displayScale))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

function clampViewportWidth(value: number): number {
  return Math.max(240, Math.min(4096, Math.round(value)))
}

function clampViewportHeight(value: number): number {
  return Math.max(160, Math.min(4096, Math.round(value)))
}

function resolveDevicePreset(viewport: BrowserViewportState): DevicePresetId {
  const rawPreset = viewport.preset as string | undefined
  const persistedPreset = rawPreset === 'laptop-large'
    ? 'laptop-l'
    : rawPreset === 'galaxy-s24-ultra'
      ? 'samsung-galaxy-s24-ultra'
      : rawPreset
  if (persistedPreset && DEVICE_PRESETS.some((preset) => preset.id === persistedPreset)) return persistedPreset as DevicePresetId
  const exact = DEVICE_PRESETS.find((preset) => (
    (preset.width === viewport.width && preset.height === viewport.height)
    || (preset.width === viewport.height && preset.height === viewport.width)
  ) && preset.deviceScaleFactor === viewport.deviceScaleFactor)
  return exact?.id ?? 'responsive'
}

const RESPONSIVE_DEVICE_PRESET = { id: 'responsive', label: '响应式', width: 390, height: 844, deviceScaleFactor: 1 } as const

const DEVICE_PRESETS = [
  RESPONSIVE_DEVICE_PRESET,
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

const DEVICE_DISPLAY_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2]

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
  { key: 'rowGap', label: '垂直间距' },
  { key: 'columnGap', label: '水平间距' },
  { key: 'padding', label: 'Padding' },
  { key: 'margin', label: 'Margin' },
]
