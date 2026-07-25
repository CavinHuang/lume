import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Camera, Copy, ExternalLink, Globe, MoreVertical, RotateCcw, Search, Share2, Smartphone, Tablet, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { browserRuntime, onBrowserEvent, writeClipboardText } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import { normalizeUrl } from './browser-url'
import { BrowserImportModal } from './BrowserImportModal'

export function BrowserShell({
  tabId,
  initialUrl = '',
  surface,
  className,
  onUrlChange,
}: {
  tabId: string
  initialUrl?: string
  surface: 'main' | 'right-panel'
  className?: string
  onUrlChange?: (url: string) => void
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [address, setAddress] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [ready, setReady] = useState(false)
  const [shareable, setShareable] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [zoom, setZoom] = useState(1)
  const currentUrlRef = useRef(initialUrl)
  const onUrlChangeRef = useRef(onUrlChange)
  const menuContentRef = useRef<HTMLDivElement | null>(null)
  const menuOpenRef = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    onUrlChangeRef.current = onUrlChange
  }, [onUrlChange])

  useEffect(() => {
    if (initialUrl && initialUrl !== currentUrlRef.current) {
      currentUrlRef.current = initialUrl
      setAddress(initialUrl)
      setCurrentUrl(initialUrl)
      if (ready) void browserRuntime({ method: 'navigate', params: { tabId, url: initialUrl } }).catch(() => toast.error('页面打开失败'))
    }
  }, [initialUrl, ready, tabId])

  useEffect(() => {
    let disposed = false
    void browserRuntime<{ tabId: string }>({ method: 'ensure', params: { tabId, url: initialUrl || undefined } })
      .then((descriptor) => {
        if (disposed) return
        setShareable((descriptor as { shareable?: boolean }).shareable === true)
        setReady(true)
        const node = viewportRef.current
        if (node) { const rect = node.getBoundingClientRect(); void browserRuntime({ method: 'bounds', params: { tabId, surface, visible: true, x: rect.left, y: rect.top, width: rect.width, height: rect.height } }) }
      })
      .catch(() => setReady(false))
    let stopListening: (() => void) | undefined
    void onBrowserEvent((event) => {
      if (event.params.tabId !== tabId) return
      if (event.method === 'browser:tab-changed') {
        const url = typeof event.params.url === 'string' ? event.params.url : ''
        setCurrentUrl(url)
        setAddress(url)
        currentUrlRef.current = url
        if (typeof event.params.shareable === 'boolean') setShareable(event.params.shareable)
        onUrlChangeRef.current?.(url)
      }
      if (event.method === 'browser:popup-request' && typeof event.params.activationToken === 'string' && typeof event.params.url === 'string') {
        toast('网页请求打开弹窗', { description: event.params.url, action: { label: '打开', onClick: () => void browserRuntime({ method: 'openPopup', params: { activationToken: event.params.activationToken } }).catch(() => toast.error('弹窗已失效')) } })
      }
      if (event.method === 'browser:dialog') {
        toast('网页对话框正在等待处理', { description: String(event.params.type ?? 'dialog'), action: { label: '确定', onClick: () => void browserRuntime({ method: 'dialog:handle', params: { tabId, accept: true } }) }, cancel: { label: '取消', onClick: () => void browserRuntime({ method: 'dialog:handle', params: { tabId, accept: false } }) } })
      }
    }).then((dispose) => {
      if (disposed) dispose()
      else stopListening = dispose
    })
    return () => {
      disposed = true
      stopListening?.()
      void browserRuntime({ method: 'visible', params: { tabId, visible: false } }).catch(() => undefined)
    }
  }, [tabId])

  const syncBounds = useCallback(() => {
    const node = viewportRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    void browserRuntime({ method: 'bounds', params: { tabId, surface, visible: true, x: rect.left, y: rect.top, width: rect.width, height: rect.height } }).catch(() => undefined)
  }, [surface, tabId])

  // 更多操作菜单向下展开会进入原生 WebContentsView 覆盖区域，导致下拉菜单被网页遮挡。
  // 展开时按菜单实际高度临时收缩视图 bounds，让出 DOM 空间使菜单可见；关闭后还原。
  const applyMenuOverlap = useCallback(() => {
    const menu = menuContentRef.current
    const viewport = viewportRef.current
    if (!menu || !viewport) { syncBounds(); return }
    const menuRect = menu.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    const overlap = menuRect.bottom - viewportRect.top
    if (overlap <= 0) { syncBounds(); return }
    void browserRuntime({ method: 'bounds', params: { tabId, surface, visible: true, x: viewportRect.left, y: viewportRect.top + overlap, width: viewportRect.width, height: Math.max(1, viewportRect.height - overlap) } }).catch(() => undefined)
  }, [surface, tabId, syncBounds])

  const handleMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open)
    menuOpenRef.current = open
    if (open) {
      // 等菜单挂载并完成入场动画后再测量实际高度
      requestAnimationFrame(() => requestAnimationFrame(() => applyMenuOverlap()))
    } else {
      syncBounds()
    }
  }, [applyMenuOverlap, syncBounds])

  useEffect(() => {
    if (!ready) return
    const onResize = () => { if (menuOpenRef.current) applyMenuOverlap(); else syncBounds() }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize)
    if (viewportRef.current) observer?.observe(viewportRef.current)
    window.addEventListener('resize', onResize)
    syncBounds()
    return () => { observer?.disconnect(); window.removeEventListener('resize', onResize) }
  }, [ready, surface, tabId, syncBounds, applyMenuOverlap])

  const navigate = () => {
    const next = normalizeUrl(address)
    if (!next) return
    setAddress(next)
    setCurrentUrl(next)
    onUrlChangeRef.current?.(next)
    void browserRuntime({ method: 'navigate', params: { tabId, url: next } }).catch(() => toast.error('页面打开失败'))
  }

  const run = (method: 'back' | 'forward' | 'reload') => {
    void browserRuntime({ method, params: { tabId } }).catch(() => toast.error('浏览器操作失败'))
  }

  const setZoomFactor = (factor: number) => {
    const next = Math.max(0.25, Math.min(5, factor))
    void browserRuntime<{ factor: number }>({ method: 'zoom:set', params: { tabId, factor: next } }).then((result) => setZoom(result.factor)).catch(() => toast.error('缩放失败'))
  }

  const emulate = (preset: string) => void browserRuntime({ method: 'emulate', params: { tabId, preset } }).then(() => toast.success('设备模式已更新并刷新页面')).catch(() => toast.error('设备模式切换失败'))

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <IconButton title="后退" onClick={() => run('back')} />
        <IconButton title="前进" onClick={() => run('forward')} />
        <IconButton title="刷新" onClick={() => run('reload')} />
        <Globe size={17} className="ml-1 shrink-0 text-foreground/50" />
        <form className="flex min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); navigate() }}>
          <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="输入 URL" className="h-9 min-w-0 flex-1 rounded-[10px]" />
        </form>
        <IconButton title="复制链接" onClick={() => currentUrl && void writeClipboardText(currentUrl).catch(() => toast.error('复制失败'))}><Copy size={15} /></IconButton>
        <Button variant={shareable ? 'secondary' : 'ghost'} size="icon" type="button" title={shareable ? '取消共享给 Agent' : '共享当前标签给 Agent'} onClick={() => void browserRuntime({ method: shareable ? 'unshare' : 'share', params: { tabId } }).then((descriptor) => setShareable((descriptor as { shareable?: boolean }).shareable === true)).catch(() => toast.error('当前标签不可共享'))}><Share2 size={15} /></Button>
        <IconButton title="在系统浏览器打开" onClick={() => currentUrl && void browserRuntime({ method: 'openExternal', params: { url: currentUrl } }).catch(() => toast.error('无法打开系统浏览器'))}><ExternalLink size={15} /></IconButton>
        <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}><DropdownMenuTrigger render={<Button variant="ghost" size="icon" type="button" aria-label="更多浏览器操作" />}><MoreVertical size={16} /></DropdownMenuTrigger><DropdownMenuContent ref={menuContentRef} className="min-w-52">
          <DropdownMenuItem onSelect={() => setFindOpen(true)}><Search size={14} />在页面中查找</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void browserRuntime<{ saved: boolean }>({ method: 'screenshot:save', params: { tabId } }).then((result) => result.saved && toast.success('截图已保存')).catch(() => toast.error('截图保存失败'))}><Camera size={14} />截取整页截图</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setZoomFactor(zoom - 0.1)}><ZoomOut size={14} />缩小（{Math.round(zoom * 100)}%）</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setZoomFactor(1)}>重置缩放</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setZoomFactor(zoom + 0.1)}><ZoomIn size={14} />放大</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => emulate('desktop')}><Globe size={14} />桌面设备</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => emulate('phone')}><Smartphone size={14} />手机设备</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => emulate('tablet')}><Tablet size={14} />平板设备</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>导入 Cookie 和密码…</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
      {findOpen && <form className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3" onSubmit={(event) => { event.preventDefault(); void browserRuntime({ method: 'find', params: { tabId, text: findText, findNext: true } }) }}><Search size={14} className="text-foreground/45" /><Input autoFocus value={findText} onChange={(event) => { setFindText(event.target.value); void browserRuntime({ method: 'find', params: { tabId, text: event.target.value } }) }} placeholder="在页面中查找" className="h-8" /><Button type="submit" variant="outline" size="sm">下一个</Button><Button type="button" variant="ghost" size="sm" onClick={() => { setFindOpen(false); setFindText(''); void browserRuntime({ method: 'find:stop', params: { tabId } }) }}>关闭</Button></form>}
      <BrowserImportModal open={importOpen} onOpenChange={setImportOpen} />
      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-white">
        {!ready && <div className="absolute inset-0 z-0 flex items-center justify-center text-sm text-foreground/45">内置浏览器准备中…</div>}
      </div>
    </div>
  )
}

function IconButton({ children, title, onClick }: { children?: ReactNode; title: string; onClick: () => void }) {
  return <Button variant="ghost" size="icon" type="button" title={title} onClick={onClick}><span aria-hidden="true">{children ?? (title === '后退' ? <ArrowLeft size={15} /> : title === '前进' ? <ArrowRight size={15} /> : <RotateCcw size={15} />)}</span></Button>
}
