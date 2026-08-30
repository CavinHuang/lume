/**
 * 浏览器侧面板(SidePane)—— ZCode 语义的 tab 模型面板在 Lume 的外壳。
 *
 * 组成:
 *  - tab 条(dnd-kit 拖拽重排/溢出估宽/渐隐 mask/总览弹层,见 BrowserTabStrip;
 *    最近关闭重开入口在工具栏菜单);
 *  - agent 操作横幅(面板级 5s,BrowserViewOperation 驱动);
 *  - 工具栏:后退/前进/刷新 + 地址栏 + 视口菜单(responsive/预设/缩放)+ devtools +
 *    系统浏览器打开 + 最近关闭重开;
 *  - 画布:webview 池的 present 目标;responsive 模式下为可滚动画布
 *    (viewport × visualZoom 缩放补偿,wheel 边界续接挂在外层滚动容器);
 *    agent 操作期间用户 resize 弱提示(aEt 移植,见 useBrowserResizeWarning);
 *  - 视口信息条:宽/高数字输入(Enter/blur 提交 + 整数范围校验 + tooltip 提示 +
 *    Escape 还原,$Tt 移植)+ 缩放显示;
 *  - 空态/挂起占位/错误卡(证书错误/加载失败/guest 崩溃,LTt/ITt 分型)。
 *
 * UI 约定:一律使用 components/ui 的 shadcn 原子组件(AGENTS.md);文案为内联中文
 * (偏差:旧实现走 react-intl id,浏览器 i18n 键已随四端删除,后置补齐)。
 * ZCode 对应件:SidePane 布局 + NTt 工具栏 + XTt 画布 + $Tt 视口输入条 + LTt/ITt 错误卡 + aEt 警告条。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Code2,
  MonitorSmartphone,
  MoreVertical,
  RotateCw,
  ShieldAlert,
  Smartphone,
  Tablet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BrowserTabStrip } from './BrowserTabStrip'
import { formatRelativeTime, isCertificateErrorCode } from './browser-panel-logic'
import { useBrowserResizeWarning, useOperationWindowActive } from './useBrowserResizeWarning'
import {
  BROWSER_VIEWPORT_LIMITS,
  useBrowserPanel,
  type BrowserPanelTab,
  type BrowserResponsiveViewport,
  type UseBrowserPanelResult,
} from './useBrowserPanel'

const ZOOM_OPTIONS: Array<'fit' | number> = ['fit', 50, 75, 100, 125, 150, 200]

const VIEWPORT_PRESETS: Array<{ label: string; icon: typeof Smartphone; viewport: { width: number; height: number } }> = [
  { label: `手机 393×852`, icon: Smartphone, viewport: { width: 393, height: 852 } },
  { label: `平板 768×1024`, icon: Tablet, viewport: { width: 768, height: 1024 } },
  { label: `桌面 1280×720`, icon: MonitorSmartphone, viewport: { width: 1280, height: 720 } },
]

export function BrowserSidePane({ className, workspaceKey, desktopZoomFactor = 1, onPanelReady }: {
  className?: string
  /** 工作区身份:tabs/选中/收起态按 workspaceKey 分桶存取(见 browser-workspace-state.ts)。 */
  workspaceKey?: string
  /** 桌面 zoom 因子(ZCode SEt;Lume renderer 未暴露宿主档位,缺省 1 恒等)。 */
  desktopZoomFactor?: number
  /**
   * 面板实例上报(右面板宿主认领 open-browser-url 欠账用)。面板对象每次渲染都是
   * 新字面量,故仅在挂载时上报一次;动作回调均经 ref/稳定 setter 实现,句柄持续有效。
   */
  onPanelReady?: (panel: UseBrowserPanelResult | null) => void
}) {
  // 工作区身份:tabs/选中/收起态按 workspaceKey 分桶存取(见 browser-workspace-state.ts),
  // 切换工作区(或任务)时旧工作区落库、新工作区恢复;缺省 'default' 单桶。
  const panel = useBrowserPanel({ workspaceKey, desktopZoomFactor })
  const { selectedTab } = panel
  const [addressDraft, setAddressDraft] = useState('')
  const canvasRegionRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef(panel)
  panelRef.current = panel
  const onPanelReadyRef = useRef(onPanelReady)
  onPanelReadyRef.current = onPanelReady
  // aEt:agent 操作窗 + 用户 resize 弱提示(agent 视口操作经 resizeBaselineVersion 抑制)。
  const operationActive = useOperationWindowActive(selectedTab?.operationUntil ?? 0)
  const { notifyBrowserViewportResize, showResizeWarning } = useBrowserResizeWarning({
    containerRef: canvasRegionRef,
    isVisible: panel.panelVisible,
    operationActive,
    resizeBaselineVersion: panel.resizeBaselineVersion,
  })

  // 挂载时上报面板句柄,卸载时注销(ZCode 面板挂载登记语义)。
  useEffect(() => {
    onPanelReadyRef.current?.(panelRef.current)
    return () => onPanelReadyRef.current?.(null)
  }, [])

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
          agent 正在操作浏览器
        </div>
      ) : null}
      <BrowserToolbar
        panel={panel}
        addressDraft={addressDraft}
        onAddressDraftChange={setAddressDraft}
        onSubmitAddress={submitAddress}
        onLocalViewportAction={notifyBrowserViewportResize}
      />
      {selectedTab && panel.responsiveViewport ? (
        <div className="flex shrink-0 items-center justify-center gap-1.5 border-b border-border px-3 py-1 text-xs text-muted-foreground">
          <ViewportDimensionInput axis="width" viewport={panel.responsiveViewport} onCommit={panel.applyResponsiveViewportSize} />
          <span aria-hidden="true">×</span>
          <ViewportDimensionInput axis="height" viewport={panel.responsiveViewport} onCommit={panel.applyResponsiveViewportSize} />
          <span aria-hidden="true">·</span>
          <span>缩放 {Math.round(panel.visualZoom * 100)}%</span>
        </div>
      ) : null}
      <BrowserCanvas panel={panel} regionRef={canvasRegionRef} showResizeWarning={showResizeWarning} />
    </div>
  )
}

