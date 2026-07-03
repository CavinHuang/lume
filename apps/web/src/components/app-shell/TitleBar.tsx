/**
 * TitleBar - 桌面端自定义标题栏（实体栏）
 *
 * 左段：侧栏开关 + Logo（macOS 左侧留 80px 给原生交通灯）。
 * 中段：搜索 / 命令入口（点击打开命令面板，复用 Ctrl+K）。
 * 右段：右侧面板控件 + （Win/Linux）自绘窗口按钮。
 * macOS 保留原生交通灯，仅自绘中间内容。
 */

import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import { PanelLeft, Search, Sparkles } from 'lucide-react'
import { activeTabIdAtom, commandPaletteOpenAtom, sidebarCollapsedAtom, tabsAtom } from '@/atoms'
import { RightPanelWindowControls } from '@/components/right-panel'
import {
  isCustomWindowControlsPlatform,
  isMacosDesktopShell,
} from '@/lib/platform'
import { cn } from '@/lib/utils'
import { DRAG_REGION, NO_DRAG_REGION } from './app-region'
import { WindowButtons } from './WindowButtons'

export type TitleBarVariant = 'macos' | 'custom-controls' | 'browser'

function resolveVariant(): TitleBarVariant {
  if (isMacosDesktopShell) return 'macos'
  if (isCustomWindowControlsPlatform) return 'custom-controls'
  return 'browser'
}

export function TitleBar({ variant = resolveVariant() }: { variant?: TitleBarVariant }) {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const setOpen = useSetAtom(commandPaletteOpenAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activeThreadId = activeTab?.type === 'agent' ? activeTab.threadId : undefined

  return (
    <div
      data-testid="titlebar"
      data-variant={variant}
      style={DRAG_REGION}
      className={cn(
        'flex h-10 items-center gap-2 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] pr-2 text-[var(--lume-text-primary)] select-none',
        variant === 'macos' ? 'pl-[80px]' : 'pl-2',
      )}
      onDoubleClick={variant === 'custom-controls' ? () => {
        // Win/Linux 的 drag 区不自动双击最大化，需手动触发。
        void getCurrentWindowForDoubleClick(variant)
      } : undefined}
    >
      {/* 左段：侧栏开关 + Logo */}
      <div className="flex items-center gap-2" style={NO_DRAG_REGION}>
        <button
          type="button"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => setCollapsed(!collapsed)}
          className="flex size-8 items-center justify-center rounded-[8px] text-[var(--lume-text-muted)] transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] active:bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_78%,black)]"
        >
          <PanelLeft size={16} />
        </button>
        <div className="flex items-center gap-1.5 px-1">
          <Sparkles size={16} className="text-[var(--lume-accent)]" />
          <span className="text-sm font-medium">Lume</span>
        </div>
      </div>

      {/* 中段：搜索 / 命令入口（两侧留白可拖窗，按钮本身 no-drag） */}
      <div className="flex-1 flex justify-center" style={DRAG_REGION}>
        <button
          type="button"
          style={NO_DRAG_REGION}
          onClick={() => setOpen(true)}
          className="flex h-8 w-full max-w-[420px] items-center gap-2 rounded-[8px] border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_62%,transparent)] px-3 text-sm text-[var(--lume-text-muted)] transition-colors duration-150 ease-out hover:border-[var(--lume-border-strong)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-secondary)]"
        >
          <Search size={14} />
          <span>搜索 / 跳转…</span>
        </button>
      </div>

      {/* 右段：右面板控件 + （Win/Linux）窗口按钮 */}
      <div className="flex items-center gap-2" style={NO_DRAG_REGION}>
        {activeThreadId && <RightPanelWindowControls />}
        {variant === 'custom-controls' && <WindowButtons />}
      </div>
    </div>
  )
}

/** 仅 custom-controls 平台需要双击最大化；避免在无桥接的环境调用。 */
async function getCurrentWindowForDoubleClick(variant: TitleBarVariant) {
  if (variant !== 'custom-controls') return
  const { getCurrentWindow } = await import('@/lib/desktop-runtime/window')
  await getCurrentWindow().toggleMaximize().catch(() => {})
}
