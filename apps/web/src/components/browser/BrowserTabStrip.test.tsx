import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserPanelTab } from './useBrowserPanel'
import type { UseBrowserPanelResult } from './useBrowserPanel'
import { BrowserTabStrip } from './BrowserTabStrip'

function stubTab(overrides: Partial<BrowserPanelTab> = {}): BrowserPanelTab {
  return {
    tabId: 't1',
    workspaceKey: 'default',
    sessionId: 'user',
    browserId: 'unclaimed-iab',
    browserGeneration: 0,
    origin: 'user',
    residency: 'resident',
    guestState: 'unmounted',
    title: null,
    url: 'https://example.com',
    faviconUrl: null,
    loading: false,
    operationUntil: 0,
    guestGeneration: 0,
    errorMessage: null,
    loadErrorCode: null,
    guestFailure: null,
    ...overrides,
  }
}

function stubPanel(tabs: BrowserPanelTab[], overrides: Partial<UseBrowserPanelResult> = {}): UseBrowserPanelResult {
  return {
    tabs,
    selectedTabId: tabs[0]?.tabId ?? null,
    selectedTab: tabs[0] ?? null,
    closedTabs: [],
    panelVisible: true,
    operationActive: false,
    responsiveViewport: null,
    responsiveZoom: 'fit',
    visualZoom: 1,
    resizeBaselineVersion: 0,
    surfaceStaging: false,
    canvasRef: { current: null },
    scrollContainerRef: { current: null },
    canvasSize: { width: 0, height: 0 },
    selectTab: () => undefined,
    openUrlTab: () => undefined,
    closeTab: () => undefined,
    reorderTabs: () => undefined,
    reopenClosedTab: () => undefined,
    rebuildTab: () => undefined,
    navigate: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    reload: () => undefined,
    openDevTools: () => undefined,
    openExternalUrl: () => undefined,
    toggleResponsiveMode: () => undefined,
    setResponsiveZoom: () => undefined,
    applyResponsiveViewportSize: () => undefined,
    wakeSuspendedTab: () => undefined,
    ...overrides,
  } as UseBrowserPanelResult
}

// SSR 静态断言:拖拽上下文/溢出区不参与 SSR 交互,验证渲染形状与 DOM 钩子。
describe('BrowserTabStrip(SSR 渲染形状)', () => {
  test('渲染 tab 标签、data 钩子与内联"+"按钮(未溢出)', () => {
    const html = renderToStaticMarkup(
      <BrowserTabStrip panel={stubPanel([stubTab({ tabId: 't1', title: '示例页' }), stubTab({ tabId: 't2', title: '另一页' })])} />,
    )
    expect(html).toContain('示例页')
    expect(html).toContain('另一页')
    expect(html).toContain('data-side-pane-tabs-viewport')
    expect(html).toContain('data-side-pane-tabs-content')
    expect(html).toContain('data-side-pane-tab-id="t1"')
    expect(html).toContain('data-state="active"')
    expect(html).toContain('aria-label="新建浏览器标签页"')
    expect(html).not.toContain('aria-label="标签页总览"') // 未溢出无 chevron
  })

  test('驻留徽标与 residency 钩子', () => {
    const html = renderToStaticMarkup(
      <BrowserTabStrip panel={stubPanel([stubTab({ residency: 'suspended' })])} />,
    )
    expect(html).toContain('挂起')
    expect(html).toContain('data-browser-tab-residency="suspended"')
  })
})
