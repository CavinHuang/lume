/**
 * 浏览器侧面板(SidePane)—— ZCode 语义的 tab 模型面板在 Lume 的外壳。
 *
 * 组成:
 *  - tab 条(favicon/标题/驻留徽标/关闭),tab 模型来自 useBrowserPanel;
 *  - 工具栏:后退/前进/刷新 + 地址栏 + 视口菜单(responsive/预设/缩放)+ devtools +
 *    系统浏览器打开;
 *  - agent 操作横幅(5s,BrowserViewOperation 驱动);
 *  - 画布:webview 池的 present 目标;responsive 模式下为可滚动画布
 *    (viewport × visualZoom 缩放补偿,wheel 边界续接挂在外层滚动容器);
 *  - 空态/挂起占位/错误卡(重试走 navigate 原位重建路径)。
 *
 * UI 约定:一律使用 components/ui 的 shadcn 原子组件(AGENTS.md);文案为内联中文
 * (偏差:旧实现走 react-intl id,浏览器 i18n 键已随四端删除,后置补齐)。
 * ZCode 对应件:SidePane 布局 + NTt 工具栏 + XTt 画布 + LTt/ITt 错误卡(04 切片)。
 */
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Code2,
  MonitorSmartphone,
  MoreVertical,
  RotateCw,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  BROWSER_VIEWPORT_LIMITS,
  useBrowserPanel,
  type BrowserPanelTab,
} from './useBrowserPanel'

const ZOOM_OPTIONS: Array<'fit' | number> = ['fit', 50, 75, 100, 125, 150, 200]

const VIEWPORT_PRESETS: Array<{ label: string; icon: typeof Smartphone; viewport: { width: number; height: number } }> = [
  { label: `手机 393×852`, icon: Smartphone, viewport: { width: 393, height: 852 } },
  { label: `平板 768×1024`, icon: Tablet, viewport: { width: 768, height: 1024 } },
  { label: `桌面 1280×720`, icon: MonitorSmartphone, viewport: { width: 1280, height: 720 } },
]

export function BrowserSidePane({ className }: { className?: string }) {
  const panel = useBrowserPanel()
  const { selectedTab } = panel
  const [addressDraft, setAddressDraft] = useState('')

  // 地址栏草稿跟随选中 tab 的真实 URL(ZCode T/addressValue 同步语义)。
  useEffect(() => {
    setAddressDraft(selectedTab?.url && selectedTab.url !== 'about:blank' ? selectedTab.url : '')
  }, [selectedTab?.tabId, selectedTab?.url])

  const submitAddress = () => {
    if (!selectedTab) {
      panel.openUrlTab(addressDraft)
      return
    }
    panel.navigate(selectedTab.tabId, addressDraft || selectedTab.url || 'about:blank')
  }

  return (
    <div className={cn('flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background', className)}>
      <BrowserTabStrip panel={panel} />
      {panel.operationActive ? (
        <div role="status" aria-live="polite" className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
          agent 正在操作此页面,请勿调整窗口尺寸
        </div>
      ) : null}
      <BrowserToolbar panel={panel} addressDraft={addressDraft} onAddressDraftChange={setAddressDraft} onSubmitAddress={submitAddress} />
      {selectedTab && panel.responsiveViewport ? (
        <div className="flex items-center justify-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
          <span>视口 {panel.responsiveViewport.width}×{panel.responsiveViewport.height}</span>
          <span aria-hidden="true">·</span>
          <span>缩放 {Math.round(panel.visualZoom * 100)}%</span>
          <span aria-hidden="true">·</span>
          <span>范围 {BROWSER_VIEWPORT_LIMITS.minWidth}~{BROWSER_VIEWPORT_LIMITS.maxWidth} × {BROWSER_VIEWPORT_LIMITS.minHeight}~{BROWSER_VIEWPORT_LIMITS.maxHeight}</span>
        </div>
      ) : null}
      <BrowserCanvas panel={panel} />
    </div>
  )
}

type PanelApi = ReturnType<typeof useBrowserPanel>

