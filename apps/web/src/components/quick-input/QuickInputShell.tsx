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
