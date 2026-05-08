import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Globe, RotateCcw } from 'lucide-react'
import { useAtom } from 'jotai'
import type { Tab } from '@/atoms'
import { tabsAtom } from '@/atoms'
import { openExternal } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'

interface BrowserTabViewProps {
  tab: Tab
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`
  }
  return `https://${trimmed}`
}

export function BrowserTabView({ tab }: BrowserTabViewProps) {
  const [, setTabs] = useAtom(tabsAtom)
  const [inputValue, setInputValue] = useState(tab.browserUrl ?? '')
  const [currentUrl, setCurrentUrl] = useState(tab.browserUrl ?? '')
  const activeUrl = useMemo(() => normalizeUrl(currentUrl), [currentUrl])

  useEffect(() => {
    setInputValue(tab.browserUrl ?? '')
    setCurrentUrl(tab.browserUrl ?? '')
  }, [tab.browserUrl])

  const commitUrl = (raw: string) => {
    const nextUrl = normalizeUrl(raw)
    setCurrentUrl(nextUrl)
    setTabs((prev) => prev.map((item) => (item.id === tab.id ? { ...item, browserUrl: nextUrl, title: '浏览器' } : item)))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#171717] text-white">
      <div className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
        <div className="flex size-10 items-center justify-center rounded-[14px] bg-white/[0.05] text-white/72">
          <Globe size={18} />
        </div>
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            commitUrl(inputValue)
          }}
        >
          <input
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder="输入 URL，例如 localhost:3000"
            className="h-11 min-w-0 flex-1 rounded-[16px] border border-white/10 bg-white/[0.04] px-4 text-[15px] text-white outline-none placeholder:text-white/30"
          />
          <button
            type="button"
            onClick={() => setInputValue(currentUrl)}
            className="flex size-11 items-center justify-center rounded-[16px] bg-white/[0.05] text-white/72 transition-colors hover:bg-white/[0.08] hover:text-white"
            title="恢复当前地址"
          >
            <RotateCcw size={18} />
          </button>
          <button
            type="submit"
            className="rounded-[16px] bg-white/[0.08] px-4 py-3 text-[14px] font-medium text-white transition-colors hover:bg-white/[0.12]"
          >
            打开
          </button>
          <button
            type="button"
            onClick={() => activeUrl && openExternal(activeUrl)}
            disabled={!activeUrl}
            className={cn(
              'flex size-11 items-center justify-center rounded-[16px] bg-white/[0.05] text-white/72 transition-colors hover:bg-white/[0.08] hover:text-white',
              !activeUrl && 'cursor-not-allowed opacity-40',
            )}
            title="在系统浏览器打开"
          >
            <ExternalLink size={18} />
          </button>
        </form>
      </div>

      {activeUrl ? (
        <iframe
          key={activeUrl}
          src={activeUrl}
          title="Lume Browser"
          className="min-h-0 flex-1 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="rounded-[24px] border border-white/8 bg-white/[0.03] px-8 py-7 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-[16px] bg-white/[0.05] text-white/70">
              <Globe size={22} />
            </div>
            <div className="text-[18px] font-medium text-white">浏览器</div>
            <p className="mt-2 text-[14px] leading-6 text-white/52">
              输入一个 URL，或直接打开本地地址例如 `localhost:3000`。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