function BrowserTabStrip({ panel }: { panel: PanelApi }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1.5">
      {panel.tabs.map((tab) => (
        <BrowserTabButton key={tab.tabId} tab={tab} selected={tab.tabId === panel.selectedTabId} panel={panel} />
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="ml-0.5 shrink-0"
        aria-label="新建浏览器标签页"
        onClick={() => panel.openUrlTab('about:blank')}
      >
        +
      </Button>
    </div>
  )
}

function BrowserTabButton({ tab, selected, panel }: { tab: BrowserPanelTab; selected: boolean; panel: PanelApi }) {
  const label = tab.title?.trim() || tab.url || '新标签页'
  return (
      <div
        className={cn(
          'group flex h-7 min-w-24 max-w-44 shrink-0 items-center gap-1.5 rounded-lg border px-1.5 text-xs font-medium',
          selected ? 'border-border bg-accent text-accent-foreground shadow-sm' : 'border-transparent text-muted-foreground hover:bg-muted',
        )}
      >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => panel.selectTab(tab.tabId)} title={label}>
        {tab.faviconUrl ? (
          <img src={tab.faviconUrl} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" draggable={false} referrerPolicy="no-referrer" />
        ) : (
          <Globe className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      {tab.residency === 'suspended' ? <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] leading-3">挂起</Badge> : null}
      {tab.residency === 'restoring' ? <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px] leading-3">恢复中</Badge> : null}
      <button
        type="button"
        aria-label={`关闭 ${label}`}
        className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          panel.closeTab(tab.tabId)
        }}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}

function BrowserToolbar({ panel, addressDraft, onAddressDraftChange, onSubmitAddress }: {
  panel: PanelApi
  addressDraft: string
  onAddressDraftChange: (value: string) => void
  onSubmitAddress: () => void
}) {
  const tab = panel.selectedTab
  const disabled = !tab || tab.residency === 'suspended'
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="后退" disabled={disabled} onClick={() => tab && panel.goBack(tab.tabId)}>
        <ArrowLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="前进" disabled={disabled} onClick={() => tab && panel.goForward(tab.tabId)}>
        <ArrowRight className="size-4" aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新" disabled={disabled} onClick={() => tab && panel.reload(tab.tabId)}>
        <RotateCw className={cn('size-4', tab?.loading && 'animate-spin')} aria-hidden="true" />
      </Button>
      <Input
        value={addressDraft}
        placeholder={tab ? '输入网址,回车打开' : '输入网址打开新标签页'}
        className="h-7 min-w-0 flex-1 rounded-lg"
        onChange={(event) => onAddressDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onSubmitAddress()
          }
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="ghost" size="icon-sm" aria-label="浏览器选项">
            <MoreVertical className="size-4" aria-hidden="true" />
          </Button>}
        />
        <DropdownMenuContent align="end" className="w-56">
          {/* ui/dropdown-menu 未导出 Label(Base UI 菜单无对应件);分组标题用静态文本。 */}
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">响应式视口</div>
          {VIEWPORT_PRESETS.map((preset) => (
            <DropdownMenuItem key={preset.label} disabled={!tab} onClick={() => tab && panel.applyResponsiveViewportSize(preset.viewport)}>
              <preset.icon className="size-4" aria-hidden="true" />
              {preset.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem disabled={!tab || !panel.responsiveViewport} onClick={() => tab && panel.toggleResponsiveMode()}>
            <MonitorSmartphone className="size-4" aria-hidden="true" />
            退出响应式(恢复自适应)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">缩放</div>
          <div className="flex flex-wrap gap-1 px-1 pb-1">
            {ZOOM_OPTIONS.map((option) => (
              <Button
                key={String(option)}
                type="button"
                variant={panel.responsiveZoom === option ? 'secondary' : 'ghost'}
                size="xs"
                className="px-1.5"
                onClick={() => panel.setResponsiveZoom(option)}
              >
                {option === 'fit' ? '适应' : `${option}%`}
              </Button>
            ))}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!tab} onClick={() => tab && panel.openDevTools(tab.tabId)}>
            <Code2 className="size-4" aria-hidden="true" />
            打开开发者工具
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!tab || !(tab.url && /^https?:\/\//i.test(tab.url))}
            onClick={() => tab?.url && panel.openExternalUrl(tab.url)}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            在系统浏览器打开
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function BrowserCanvas({ panel }: { panel: PanelApi }) {
  const tab = panel.selectedTab

  if (!tab) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <Globe className="size-6 opacity-50" aria-hidden="true" />
        <p>在地址栏输入网址,或等待 agent 打开页面。</p>
      </div>
    )
  }

  if (tab.residency === 'suspended') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>该页面已挂起以释放资源。</p>
        <Button type="button" variant="outline" size="sm" onClick={() => panel.wakeSuspendedTab(tab.tabId)}>
          恢复页面
        </Button>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={panel.scrollContainerRef}
        data-responsive-browser-mode={panel.responsiveViewport ? 'active' : 'inactive'}
        className={cn('min-h-0 min-w-0 flex-1', panel.responsiveViewport ? 'overflow-auto bg-muted/40' : 'overflow-hidden bg-background')}
      >
        <div className={cn(panel.responsiveViewport ? 'flex min-h-full w-max min-w-full items-center justify-center p-4' : 'h-full w-full')}>
          <div
            className={cn('relative shrink-0', panel.responsiveViewport ? 'bg-card shadow-sm ring-1 ring-border' : 'h-full w-full')}
            style={panel.responsiveViewport
              ? { width: `${panel.responsiveViewport.width * panel.visualZoom}px`, height: `${panel.responsiveViewport.height * panel.visualZoom}px` }
              : undefined}
          >
            {/* webview 池的 present 目标;webview 实体浮置于全局宿主层,由池贴合到此矩形。 */}
            <div
              ref={panel.canvasRef}
              data-responsive-scale={panel.responsiveViewport ? panel.visualZoom : undefined}
              data-responsive-width={panel.responsiveViewport ? panel.responsiveViewport.width : undefined}
              data-responsive-height={panel.responsiveViewport ? panel.responsiveViewport.height : undefined}
              className={cn('relative', panel.responsiveViewport ? 'shrink-0' : 'h-full w-full')}
              style={panel.responsiveViewport
                ? { width: `${panel.responsiveViewport.width}px`, height: `${panel.responsiveViewport.height}px` }
                : undefined}
            />
          </div>
        </div>
      </div>
      {tab.residency === 'restoring' && !panel.surfaceStaging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/60 text-sm text-muted-foreground">
          正在恢复页面…
        </div>
      ) : null}
      {tab.errorMessage && !panel.surfaceStaging ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm">
          <p className="text-foreground">{tab.errorMessage}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => panel.navigate(tab.tabId, tab.url ?? 'about:blank')}>
            重试
          </Button>
        </div>
      ) : null}
    </div>
  )
}
