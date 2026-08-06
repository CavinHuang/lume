import { useEffect, useState } from 'react'
import { Provider } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { listen } from '@/lib/desktop-runtime/event'
import { invoke } from '@/lib/desktop-runtime/core'
import { AGENT_ISLAND_IPC_CHANNELS, type AgentIslandIntent, type AgentIslandState } from '@lume/shared'
import { ModelMetaProvider } from '@/lib/model-meta-context'
import { AgentIslandSurface } from './AgentIslandSurface'

/**
 * Agent 灵动岛子窗口的运行时装配壳。结构与 QuickInputShell 对齐：
 * 自带 jotai Provider / TooltipProvider / Toaster，跳过主窗口的 boot 流程，
 * 订阅主进程推送的状态快照，并把用户意图回发为 invoke 命令。
 */
export function AgentIslandApp() {
  // 子窗口跳过了主窗口的 LumeBootScreen 流程，需手动移除 index.html 的静态 #boot-root
  // （z-index:50 的静态 boot 层，否则会一直遮盖岛屿 UI）。与 LumeBootScreen 同机制。
  const [state, setState] = useState<AgentIslandState | null>(null)

  useEffect(() => {
    document.getElementById('boot-root')?.remove()
    let active = true
    let off: (() => void) | undefined
    void listen<{ state: AgentIslandState }>(AGENT_ISLAND_IPC_CHANNELS.STATE, ({ payload }) => {
      if (active) setState(payload.state)
    }).then((unlisten) => {
      if (!active) unlisten?.()
      else off = unlisten
    })
    return () => {
      active = false
      off?.()
    }
  }, [])

  const sendIntent = (intent: AgentIslandIntent) => {
    void invoke(AGENT_ISLAND_IPC_CHANNELS.INTENT, intent)
  }

  return (
    <Provider>
      <ModelMetaProvider>
        <TooltipProvider>
          {state && state.presentation !== 'hidden' && (
            <AgentIslandSurface state={state} onIntent={sendIntent} />
          )}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ModelMetaProvider>
    </Provider>
  )
}
