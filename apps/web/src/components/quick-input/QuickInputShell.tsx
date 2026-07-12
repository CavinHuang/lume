import { useEffect } from 'react'
import { Provider } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { QuickInput } from './QuickInput'
import { DesktopActionVisualOverlay } from '@/components/agent/DesktopActionVisualOverlay'

/**
 * 快速输入子窗口的运行时装配壳。结构与 App.tsx 的 Provider 子树一致，
 * 让 AgentView 拿到与主窗口相同的 jotai Provider / Tooltip / Toaster 运行时。
 */
export function QuickInputShell() {
  // 子窗口跳过了主窗口的 LumeBootScreen 流程，需手动移除 index.html 的静态 #boot-root
  // （z-index:50 的静态 boot 层，否则会一直遮盖 QuickInput）。与 LumeBootScreen 同机制。
  useEffect(() => {
    document.getElementById('boot-root')?.remove()
  }, [])
  return (
    <Provider>
      <TooltipProvider>
        <QuickInput />
        <DesktopActionVisualOverlay />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </Provider>
  )
}
