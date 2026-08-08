import { MemoryInsightsHub } from '@/components/memory/MemoryInsightsHub'

export interface ProactiveHubProps {
  /** 兼容旧调用方；记忆管理已经收敛到当前中心。 */
  onOpenMemorySettings?: () => void
}

/** 保留旧组件名和 proactive tab 协议，日常界面统一由记忆与洞察中心负责。 */
export function ProactiveHub(props: ProactiveHubProps) {
  return <MemoryInsightsHub {...props} />
}
