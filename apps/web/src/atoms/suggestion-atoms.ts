import { atom } from 'jotai'

/**
 * 建议变更版本号（单调递增）。每次收到 sidecar 推送的
 * SUGGESTION_IPC_CHANNELS.CHANGED 通知时 +1。
 *
 * 消费方（建议列表 / Banner / Hub，Task 14+）用 useAtomValue 订阅此 atom，
 * 在 useEffect 依赖中加入版本号即可触发重新拉取 suggestion:list —— 无需各自
 * 直接监听底层推送通道。这是 web 侧唯一的建议 reload 信号源。
 */
export const suggestionsVersionAtom = atom(0)
