import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { BrowserGuestMountDescriptor, BrowserTabDescriptor } from '@lume/shared'
import { browserRuntime, onBrowserEvent } from '@/lib/desktop-api'

type BrowserWebviewElement = HTMLElement & {
  src: string
  partition: string
}

type GuestEntry = {
  generation: number
  wrapper: HTMLDivElement
  webview: BrowserWebviewElement
  target?: HTMLElement
  stopPositioning?: () => void
}

type BrowserGuestHost = HTMLDivElement & {
  lumePendingMounts?: Map<string, Promise<void>>
}

type BrowserWebviewPoolApi = {
  present: (tabId: string, generation: number, guestState: BrowserTabDescriptor['guestState'], target: HTMLElement) => () => void
  ensure: (tabId: string, generation: number, target?: HTMLElement) => Promise<void>
  recover: (tabId: string, generation: number) => Promise<void>
  discard: (tabId: string) => void
}

const BrowserWebviewPoolContext = createContext<BrowserWebviewPoolApi | null>(null)
const BROWSER_GUEST_HOST_ID = 'lume-browser-webview-pool'

function readGuestEntry(wrapper: HTMLDivElement): GuestEntry | undefined {
  const webview = wrapper.querySelector<BrowserWebviewElement>('webview')
  const generation = Number(wrapper.dataset.browserGuestGeneration)
  if (!webview || !Number.isInteger(generation)) return undefined
  return { generation, wrapper, webview }
}

function findGuestEntry(host: HTMLDivElement, tabId: string, mountToken?: string): GuestEntry | undefined {
  for (const wrapper of host.querySelectorAll<HTMLDivElement>('[data-browser-guest-tab-id]')) {
    if (wrapper.dataset.browserGuestTabId !== tabId) continue
    if (mountToken && wrapper.dataset.browserGuestMountToken !== mountToken) continue
    const entry = readGuestEntry(wrapper)
    if (entry) return entry
  }
  return undefined
}

function getBrowserGuestHost(): BrowserGuestHost {
  const existing = document.getElementById(BROWSER_GUEST_HOST_ID)
  if (existing instanceof HTMLDivElement) return existing as BrowserGuestHost
  const host = document.createElement('div') as BrowserGuestHost
  host.id = BROWSER_GUEST_HOST_ID
  host.className = 'pointer-events-none fixed inset-0 z-[61] overflow-hidden'
  document.body.append(host)
  return host
}

function getPendingMounts(host: BrowserGuestHost) {
  return host.lumePendingMounts ??= new Map<string, Promise<void>>()
}

function restoreGuestEntries(host: HTMLDivElement) {
  const entries = new Map<string, GuestEntry>()
  for (const wrapper of host.querySelectorAll<HTMLDivElement>('[data-browser-guest-tab-id]')) {
    const tabId = wrapper.dataset.browserGuestTabId
    const entry = readGuestEntry(wrapper)
    if (tabId && entry) entries.set(tabId, entry)
  }
  return entries
}

