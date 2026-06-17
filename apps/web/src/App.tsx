import { AppShell } from '@/components/app-shell/AppShell'
import { LumeBootScreen } from '@/components/boot'
import { useGlobalAgentListeners } from '@/hooks/useGlobalAgentListeners'
import { useReadingListeners } from '@/hooks/useReadingListeners'
import { useSkillListeners } from '@/hooks/useSkillListeners'
import { useWorkspaceBootstrap } from '@/hooks/useWorkspaceBootstrap'
import { healthcheck } from '@/lib/desktop-api'
import { Provider } from 'jotai'
import { useEffect, useState } from 'react'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

function AppInner() {
  useGlobalAgentListeners()
  useReadingListeners()
  useSkillListeners()
  useWorkspaceBootstrap()
  return <AppShell />
}

// 安全网：兜底上限。Rust 的 `healthcheck` 命令会在 sidecar 就绪或其自身响应超时
// (SIDECAR_RESPONSE_TIMEOUT_SECS) 时先行返回；这里留出余量，确保由 Rust 给出结论。
const HEALTHCHECK_TIMEOUT_MS = 50_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

const BOOT_LOGO_URL = new URL('./assets/imgs/logo.png', import.meta.url).href

export function App() {
  const [ready, setReady] = useState(false)
  const [bootDone, setBootDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    withTimeout(healthcheck(), HEALTHCHECK_TIMEOUT_MS)
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const isTimeout = err instanceof Error && err.message === 'timeout'
        setError(
          isTimeout
            ? '后端启动超时，请检查 sidecar 是否正常运行。'
            : '无法连接到后端，请检查环境配置后重启应用。'
        )
      })
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-background gap-3">
        <p className="text-destructive font-medium text-[14px]">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-1.5 rounded-lg border border-border text-[12px] text-foreground/70 hover:bg-muted/50 transition-colors"
        >
          重试
        </button>
      </div>
    )
  }

  if (!ready || !bootDone) {
    return (
      <LumeBootScreen
        logoSrc={BOOT_LOGO_URL}
        ready={ready}
        onExited={() => setBootDone(true)}
      />
    )
  }

  return (
    <Provider>
      <TooltipProvider>
        <AppInner />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </Provider>
  )
}
