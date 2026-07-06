import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Minus,
  MoreVertical,
  Plus,
  RotateCcw,
} from 'lucide-react'
import { toast } from 'sonner'
import { clearCache, openExternal } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import type { BrowserTabState } from './right-panel-state'
import { getDefaultLocalBrowserServices, normalizeRightPanelBrowserUrl } from './right-panel-browser-utils'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface BrowserRightPanelTabProps {
  state: BrowserTabState
  onChange: (next: BrowserTabState) => void
}

export function BrowserRightPanelTab({ state, onChange }: BrowserRightPanelTabProps) {
  const [frameKey, setFrameKey] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const activeUrl = state.url

  const update = (patch: Partial<BrowserTabState>) => {
    onChange({ ...state, ...patch })
  }

  const navigate = (raw: string) => {
    const url = normalizeRightPanelBrowserUrl(raw)
    update({ url, addressInput: url })
    setFrameKey((value) => value + 1)
  }

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpen])

  const setZoom = (nextZoom: number) => {
    update({ zoom: Math.min(3, Math.max(0.25, Number(nextZoom.toFixed(2)))) })
  }

  const forceReload = () => {
    setFrameKey((value) => value + 1)
    setMenuOpen(false)
  }

  const clearBrowserCache = async () => {
    try {
      await clearCache({ frontendTemp: true, previewRender: true })
      toast.success('缓存已清理')
    } catch (error) {
      console.error('[BrowserRightPanelTab] 清理缓存失败:', error)
      toast.error('清理缓存失败')
    } finally {
      setMenuOpen(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <IconButton disabled title="后退">
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton disabled title="前进">
          <ArrowRight size={16} />
        </IconButton>
        <IconButton disabled={!activeUrl} title="刷新" onClick={forceReload}>
          <RotateCcw size={16} />
        </IconButton>

        <form
          className="flex min-w-0 flex-1 items-center"
          onSubmit={(event) => {
            event.preventDefault()
            navigate(state.addressInput)
          }}
        >
          <Input
            value={state.addressInput}
            onChange={(event) => update({ addressInput: event.target.value })}
            placeholder="输入 URL"
            className="h-9 min-w-0 flex-1 rounded-[10px] border border-border/70 bg-background px-3 text-[14px] text-foreground outline-none placeholder:text-foreground/38"
          />
        </form>

        <IconButton disabled={!activeUrl} title="在系统浏览器打开" onClick={() => activeUrl && openExternal(activeUrl)}>
          <ExternalLink size={16} />
        </IconButton>

        <div className="relative" ref={menuRef}>
          <IconButton title="更多" onClick={() => setMenuOpen((open) => !open)}>
            <MoreVertical size={16} />
          </IconButton>
          {menuOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-64 rounded-[10px] border border-border/80 bg-background/98 p-2 shadow-[0_18px_55px_-32px_hsl(var(--lume-shadow-panel)/0.62)] backdrop-blur">
              <MenuButton disabled={!activeUrl} onClick={forceReload}>强制重新加载</MenuButton>
              <MenuButton onClick={() => update({ deviceToolbarVisible: !state.deviceToolbarVisible })}>
                {state.deviceToolbarVisible ? '隐藏设备工具栏' : '显示设备工具栏'}
              </MenuButton>
              <div className="my-1 border-t border-border/70" />
              <div className="flex h-9 items-center justify-between gap-2 px-2.5 text-[13px] font-medium text-foreground">
                <span>缩放</span>
                <div className="flex items-center overflow-hidden rounded-[8px] border border-border/70">
                  <Button
                variant="ghost"
                    type="button"
                    onClick={() => setZoom(state.zoom - 0.1)}
                    className="flex size-7 items-center justify-center text-foreground/58 hover:bg-foreground/[0.06] hover:text-foreground"
                    title="缩小"
                  >
                    <Minus size={13} />
                  </Button>
                  <span className="w-14 text-center text-[13px]">{Math.round(state.zoom * 100)}%</span>
                  <Button
                variant="ghost"
                    type="button"
                    onClick={() => setZoom(state.zoom + 0.1)}
                    className="flex size-7 items-center justify-center text-foreground/58 hover:bg-foreground/[0.06] hover:text-foreground"
                    title="放大"
                  >
                    <Plus size={13} />
                  </Button>
                </div>
              </div>
              <div className="my-1 border-t border-border/70" />
              <MenuButton disabled title="暂不支持清除 Cookie" onClick={() => undefined}>清除 Cookie</MenuButton>
              <MenuButton onClick={clearBrowserCache}>清除缓存</MenuButton>
            </div>
          )}
        </div>
      </div>

      {activeUrl ? (
        <div className="flex min-h-0 flex-1 flex-col bg-white">
          {state.deviceToolbarVisible && (
            <div className="flex h-8 shrink-0 items-center justify-center border-b border-black/10 bg-[#f4f4f5] text-[12px] text-[#65656b]">
              {Math.round(state.zoom * 100)}%
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden bg-white">
            <iframe
              key={`${activeUrl}:${frameKey}`}
              src={activeUrl}
              title="Right Panel Browser"
              className="origin-top-left border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              style={{
                height: `${100 / state.zoom}%`,
                transform: `scale(${state.zoom})`,
                width: `${100 / state.zoom}%`,
              }}
            />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-end justify-center px-7 pb-20">
          <div className="w-full max-w-[420px]">
            <div className="mb-3 text-[13px] font-medium text-foreground/45">本地</div>
            <div className="flex flex-col gap-2">
              {getDefaultLocalBrowserServices().map((service) => (
                <Button
                variant="ghost"
                  key={service.url}
                  type="button"
                  onClick={() => navigate(service.url)}
                  className="flex h-20 items-center gap-4 rounded-[10px] border border-border/70 bg-background px-4 text-left transition-colors hover:bg-foreground/[0.04]"
                >
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-[8px] bg-foreground/[0.04] text-foreground/60">
                    <Globe size={22} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium text-foreground">{service.title}</div>
                    <div className="truncate text-[13px] text-foreground/50">{service.url.replace(/^https?:\/\//, '')}</div>
                  </div>
                  <span className="size-2.5 shrink-0 rounded-full bg-[var(--lume-success)]" />
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function IconButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
  title: string
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-[8px] text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-35 hover:bg-transparent hover:text-foreground/55',
      )}
      title={title}
    >
      {children}
    </Button>
  )
}

function MenuButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode
  disabled?: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="flex h-9 w-full items-center justify-start rounded-[7px] px-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </Button>
  )
}