type PanelApi = ReturnType<typeof useBrowserPanel>

function BrowserToolbar({ panel, addressDraft, onAddressDraftChange, onSubmitAddress, onLocalViewportAction }: {
  panel: PanelApi
  addressDraft: string
  onAddressDraftChange: (value: string) => void
  onSubmitAddress: () => void
  /** 本地视口动作(responsive 开关)前调用:开 aEt 沉降窗(ZCode CEt onViewportResize)。 */
  onLocalViewportAction: () => void
}) {
  const tab = panel.selectedTab
  const disabled = !tab || tab.residency === 'suspended'
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
      {/* 后退/前进按导航历史禁用(canGoBack/canGoForward 随 did-navigate 刷新,见 useBrowserPanel)。 */}
      <Button type="button" variant="ghost" size="icon-sm" aria-label="后退" disabled={disabled || !tab.canGoBack} onClick={() => tab && panel.goBack(tab.tabId)}>
        <ArrowLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="前进" disabled={disabled || !tab.canGoForward} onClick={() => tab && panel.goForward(tab.tabId)}>
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
          <DropdownMenuItem
            disabled={!tab || !panel.responsiveViewport}
            onClick={() => {
              if (!tab) return
              onLocalViewportAction()
              panel.toggleResponsiveMode()
            }}
          >
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
          {/* 最近关闭重开(ZCode Xde 环;条目带相对时间,重开换新 tabId)。 */}
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">最近关闭</div>
          {panel.closedTabs.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground/70">无最近关闭的标签页</div>
          ) : panel.closedTabs.map((entry) => (
            <DropdownMenuItem key={entry.id} onClick={() => panel.reopenClosedTab(entry.id)}>
              <Globe className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{entry.title?.trim() || entry.url || '新标签页'}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(entry.closedAt)}</span>
            </DropdownMenuItem>
          ))}
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

/**
 * 视口宽/高数字输入(ZCode $Tt 尺寸输入的 Lume 落法,ra 范围 = BROWSER_VIEWPORT_LIMITS)。
 * 语义:草稿随外部视口值同步;Enter/blur 提交,整数 + 轴对应范围(宽 320..3840/高 320..2160)
 * 校验(ZCode ZTt),违规 latch 破坏性边框 + tooltip(aria-invalid + sr-only alert),
 * 输入回到合法值即解除;Escape 还原当前值并失焦(ZCode f);更新走 applyResponsiveViewportSize。
 */
