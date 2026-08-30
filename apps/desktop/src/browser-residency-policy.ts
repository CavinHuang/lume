/**
 * 浏览器驻留策略(对齐 ZCode BrowserTabResidencyCoordinator 的保护条件集)。
 *
 * 挂起 = 冻结 + 卸载 guest(释放渲染进程内存);被保护 tab 不得挂起,
 * enforceBackgroundLimit 仅在非保护 tab 超出后台预算时触发。
 * 状态迁移本身留在 BrowserRuntime(与 Electron 生命周期强耦合),此处只放纯判定。
 */
export type SuspendProtectionTabLike = {
  agentLease?: unknown
  handoff?: unknown
  /** agent 动作在途(对应 ZCode operationActive) */
  agentDispatching?: boolean
  /** JS 对话框待处理:冻结会卡死对话框 */
  dialogOpen?: boolean
  /** 页面加载中:卸载会打断导航 */
  isLoading?: boolean
  mediaState?: { audible?: boolean; camera?: boolean; microphone?: boolean }
}

export function isSuspendProtected(tab: SuspendProtectionTabLike): boolean {
  return Boolean(
    tab.agentLease
    || tab.handoff
    || tab.agentDispatching
    || tab.dialogOpen
    || tab.isLoading
    || tab.mediaState?.audible
    || tab.mediaState?.camera
    || tab.mediaState?.microphone,
  )
}