export function BrowserWebviewPoolProvider({ children }: { children: ReactNode }) {
  const hostRef = useRef(getBrowserGuestHost())
  const entriesRef = useRef(restoreGuestEntries(hostRef.current))
  const mountsRef = useRef(getPendingMounts(hostRef.current))
  const requestedGenerationsRef = useRef(new Map<string, number>())
  const targetsRef = useRef(new Map<string, HTMLElement>())

  const api = useMemo<BrowserWebviewPoolApi>(() => {
    const stopPositioning = (entry: GuestEntry) => {
      entry.stopPositioning?.()
      entry.stopPositioning = undefined
      entry.target = undefined
      entry.wrapper.style.visibility = 'hidden'
      entry.wrapper.style.pointerEvents = 'none'
    }

    const positionAt = (entry: GuestEntry, target: HTMLElement) => {
      stopPositioning(entry)
      entry.target = target
      let frame = 0
      const update = () => {
        frame = 0
        if (entry.target !== target || !target.isConnected) {
          entry.wrapper.style.visibility = 'hidden'
          entry.wrapper.style.pointerEvents = 'none'
          return
        }
        const rect = target.getBoundingClientRect()
        let visibleTop = Math.max(0, rect.top)
        let visibleRight = Math.min(window.innerWidth, rect.right)
        let visibleBottom = Math.min(window.innerHeight, rect.bottom)
        let visibleLeft = Math.max(0, rect.left)
        for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = window.getComputedStyle(ancestor)
          const clipsX = style.overflowX !== 'visible'
          const clipsY = style.overflowY !== 'visible'
          if (!clipsX && !clipsY) continue
          const ancestorRect = ancestor.getBoundingClientRect()
          if (clipsX) {
            visibleLeft = Math.max(visibleLeft, ancestorRect.left)
            visibleRight = Math.min(visibleRight, ancestorRect.right)
          }
          if (clipsY) {
            visibleTop = Math.max(visibleTop, ancestorRect.top)
            visibleBottom = Math.min(visibleBottom, ancestorRect.bottom)
          }
        }
        if (rect.width <= 0 || rect.height <= 0 || visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
          entry.wrapper.style.visibility = 'hidden'
          entry.wrapper.style.pointerEvents = 'none'
          return
        }
        entry.wrapper.style.visibility = 'visible'
        entry.wrapper.style.pointerEvents = 'auto'
        entry.wrapper.style.left = `${rect.left}px`
        entry.wrapper.style.top = `${rect.top}px`
        entry.wrapper.style.width = `${rect.width}px`
        entry.wrapper.style.height = `${rect.height}px`
        entry.wrapper.style.clipPath = `inset(${Math.max(0, visibleTop - rect.top)}px ${Math.max(0, rect.right - visibleRight)}px ${Math.max(0, rect.bottom - visibleBottom)}px ${Math.max(0, visibleLeft - rect.left)}px)`
      }
      const schedule = () => {
        if (!frame) frame = window.requestAnimationFrame(update)
      }
      const observer = new ResizeObserver(schedule)
      observer.observe(target)
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor)
      window.addEventListener('resize', schedule)
      window.addEventListener('scroll', schedule, true)
      entry.stopPositioning = () => {
        if (frame) window.cancelAnimationFrame(frame)
        observer.disconnect()
        window.removeEventListener('resize', schedule)
        window.removeEventListener('scroll', schedule, true)
      }
      update()
    }

    const discard = (tabId: string) => {
      const entry = entriesRef.current.get(tabId)
      if (!entry) return
      stopPositioning(entry)
      entry.wrapper.remove()
      entriesRef.current.delete(tabId)
    }

    const ensure = async (tabId: string, generation: number, target?: HTMLElement, reclaimRuntimeGuest = false) => {
      requestedGenerationsRef.current.set(tabId, generation)
      if (target) targetsRef.current.set(tabId, target)
      let existing = entriesRef.current.get(tabId) ?? findGuestEntry(hostRef.current, tabId)
      if (existing) entriesRef.current.set(tabId, existing)
      if (existing) {
        // A tab generation changes on normal navigation; the attached guest does not.
        // Only gone/unmounted guest state is allowed to replace this webview.
        const visibleTarget = targetsRef.current.get(tabId)
        if (visibleTarget && existing.target !== visibleTarget) positionAt(existing, visibleTarget)
        return
      }
      const mountKey = `${tabId}:${generation}`
      const pending = mountsRef.current.get(mountKey)
      if (pending) {
        await pending
        const mounted = findGuestEntry(hostRef.current, tabId)
        if (mounted) {
          entriesRef.current.set(tabId, mounted)
          const visibleTarget = targetsRef.current.get(tabId)
          if (visibleTarget) positionAt(mounted, visibleTarget)
        }
        return
      }
      const releasePreparedMount = (descriptor: BrowserGuestMountDescriptor) => browserRuntime({
        method: 'mount:release',
        params: { tabId, mountToken: descriptor.mountToken },
      }).catch(() => undefined)
      const mount = (async () => {
        let reclaimed = reclaimRuntimeGuest
        if (reclaimed) await browserRuntime({ method: 'mount:release', params: { tabId } })
        let descriptor = await browserRuntime<BrowserGuestMountDescriptor | null>({ method: 'mount:prepare', params: { tabId } })
        if (!descriptor) {
          const sharedEntry = findGuestEntry(hostRef.current, tabId)
          if (sharedEntry?.generation === generation) {
            entriesRef.current.set(tabId, sharedEntry)
            const visibleTarget = targetsRef.current.get(tabId)
            if (visibleTarget) positionAt(sharedEntry, visibleTarget)
            return
          }
          if (!reclaimed) {
            reclaimed = true
            await browserRuntime({ method: 'mount:release', params: { tabId } })
            descriptor = await browserRuntime<BrowserGuestMountDescriptor | null>({ method: 'mount:prepare', params: { tabId } })
          }
          if (!descriptor) return
        }
        if (descriptor.tabId !== tabId || descriptor.generation !== generation) {
          await releasePreparedMount(descriptor)
          return
        }
        if (requestedGenerationsRef.current.get(tabId) !== generation) {
          await releasePreparedMount(descriptor)
          return
        }
        const sharedEntry = findGuestEntry(hostRef.current, tabId, descriptor.mountToken)
        if (sharedEntry) {
          entriesRef.current.set(tabId, sharedEntry)
          const visibleTarget = targetsRef.current.get(tabId)
          if (visibleTarget) positionAt(sharedEntry, visibleTarget)
          return
        }
        const current = entriesRef.current.get(tabId)
        if (current?.generation === generation) {
          if (current.wrapper.dataset.browserGuestMountToken !== descriptor.mountToken) await releasePreparedMount(descriptor)
          return
        }
        if (current) discard(tabId)
        const wrapper = document.createElement('div')
        wrapper.dataset.browserGuestTabId = tabId
        wrapper.dataset.browserGuestGeneration = String(generation)
        wrapper.dataset.browserGuestMountToken = descriptor.mountToken
        wrapper.style.position = 'fixed'
        wrapper.style.visibility = 'hidden'
        wrapper.style.overflow = 'hidden'
        wrapper.style.background = 'var(--background)'
        wrapper.style.pointerEvents = 'none'
        const webview = document.createElement('webview') as BrowserWebviewElement
        webview.setAttribute('partition', descriptor.partition)
        webview.setAttribute('allowpopups', '')
        webview.style.display = 'flex'
        webview.style.width = '100%'
        webview.style.height = '100%'
        webview.style.border = '0'
        wrapper.append(webview)
        hostRef.current.append(wrapper)
        webview.setAttribute('src', descriptor.bootstrapUrl)
        const entry = { generation, wrapper, webview }
        entriesRef.current.set(tabId, entry)
        const visibleTarget = targetsRef.current.get(tabId)
        if (visibleTarget) positionAt(entry, visibleTarget)
      })().finally(() => mountsRef.current.delete(mountKey))
      mountsRef.current.set(mountKey, mount)
      return mount
    }

    return {
      discard,
      ensure,
      async recover(tabId, generation) {
        const pending = mountsRef.current.get(`${tabId}:${generation}`)
        if (pending) {
          await pending
          return ensure(tabId, generation)
        }
        discard(tabId)
        return ensure(tabId, generation, undefined, true)
      },
      present(tabId, generation, guestState, target) {
        targetsRef.current.set(tabId, target)
        if (guestState === 'gone') {
          discard(tabId)
          return () => {
            if (targetsRef.current.get(tabId) === target) targetsRef.current.delete(tabId)
          }
        }
        if (guestState === 'unmounted') discard(tabId)
        const localEntry = entriesRef.current.get(tabId)
        const mountKey = `${tabId}:${generation}`
        const reclaimRuntimeGuest = (guestState === 'attaching' || guestState === 'ready')
          && !localEntry
          && !mountsRef.current.has(mountKey)
        void ensure(tabId, generation, target, reclaimRuntimeGuest).catch(() => undefined)
        return () => {
          if (targetsRef.current.get(tabId) === target) targetsRef.current.delete(tabId)
          const entry = entriesRef.current.get(tabId)
          if (entry?.target === target) stopPositioning(entry)
        }
      },
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let dispose: (() => void) | undefined
    void onBrowserEvent((event) => {
      const tabId = typeof event.params.tabId === 'string' ? event.params.tabId : ''
      if (!tabId) return
      if (event.method === 'browser:guest-mount-required') {
        void api.recover(tabId, Number(event.params.generation) || 0).catch(() => undefined)
      } else if (event.method === 'browser:tab-changed' && (event.params.guestState === 'gone' || event.params.guestState === 'unmounted')) {
        api.discard(tabId)
      } else if (event.method === 'browser:tab-closed') {
        api.discard(tabId)
        requestedGenerationsRef.current.delete(tabId)
        targetsRef.current.delete(tabId)
      }
    }).then((stop) => {
      if (disposed) stop()
      else dispose = stop
    })
    return () => {
      disposed = true
      dispose?.()
    }
  }, [api])

  return (
    <BrowserWebviewPoolContext.Provider value={api}>
      {children}
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
