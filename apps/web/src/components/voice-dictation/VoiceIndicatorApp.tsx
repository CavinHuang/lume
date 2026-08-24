/**
 * 语音听写指示条：无焦点悬浮窗（focusable:false），在 system-cursor 输出模式下
 * 从外部应用以 Alt+V 唤起。保持当前应用焦点不被抢占，录音状态与转写在此展示，
 * 停止后由主进程粘贴到唤起时的前台应用光标处。
 */

import * as React from 'react'
import { Provider } from 'jotai'
import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useVoiceDictation, formatVoiceElapsed } from './use-voice-dictation'
import { VolumeBars } from './VolumeBars'

function VoiceIndicatorSurface() {
  const hasStartedRef = React.useRef(false)
  const voice = useVoiceDictation({ onCommit: () => undefined })

  // Alt+V 二次按下 = 结束并提交；窗口自身 focusable:false，收不到键盘。
  React.useEffect(() => {
    let cancelled = false
    const unlisten = listen<null>('voice-dictation:indicator-toggle', () => {
      if (cancelled) return
      if (voice.status === 'recording' || voice.status === 'connecting') {
        void voice.stop()
        return
      }
      if (voice.status === 'idle') {
        hasStartedRef.current = true
        void voice.start()
      }
    })
    return () => {
      cancelled = true
      unlisten.then((fn) => fn())
    }
  }, [voice.status, voice.start, voice.stop])

  // 会话结束后自动隐藏窗口（首次显示前不触发）；有结果/错误通知时停留片刻供阅读。
  React.useEffect(() => {
    if (!hasStartedRef.current || voice.isActive) return
    const delay = voice.notice ? 2600 : 0
    const timer = setTimeout(() => {
      invoke('voice_dictation_hide_indicator', null).catch(() => {})
    }, delay)
    return () => clearTimeout(timer)
  }, [voice.isActive, voice.notice])

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-transparent">
      <div className="lume-panel flex w-[364px] items-center gap-2.5 rounded-2xl px-3 py-2 shadow-[0_18px_42px_-24px_hsl(var(--lume-shadow-panel)/0.7)]">
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            voice.status === 'recording' ? 'animate-pulse bg-[var(--lume-danger)]' : 'bg-[var(--lume-text-muted)]',
          )}
        />
        <span className="shrink-0 font-mono text-ui tabular-nums text-[var(--lume-text-secondary)]">
          {formatVoiceElapsed(voice.elapsedSeconds)}
        </span>
        <VolumeBars
          volumeRef={voice.volumeRef}
          active={voice.status === 'recording'}
          className="flex h-3.5 shrink-0 items-center gap-[2px]"
          barClassName="w-[3px] rounded-full bg-[var(--lume-danger)] transition-[height] duration-100"
        />
        <div
          className={cn(
            'min-w-0 flex-1 truncate text-ui',
            voice.notice?.tone === 'error' ? 'text-[var(--lume-danger)]' : 'text-[var(--lume-text-secondary)]',
          )}
        >
          {voice.notice?.text
            || voice.transcript
            || (voice.status === 'connecting' ? '正在连接语音识别…' : voice.status === 'stopping' ? '正在整理转写…' : '正在听写，再按快捷键结束')}
        </div>
        <button
          type="button"
          onClick={voice.cancel}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-caption text-[var(--lume-text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--lume-text-secondary)]"
        >
          放弃
        </button>
      </div>
    </div>
  )
}

export function VoiceIndicatorApp() {
  // 子窗口跳过主窗口 boot 流程，需手动移除 index.html 的静态 #boot-root 遮层。
  React.useEffect(() => {
    document.getElementById('boot-root')?.remove()
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
  }, [])
  return (
    <Provider>
      <TooltipProvider>
        <VoiceIndicatorSurface />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </Provider>
  )
}
