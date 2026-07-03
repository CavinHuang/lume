import { CornerDownLeft, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

/**
 * 交互式覆盖层是否应在按下 Enter 时提交。
 * 焦点位于输入框 / 文本域时返回 false——保留原生输入与换行；
 * 焦点位于按钮时，仅当该按钮标记了 data-enter-submits（选项按钮）才返回 true，
 * 由覆盖层统一提交——原生 Enter→click 对选项按钮只会重复选中，无法提交；
 * 未标记的按钮（提交/忽略/开关）返回 false，交由原生 Enter→click 处理以避免重复触发；
 * 其余情况（焦点在卡片正文或未聚焦）返回 true。
 */
export function shouldSubmitInteractiveOverlayOnEnter(
  event: { key: string },
  target: EventTarget | null,
): boolean {
  if (event.key !== 'Enter') return false
  const element = target as { closest?: (selector: string) => Element | null } | null
  if (element?.closest?.('textarea, input')) return false
  if (element?.closest?.('button')) {
    return Boolean(element.closest('[data-enter-submits]'))
  }
  return true
}

interface InteractiveOverlayFrameProps {
  kind: string
  title: string
  children: ReactNode
  busy?: boolean
  submitDisabled?: boolean
  onSubmit: () => void
  onIgnore: () => void
}

export function InteractiveOverlayFrame({
  kind,
  title,
  children,
  busy = false,
  submitDisabled = false,
  onSubmit,
  onIgnore,
}: InteractiveOverlayFrameProps) {
  return (
    <div className="px-3 pb-2 sm:px-6">
      <section
        data-interactive-overlay={kind}
        className="mx-auto max-w-[900px] rounded-[22px] border border-black/10 bg-white p-3 shadow-[0_16px_52px_rgba(15,23,42,0.16)]"
      >
        <h3 className="px-1 pb-2.5 text-[16px] font-semibold leading-6 text-[#1f232b]">{title}</h3>
        {children}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onIgnore}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-[var(--text-3)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            忽略 <kbd className="rounded-md bg-[#f0f0f2] px-1.5 py-0.5 font-mono text-[12px] text-[#5c626d]">ESC</kbd>
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || submitDisabled}
            className={cn(
              'inline-flex h-9 min-w-[82px] items-center justify-center gap-1.5 rounded-[16px] bg-[#5f9cff] px-3.5 text-[14px] font-semibold text-white shadow-[0_8px_18px_rgba(95,156,255,0.32)] transition-colors hover:bg-[#4b8cf0]',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : null}
            提交
            {!busy && <CornerDownLeft size={15} />}
          </button>
        </div>
      </section>
    </div>
  )
}