function ViewportDimensionInput({ axis, viewport, onCommit }: {
  axis: 'width' | 'height'
  viewport: BrowserResponsiveViewport
  onCommit: (viewport: BrowserResponsiveViewport) => void
}) {
  const value = axis === 'width' ? viewport.width : viewport.height
  const limits = axis === 'width'
    ? { min: BROWSER_VIEWPORT_LIMITS.minWidth, max: BROWSER_VIEWPORT_LIMITS.maxWidth }
    : { min: BROWSER_VIEWPORT_LIMITS.minHeight, max: BROWSER_VIEWPORT_LIMITS.maxHeight }
  const rangeHint = `请输入 ${limits.min}~${limits.max} 之间的整数`
  const [draft, setDraft] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  /** 合法 = 整数且落在轴范围(ZCode ZTt)。 */
  const isValid = (raw: string) => {
    const parsed = Number(raw.trim())
    return Number.isInteger(parsed) && parsed >= limits.min && parsed <= limits.max
  }

  /** 提交(ZCode p):违规则 latch 提示;合法但与当前值相同则还原草稿,不动视口。 */
  const commit = () => {
    const parsed = Number(draft.trim())
    if (!isValid(draft)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (parsed === value) {
      setDraft(String(value))
      return
    }
    onCommit(axis === 'width' ? { ...viewport, width: parsed } : { ...viewport, height: parsed })
  }

  return (
    <>
      <Tooltip open={invalid}>
        <TooltipTrigger
          render={
            <Input
              aria-label={axis === 'width' ? '视口宽度' : '视口高度'}
              aria-invalid={invalid || undefined}
              value={draft}
              inputMode="numeric"
              min={limits.min}
              max={limits.max}
              spellCheck={false}
              className="h-6 w-14 shrink-0 rounded-md border-transparent bg-foreground/5 px-1 text-center text-xs font-medium tabular-nums hover:bg-accent focus-visible:bg-background"
              onChange={(event) => {
                const raw = event.target.value
                setDraft(raw)
                // 违规期间即时复检,回到合法即解除(ZCode m)。
                if (invalid) setInvalid(!isValid(raw))
              }}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commit()
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setInvalid(false)
                  setDraft(String(value))
                  event.currentTarget.blur()
                }
              }}
            />
          }
        />
        <TooltipContent side="bottom" align="center" sideOffset={4} className="border-destructive bg-popover text-destructive">
          {rangeHint}
        </TooltipContent>
      </Tooltip>
      {invalid ? <span role="alert" className="sr-only">{rangeHint}</span> : null}
    </>
  )
}

function BrowserCanvas({ panel, regionRef, showResizeWarning }: {
  panel: PanelApi
  /** browser region 根容器(aEt ResizeObserver 观察目标)。 */
  regionRef: RefObject<HTMLDivElement>
  showResizeWarning: boolean
}) {
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
    <div ref={regionRef} className="relative flex min-h-0 min-w-0 flex-1">
      {showResizeWarning ? (
        <div
          role="status"
          aria-live="polite"
          data-browser-resize-warning="visible"
          className="pointer-events-none absolute top-2 right-2 left-2 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-xl border border-border bg-popover px-3 py-2 text-xs font-medium text-foreground shadow-md"
        >
          <span aria-hidden="true" className="h-4 w-0.5 shrink-0 rounded-full bg-amber-500" />
          <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden="true" />
          <span>agent 正在操作,调整尺寸可能干扰</span>
        </div>
      ) : null}
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
      {tab.guestFailure && !panel.surfaceStaging ? (
        <GuestFailureCard failure={tab.guestFailure} onRebuild={() => panel.rebuildTab(tab.tabId)} />
      ) : tab.errorMessage && !panel.surfaceStaging ? (
        <LoadErrorCard tab={tab} onRetry={() => panel.navigate(tab.tabId, tab.url ?? 'about:blank')} />
      ) : null}
    </div>
  )
}

/** guest 崩溃卡(ZCode LTt:标题 + 描述 + exitCode/reason 明细 + 重建)。 */
function GuestFailureCard({ failure, onRebuild }: {
  failure: { exitCode: number; reason: string }
  onRebuild: () => void
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <AlertTriangle className="mb-6 size-16 text-amber-500 opacity-60" aria-hidden="true" />
        <h3 className="text-sm font-medium text-foreground">渲染进程异常退出</h3>
        <p className="mt-2 text-sm text-muted-foreground">页面进程已崩溃,可尝试重建页面。</p>
        <p className="mt-2 font-mono text-xs break-all text-muted-foreground/70">
          exit code {failure.exitCode} · {failure.reason}
        </p>
        <Button type="button" variant="outline" className="mt-6" onClick={onRebuild}>
          <RotateCw className="size-4" aria-hidden="true" />
          重建页面
        </Button>
      </div>
    </div>
  )
}

/**
 * 加载失败卡(ZCode ITt 分型):证书错误(-217..-200)给"证书错误"标题与提示、
 * 不提供绕过;其余给通用标题。两者都只有重试。
 */
function LoadErrorCard({ tab, onRetry }: { tab: BrowserPanelTab; onRetry: () => void }) {
  const certificateError = isCertificateErrorCode(tab.loadErrorCode)
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        {certificateError
          ? <ShieldAlert className="mb-6 size-16 text-amber-500 opacity-60" aria-hidden="true" />
          : <AlertTriangle className="mb-6 size-16 text-amber-500 opacity-60" aria-hidden="true" />}
        <h3 className="text-sm font-medium text-foreground">{certificateError ? '证书错误' : '页面加载失败'}</h3>
        <p className="mt-2 font-mono text-xs break-all text-muted-foreground/70">{tab.errorMessage}</p>
        {certificateError ? (
          <p className="mt-3 text-sm text-muted-foreground">该网站证书无效,已阻止访问。可重试加载,或改用系统浏览器打开。</p>
        ) : null}
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RotateCw className="size-4" aria-hidden="true" />
          重试
        </Button>
      </div>
    </div>
  )
}
