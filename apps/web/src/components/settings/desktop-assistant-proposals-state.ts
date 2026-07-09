import type { DesktopContextTarget, DesktopProactiveProposal } from '@lume/shared'
import type { Tab } from '@/atoms/tab-atoms'

export function buildDesktopProposalWelcomeState({
  proposal,
  tabs,
  currentWorkspaceId,
}: {
  proposal: DesktopProactiveProposal
  tabs: Tab[]
  currentWorkspaceId: string | null
}): {
  tabs: Tab[]
  activeTabId: string
  promptSeed: string
} {
  const target = proposalToDesktopContextTarget(proposal)
  const nextWelcomeTab: Tab = {
    id: '__welcome__',
    type: 'welcome',
    title: `处理${proposal.app.name}建议`,
    ...(currentWorkspaceId ? { workspaceId: currentWorkspaceId } : {}),
    desktopContextTarget: target,
  }
  const existingIndex = tabs.findIndex((tab) => tab.id === '__welcome__')
  return {
    activeTabId: '__welcome__',
    promptSeed: buildDesktopProposalPrompt(proposal),
    tabs: existingIndex === -1
      ? [...tabs, nextWelcomeTab]
      : tabs.map((tab, index) => index === existingIndex ? nextWelcomeTab : tab),
  }
}

export function buildDesktopProposalOpenRequestState({
  proposalId,
  proposals,
  tabs,
  currentWorkspaceId,
}: {
  proposalId: string
  proposals: DesktopProactiveProposal[]
  tabs: Tab[]
  currentWorkspaceId: string | null
}): {
  tabs: Tab[]
  activeTabId: string
  promptSeed: string
  proposal: DesktopProactiveProposal
} | null {
  const proposal = proposals.find((item) => item.id === proposalId)
  if (!proposal) return null
  return {
    proposal,
    ...buildDesktopProposalWelcomeState({ proposal, tabs, currentWorkspaceId }),
  }
}

function proposalToDesktopContextTarget(proposal: DesktopProactiveProposal): DesktopContextTarget {
  return {
    snapshotId: proposal.snapshotId,
    app: proposal.app,
    window: proposal.window,
    capturedAt: proposal.createdAt,
  }
}

function buildDesktopProposalPrompt(proposal: DesktopProactiveProposal): string {
  if (proposal.kind === 'reply') {
    return `请根据${proposal.app.name}「${proposal.window.title}」里的当前上下文，先建议一条回复；如果我要求你直接处理，可以把回复填入草稿，但发送前必须让我确认。`
  }
  return `请根据${proposal.app.name}「${proposal.window.title}」里的当前上下文，帮我处理这个${proposal.kind}建议。`
}
