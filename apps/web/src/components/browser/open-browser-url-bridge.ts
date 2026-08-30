/**
 * lume:open-browser-url 的 renderer 侧桥 —— 面板未挂载时的 URL 暂存。
 *
 * ZCode 语义:guest 弹窗拦截后 main 回传 open-browser-url,renderer"有 shell →
 * 开新面板 tab + reveal 面板"。Lume 的面板(useBrowserPanel)只在 SidePane 挂载时
 * 订阅该事件;本桥补齐"面板未挂载(右侧面板浏览器 tab 未开/收起)"的路径:
 * URL 落入模块级暂存队列并返回 true,由 reveal 方(右面板)激活浏览器 tab,
 * SidePane 挂载后经 consumePendingBrowserUrls 认领欠账;面板已挂载则返回 false,
 * 交给 hook 内部订阅原地建 tab,避免重复。
 */

/** 已挂载但尚未被 SidePane 认领的 URL(先到先开,保持到达序)。 */
const pendingUrls: string[] = []

let panelMounted = false

/** SidePane 宿主在挂载/卸载时登记,决定 deliverOpenBrowserUrl 的路由。 */
export function setBrowserPanelMounted(mounted: boolean): void {
  panelMounted = mounted
}

/**
 * 交付一条 open-browser-url。
 * 返回 true 表示面板未挂载、URL 已暂存,调用方须 reveal 面板;
 * 返回 false 表示面板已挂载,由 useBrowserPanel 内部订阅处理,调用方无须动作。
 */
export function deliverOpenBrowserUrl(url: string): boolean {
  if (panelMounted) return false
  pendingUrls.push(url)
  return true
}

/** SidePane 挂载后取走全部暂存 URL(按到达序;openUrlTab 逐条消费)。 */
export function consumePendingBrowserUrls(): string[] {
  return pendingUrls.splice(0)
}
