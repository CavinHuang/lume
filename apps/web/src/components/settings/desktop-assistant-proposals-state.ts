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
    return `请根据${proposal.app.name}「${proposal.window.title}」里的当前上下文，帮我建议一条回复。`
  }
  return `请根据${proposal.app.name}「${proposal.window.title}」里的当前上下文，帮我处理这个${proposal.kind}建议。`
}
