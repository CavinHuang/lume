import { describe, expect, test } from 'bun:test'
import { pickWorktreeBaseBranch, worktreeBaseReviewSource } from './worktree-base-branch'

describe('pickWorktreeBaseBranch', () => {
  test('远端主分支优先于本地主分支（对齐 Proma 默认 origin/main）', () => {
    expect(pickWorktreeBaseBranch(['main', 'origin/main', 'dev'])).toBe('origin/main')
  })

  test('无远端主分支时回退本地主分支，再回退 master 系', () => {
    expect(pickWorktreeBaseBranch(['main', 'dev'])).toBe('main')
    expect(pickWorktreeBaseBranch(['master', 'origin/master'])).toBe('origin/master')
    expect(pickWorktreeBaseBranch(['master'])).toBe('master')
  })

  test('没有主分支类基线时返回 null', () => {
    expect(pickWorktreeBaseBranch(['feature-x', 'dev'])).toBeNull()
    expect(pickWorktreeBaseBranch([])).toBeNull()
  })
})

describe('worktreeBaseReviewSource', () => {
  test('构造 branch 比较 spec（merge-base 对 worktree diff）', () => {
    expect(worktreeBaseReviewSource('origin/main')).toEqual({ kind: 'branch', baseRef: 'origin/main' })
  })
})
