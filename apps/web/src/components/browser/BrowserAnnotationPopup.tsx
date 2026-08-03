import { useEffect, useRef, useState } from 'react'
import { Check, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { readStoredThemeMode, readStoredThemePalette, setThemeMode, setThemePalette } from '@/lib/theme-mode'

type PopupState = {
  sessionId: string
  annotationId?: string
  body: string
  target: string
  mode: 'add' | 'edit'
  canDelete: boolean
}

type PopupBridge = {
  onState: (listener: (state: PopupState) => void) => () => void
  command: (command: 'add' | 'send' | 'cancel' | 'delete' | 'resize', body?: string) => Promise<unknown>
}

export function BrowserAnnotationPopup() {
  const bridge = (window as Window & { lumeBrowserAnnotation?: PopupBridge }).lumeBrowserAnnotation
  const [state, setState] = useState<PopupState>()
  const [body, setBody] = useState('')
  const [actionsExpanded, setActionsExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    document.getElementById('boot-root')?.remove()
    const applyTheme = () => {
      setThemeMode(readStoredThemeMode())
      setThemePalette(readStoredThemePalette())
    }
    applyTheme()
    const rootBackground = document.documentElement.style.background
    const bodyBackground = document.body.style.background
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onStorage = (event: StorageEvent) => { if (event.key === 'lume:theme-mode' || event.key === 'lume:theme-palette') applyTheme() }
    media.addEventListener('change', applyTheme)
    window.addEventListener('storage', onStorage)
    return () => {
      media.removeEventListener('change', applyTheme)
      window.removeEventListener('storage', onStorage)
      document.documentElement.style.background = rootBackground
      document.body.style.background = bodyBackground
    }
  }, [])

  useEffect(() => {
    if (!bridge) return
    return bridge.onState((next) => {
      setState(next)
      setBody(next.body)
      setActionsExpanded(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    })
  }, [bridge])

  if (!bridge || !state) return null
  const hasBody = body.trim().length > 0
  const command = (name: 'add' | 'send' | 'cancel' | 'delete') => { void bridge.command(name, body.trim()) }
  const resizeActions = (expanded: boolean) => {
    if (actionsExpanded === expanded) return
    setActionsExpanded(expanded)
    void bridge.command('resize', JSON.stringify({ height: expanded ? (state.canDelete ? 190 : 156) : 76 }))
  }

  return (
    <main className="flex min-h-screen items-end bg-transparent p-2 text-[var(--lume-text-primary)]">
      <section className="flex h-14 min-w-0 flex-1 items-center gap-1 rounded-[18px] border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_96%,transparent)] px-2 shadow-[0_12px_32px_-18px_hsl(var(--lume-shadow-panel)/0.5)] backdrop-blur-xl">
        <span
          aria-label={state.target || '所选网页节点'}
          className="flex size-9 shrink-0 items-center justify-center text-[var(--lume-text-muted)]"
          title={state.target || '所选网页节点'}
        >
          <SlidersHorizontal size={16} />
        </span>
        <Input
          ref={inputRef}
          value={body}
          onChange={(event) => setBody(event.target.value.slice(0, 20_000))}
          placeholder="添加评论…"
          className="h-10 min-w-0 flex-1 rounded-none border-0 bg-transparent px-1 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); command('cancel') }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (hasBody) command('send') }
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); if (hasBody) command('add') }
          }}
        />
        {hasBody && (
          <div
            className="group/annotation-actions relative flex shrink-0 items-center"
            onMouseEnter={() => resizeActions(true)}
            onMouseLeave={() => resizeActions(false)}
            onFocusCapture={() => resizeActions(true)}
            onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) resizeActions(false) }}
          >
            <div className="invisible absolute right-0 bottom-full w-36 pb-2 opacity-0 transition-[opacity,visibility] group-hover/annotation-actions:visible group-hover/annotation-actions:opacity-100 group-focus-within/annotation-actions:visible group-focus-within/annotation-actions:opacity-100">
              <div className="overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-1 shadow-[0_16px_36px_-20px_hsl(var(--lume-shadow-panel)/0.55)]">
                <Button type="button" variant="ghost" size="sm" className="h-8 w-full justify-between px-2.5 font-normal" onClick={() => command('add')}>
                  <span>添加</span><kbd className="rounded-md bg-[var(--lume-bg-rail)] px-1.5 py-0.5 text-[11px] text-[var(--lume-text-muted)]">Enter</kbd>
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-8 w-full justify-between px-2.5 font-normal" onClick={() => command('send')}>
                  <span>发送</span><kbd className="rounded-md bg-[var(--lume-bg-rail)] px-1.5 py-0.5 text-[11px] text-[var(--lume-text-muted)]">Ctrl+Enter</kbd>
                </Button>
                {state.canDelete && (
                  <Button type="button" variant="ghost" size="sm" className="h-8 w-full justify-start gap-2 px-2.5 font-normal text-destructive hover:text-destructive" onClick={() => command('delete')}>
                    <Trash2 size={13} />删除
                  </Button>
                )}
              </div>
            </div>
            <Button type="button" variant="default" size="icon" aria-label="添加批注" className="size-9 rounded-full" onClick={() => command('add')}>
              <Check size={17} strokeWidth={2.2} />
            </Button>
          </div>
        )}
      </section>
    </main>
  )
}
