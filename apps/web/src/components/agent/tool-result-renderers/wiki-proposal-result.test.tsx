import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolResultRenderer } from './index'
import { parseWikiChangeDraft, proposalStatusFromDraftStatus, WikiProposalResult, WikiProposalSettledSummary } from './wiki-proposal-result'

const draft = {
  schemaVersion: 1,
  draftId: 'draft-1',
  revision: 1,
  expiresAt: '2026-07-19T00:00:00.000Z',
  risk: 'low',
  reasons: [],
  title: 'Agent 建议新建 Lume Wiki 设计',
  operationSummaries: [{ kind: 'create', pageId: 'page-1', beforeHash: null, targetRelativePath: 'workspaces/lume/page.md' }],
  boundedDiffPreviews: [{ pageId: 'page-1', path: 'workspaces/lume/page.md', preview: '新建页面' }],
  diffHash: 'diff-hash-1',
}

describe('WikiProposalResult', () => {
  test('parses both direct and SDK-wrapped Wiki drafts', () => {
    expect(parseWikiChangeDraft(draft)?.draftId).toBe('draft-1')
    expect(parseWikiChangeDraft({ data: draft })?.diffHash).toBe('diff-hash-1')
    expect(parseWikiChangeDraft('invalid')).toBeNull()
  })

  test('renders a confirmation card that checks durable status before offering actions', () => {
    const markup = renderToStaticMarkup(<WikiProposalResult result={draft} />)

    expect(markup).toContain('Agent 建议新建 Lume Wiki 设计')
    expect(markup).toContain('尚未写入正式 Wiki')
    expect(markup).toContain('正在确认草案状态')
    expect(markup).not.toContain('nonce')
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
