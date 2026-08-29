import type { CodingReviewSource } from '@lume/shared'

/**
 * worktree 绑定后的「vs 主分支」基线偏好，对齐 Proma getWorktreeChanges 的
 * 默认基线（origin/main 优先于本地主分支）；都不存在时返回 null（隐藏入口）。
 */
const BASE_BRANCH_PREFERENCES = ['origin/main', 'main', 'origin/master', 'master'] as const

export function pickWorktreeBaseBranch(branches: readonly string[]): string | null {
  for (const candidate of BASE_BRANCH_PREFERENCES) {
    if (branches.includes(candidate)) return candidate
  }
  return null
}

export function worktreeBaseReviewSource(baseRef: string): CodingReviewSource {
  return { kind: 'branch', baseRef }
}
