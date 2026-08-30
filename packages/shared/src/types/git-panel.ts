/**
 * Git 状态面板（右侧面板只读 Git tab）的 IPC 契约类型。
 *
 * 消费方：apps/desktop/src/browser/git-panel-service.ts（main 进程执行体）与
 * apps/web/src/lib/desktop-api/git-panel.ts（renderer 封装）。通道名经
 * apps/desktop/src/renderer-ipc-contract.ts 的 ALLOWED_RENDERER_INVOKE_COMMANDS
 * 白名单放行。必须保持零依赖纯 TS。
 *
 * 语义对齐 ZCode SidePane Git 面板（docs/analysis/P2-git-codeviewer.md §1）：
 * 完全只读，不提供 stage/unstage/commit。
 */

/** renderer→main invoke 通道名（lume:invoke 漏斗直发，main dispatchCommand 前缀转发）。 */
export const GIT_PANEL_IPC_CHANNELS = {
  status: 'lume:browser-git-status',
  diff: 'lume:browser-git-diff',
} as const

/** 单文件变更所属区：worktree 改动 / 暂存区改动 / 未跟踪文件。 */
export type GitPanelSection = 'unstaged' | 'staged' | 'untracked'

/** 变更类型（git 状态字母归一：M/T→modified，R/C→renamed，U→conflicted）。 */
export type GitPanelChangeKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'conflicted'

/** 单条文件变更（路径为仓库根相对路径；added/removed 为 null 表示行数未知或二进制）。 */
export interface GitPanelChange {
  path: string
  repoRelativePath: string
  kind: GitPanelChangeKind
  section: GitPanelSection
  added: number | null
  removed: number | null
}

/** 工作区 Git 状态概要（getStatus 返回）。 */
export interface GitPanelStatus {
  isGitAvailable: boolean
  isRepository: boolean
  branchName: string | null
  ahead: number
  behind: number
  isDirty: boolean
  changes: GitPanelChange[]
}

/** 单文件 diff 可用性：正常 patch / 二进制 / 输出超限截断。 */
export type GitPanelDiffAvailability = 'patch' | 'binary' | 'truncated'

/** 单文件 diff（getDiff 返回；unified 格式纯文本）。 */
export interface GitPanelDiff {
  availability: GitPanelDiffAvailability
  patch: string
}
