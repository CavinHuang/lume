export type SharedTabState = { partition: string; shareable?: boolean; agentLease?: { browserSessionId: string; browserTurnId: string; generation: number } }

export function canAgentClaim(tab: SharedTabState, sessionId: string, turnId: string): boolean {
  return tab.partition === 'persist:lume-browser' && tab.shareable === true && Boolean(sessionId && turnId)
}

export function canAgentUse(tab: SharedTabState, sessionId: string, turnId: string, generation: number): boolean {
  return tab.agentLease?.browserSessionId === sessionId && tab.agentLease.browserTurnId === turnId && tab.agentLease.generation === generation
}

export function revokeSharedLease(tab: SharedTabState): void { tab.agentLease = undefined }

/** 用户接管会把 tab 置为 paused_by_user 并复用 handoff 标记；resume 必须绕开被接管的 tab，
 *  否则 agent 可借租约失效后的恢复路径单方面撤销用户的接管暂停。 */
export function canAgentResumeHandoff(tab: { handoff?: { browserSessionId?: string; status?: string }; agentControlState?: string }, sessionId: string): boolean {
  return tab.agentControlState !== "paused_by_user"
    && (tab.handoff?.status === "handoff" || tab.handoff?.status === "deliverable")
    && tab.handoff?.browserSessionId === sessionId
}
