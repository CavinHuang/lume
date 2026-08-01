import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { BrowserGuestMountDescriptor, BrowserTabDescriptor } from '@lume/shared'
import { browserRuntime, onBrowserEvent } from '@/lib/desktop-api'

type BrowserWebviewElement = HTMLElement & {
  src: string
  partition: string
}

type GuestEntry = {
  wrapper: HTMLDivElement
  webview: BrowserWebviewElement
  mountToken: string
  generation: number
}

type BrowserWebviewPoolApi = {
  present: (tabId: string, generation: number, guestState: BrowserTabDescriptor['guestState'], target: HTMLElement) => () => void
  ensure: (tabId: string, generation: number, target?: HTMLElement) => Promise<void>
}

const BrowserWebviewPoolContext = createContext<BrowserWebviewPoolApi | null>(null)

export function BrowserWebviewPoolProvider({ children }: { children: ReactNode }) {
  const hiddenHostRef = useRef<HTMLDivElement | null>(null)
  const entriesRef = useRef(new Map<string, GuestEntry>())
  const mountsRef = useRef(new Map<string, Promise<void>>())
  const targetsRef = useRef(new Map<string, HTMLElement>())

  const api = useMemo<BrowserWebviewPoolApi>(() => {
    const discard = (tabId: string) => {
      const entry = entriesRef.current.get(tabId)
      if (!entry) return
      entry.wrapper.remove()
      entriesRef.current.delete(tabId)
    }

    const ensure = async (tabId: string, generation: number, target?: HTMLElement) => {
      if (target) targetsRef.current.set(tabId, target)
      const existing = entriesRef.current.get(tabId)
      if (existing) {
        const host = targetsRef.current.get(tabId) ?? hiddenHostRef.current
        if (host && existing.wrapper.parentElement !== host) host.append(existing.wrapper)
        return
      }
      const pending = mountsRef.current.get(tabId)
      if (pending) return pending
      const mount = browserRuntime<BrowserGuestMountDescriptor>({ method: 'mount:prepare', params: { tabId } })
        .then((descriptor) => {
          if (descriptor.tabId !== tabId || descriptor.generation !== generation) throw new Error('stale browser guest mount')
          const wrapper = document.createElement('div')
          wrapper.dataset.browserGuestTabId = tabId
          wrapper.style.position = 'absolute'
          wrapper.style.inset = '0'
          wrapper.style.overflow = 'hidden'
          wrapper.style.background = 'var(--background)'
          const webview = document.createElement('webview') as BrowserWebviewElement
          webview.setAttribute('partition', descriptor.partition)
          webview.setAttribute('src', descriptor.bootstrapUrl)
          webview.style.display = 'flex'
          webview.style.width = '100%'
          webview.style.height = '100%'
          webview.style.border = '0'
          wrapper.append(webview)
          const host = targetsRef.current.get(tabId) ?? hiddenHostRef.current
          if (!host) throw new Error('browser guest host unavailable')
          host.append(wrapper)
          entriesRef.current.set(tabId, { wrapper, webview, mountToken: descriptor.mountToken, generation })
        })
        .finally(() => mountsRef.current.delete(tabId))
      mountsRef.current.set(tabId, mount)
      return mount
    }

    return {
      ensure,
      present(tabId, generation, guestState, target) {
        targetsRef.current.set(tabId, target)
        if (guestState === 'gone' || guestState === 'unmounted') discard(tabId)
        void ensure(tabId, generation, target)
        return () => {
          if (targetsRef.current.get(tabId) === target) targetsRef.current.delete(tabId)
          const entry = entriesRef.current.get(tabId)
          const hiddenHost = hiddenHostRef.current
          if (entry && hiddenHost) hiddenHost.append(entry.wrapper)
        }
      },
    }
  }, [])

  useEffect(() => {
    let dispose: (() => void) | undefined
    void onBrowserEvent((event) => {
      const tabId = typeof event.params.tabId === 'string' ? event.params.tabId : ''
      if (!tabId) return
      if (event.method === 'browser:guest-mount-required') {
        void api.ensure(tabId, Number(event.params.generation) || 0)
      } else if (event.method === 'browser:tab-changed' && (event.params.guestState === 'gone' || event.params.guestState === 'unmounted')) {
        const entry = entriesRef.current.get(tabId)
        entry?.wrapper.remove()
        entriesRef.current.delete(tabId)
      } else if (event.method === 'browser:tab-closed') {
        const entry = entriesRef.current.get(tabId)
        entry?.wrapper.remove()
        entriesRef.current.delete(tabId)
        targetsRef.current.delete(tabId)
      }
    }).then((stop) => { dispose = stop })
    return () => dispose?.()
  }, [api])

  return (
    <BrowserWebviewPoolContext.Provider value={api}>
      {children}
      <div ref={hiddenHostRef} aria-hidden className="pointer-events-none fixed -left-[10000px] -top-[10000px] size-px overflow-hidden" />
    </BrowserWebviewPoolContext.Provider>
  )
}

export function BrowserGuestSurface({ tabId, generation, guestState, className }: {
  tabId: string
  generation: number
  guestState: BrowserTabDescriptor['guestState']
  className?: string
}) {
  const pool = useContext(BrowserWebviewPoolContext)
  const targetRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const target = targetRef.current
    if (!pool || !target) return
    return pool.present(tabId, generation, guestState, target)
  }, [generation, guestState, pool, tabId])
  return <div ref={targetRef} className={className} />
}
