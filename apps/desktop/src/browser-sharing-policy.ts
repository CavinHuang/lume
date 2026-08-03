export type SharedTabState = { partition: string; shareable?: boolean; agentLease?: { browserSessionId: string; browserTurnId: string; generation: number } }

export function canAgentClaim(tab: SharedTabState, sessionId: string, turnId: string): boolean {
  return tab.partition === 'persist:lume-browser' && tab.shareable === true && Boolean(sessionId && turnId)
}

export function canAgentUse(tab: SharedTabState, sessionId: string, turnId: string, generation: number): boolean {
  return tab.agentLease?.browserSessionId === sessionId && tab.agentLease.browserTurnId === turnId && tab.agentLease.generation === generation
}

export function revokeSharedLease(tab: SharedTabState): void { tab.agentLease = undefined }
