import { describe, expect, test } from 'bun:test'
import { buildDiffFileTree, buildGitApplyCommand, codingPublishActionDisabledReason, isReviewFileTooLarge, REVIEW_DIFF_CONTEXT_OPTIONS } from './CodingReviewPanel'

describe('CodingReviewPanel diff file tree', () => {
  test('compacts single-child folder chains and keeps files sorted', () => {
    expect(buildDiffFileTree([
      'apps/web/src/B.ts',
      'apps/web/src/A.ts',
    ])).toEqual([
      {
        type: 'folder',
        name: 'apps/web/src',
        path: 'apps/web/src',
        children: [
          { type: 'file', name: 'A.ts', path: 'apps/web/src/A.ts' },
          { type: 'file', name: 'B.ts', path: 'apps/web/src/B.ts' },
        ],
      },
    ])
  })

  test('builds a copyable git apply command from canonical patches', () => {
    const command = buildGitApplyCommand([
      'diff --git a/a.ts b/a.ts\r\n--- a/a.ts\r\n+++ b/a.ts\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n',
      'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-before\n+after\n',
    ])
    expect(command).toStartWith('(cd "$(git rev-parse --show-toplevel)" && git apply --3way')
    expect(command).toContain('diff --git a/a.ts b/a.ts\n')
    expect(command).toContain('diff --git a/b.ts b/b.ts\n')
    expect(command).toEndWith('\nEOF\n)')
  })

  test('keeps full file content available while collapsing unchanged regions by default', () => {
    expect(REVIEW_DIFF_CONTEXT_OPTIONS).toEqual({
      expandUnchanged: false,
      collapsedContextThreshold: 1,
      expansionLineCount: 20,
    })
  })

  test('uses the Codex per-file changed-line limit before rendering Pierre', () => {
    const base = {
      kind: 'text' as const,
      path: 'large.ts',
      status: 'modified' as const,
      oldContent: '',
      newContent: '',
      patch: '--- a/large.ts\n+++ b/large.ts\n@@ -0,0 +1 @@\n+value\n',
      diffHash: 'hash',
      removedLines: 0,
      actions: {
        isGit: true,
        staged: false,
        unstaged: true,
        canStage: true,
        canUnstage: false,
      },
    }
    expect(isReviewFileTooLarge({ ...base, addedLines: 15_000 })).toBe(false)
    expect(isReviewFileTooLarge({ ...base, addedLines: 15_001 })).toBe(true)
  })

  test('exposes Codex-style commit and push disabled reasons', () => {
    const state = {
      available: true as const,
      rootId: 'root',
      rootLabel: 'lume',
      branch: 'main',
      head: 'a'.repeat(40),
      indexHash: 'b'.repeat(64),
      worktreeHash: 'c'.repeat(64),
      stagedCount: 0,
      unstagedCount: 1,
      untrackedCount: 0,
      ahead: 0,
      behind: 0,
      canCommit: false,
      canPush: true,
    }
    expect(codingPublishActionDisabledReason(state, 'commit', {
      commitMessage: 'test: commit',
      includeUnstagedChanges: false,
    })).toContain('包含未暂存')
    expect(codingPublishActionDisabledReason(state, 'commit', {
      commitMessage: 'test: commit',
      includeUnstagedChanges: true,
    })).toBeUndefined()
    expect(codingPublishActionDisabledReason(state, 'push', {
      commitMessage: '',
      includeUnstagedChanges: false,
    })).toBe('没有待推送的本地提交')
  })

  test('工作区指纹缺失（patch 超 16MB）时拦截包含未暂存变更并给出根因', () => {
    const state = {
      available: true as const,
      rootId: 'root',
      rootLabel: 'lume',
      branch: 'main',
      head: 'a'.repeat(40),
      indexHash: 'b'.repeat(64),
      worktreeHash: undefined,
      stagedCount: 1,
      unstagedCount: 3,
      untrackedCount: 0,
      ahead: 0,
      behind: 0,
      canCommit: true,
      canPush: true,
    }
    expect(codingPublishActionDisabledReason(state, 'commit', {
      commitMessage: 'test: commit',
      includeUnstagedChanges: false,
    })).toBeUndefined()
    expect(codingPublishActionDisabledReason(state, 'commit', {
      commitMessage: 'test: commit',
      includeUnstagedChanges: true,
    })).toContain('16MB')
  })
})
