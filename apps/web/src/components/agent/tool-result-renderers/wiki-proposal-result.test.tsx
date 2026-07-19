import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolResultRenderer } from './index'
import { parseWikiChangeDraft, proposalStatusFromDraftStatus, WikiProposalResult, WikiProposalSettledSummary } from './wiki-proposal-result'

const draft = {
  id: 'draft-1',
  revision: 1,
  nonce: 'nonce-1',
  expiresAt: '2026-07-19T00:00:00.000Z',
  origin: 'agent',
  risk: 'low',
  riskReasons: [],
  title: 'Agent 建议新建 Lume Wiki 设计',
  operations: [{ kind: 'create', pageId: 'page-1', beforeHash: null, targetRelativePath: 'workspaces/lume/page.md', markdown: '# Lume Wiki' }],
  sources: [],
  diffs: [{ path: 'workspaces/lume/page.md', beforeHash: null, afterHash: 'hash-1', preview: '新建页面' }],
  pageVisibilityWorkspaceIds: ['workspace-1'],
  sourceGrantWorkspaceIds: [],
}

describe('WikiProposalResult', () => {
  test('parses both direct and SDK-wrapped Wiki drafts', () => {
    expect(parseWikiChangeDraft(draft)?.id).toBe('draft-1')
    expect(parseWikiChangeDraft({ data: draft })?.nonce).toBe('nonce-1')
    expect(parseWikiChangeDraft('invalid')).toBeNull()
  })

  test('renders a confirmation card that checks durable status before offering actions', () => {
    const markup = renderToStaticMarkup(<WikiProposalResult result={draft} />)

    expect(markup).toContain('Agent 建议新建 Lume Wiki 设计')
    expect(markup).toContain('尚未写入正式 Wiki')
    expect(markup).toContain('正在确认草案状态')
    expect(markup).not.toContain('nonce-1')
  })

  test('maps durable draft states to non-actionable proposal states', () => {
    expect(proposalStatusFromDraftStatus({ draftId: 'draft-1', state: 'pending' })).toBe('pending')
    expect(proposalStatusFromDraftStatus({ draftId: 'draft-1', state: 'pending_review' })).toBe('pending_review')
    expect(proposalStatusFromDraftStatus({ draftId: 'draft-1', state: 'applied' })).toBe('applied')
    expect(proposalStatusFromDraftStatus({ draftId: 'draft-1', state: 'unavailable' })).toBe('unavailable')
  })

  test('collapses a handled proposal into a compact status row', () => {
    const markup = renderToStaticMarkup(
      <WikiProposalSettledSummary title="Agent 建议新建 Lume Wiki 设计" status="applied" />,
    )

    expect(markup).toContain('data-wiki-proposal-collapsed="true"')
    expect(markup).toContain('已写入 Wiki')
    expect(markup).toContain('Agent 建议新建 Lume Wiki 设计')
    expect(markup).not.toContain('确认写入')
    expect(markup).not.toContain('border')
    expect(markup).not.toContain('bg-[')
  })

  test('is registered in ToolResultRenderer', () => {
    const markup = renderToStaticMarkup(
      <ToolResultRenderer toolName="wiki.propose_changes" input={{}} result={draft} />,
    )

    expect(markup).toContain('正在确认草案状态')
  })
})
