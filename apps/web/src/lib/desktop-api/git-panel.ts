/**
 * Git 状态面板 IPC 封装 —— `lume:browser-git-*` 通道的 renderer 侧最小类型化包装。
 *
 * 走应用既有通用通道(desktop-runtime 的 invoke 漏斗,经 sandbox preload 的
 * `lume:invoke` 白名单);不新增 preload 面。通道名与类型单源在
 * `@lume/shared`(types/git-panel.ts),main 侧执行体为
 * apps/desktop/src/browser/git-panel-service.ts。
 */
import { invoke } from '@/lib/desktop-runtime/core'
import { GIT_PANEL_IPC_CHANNELS, type GitPanelDiff, type GitPanelSection, type GitPanelStatus } from '@lume/shared'

/** 工作区 Git 状态概要(含三类变更列表)。git 不可用/非仓库时返回降级标志,不抛错。 */
export async function fetchGitPanelStatus(workspacePath: string): Promise<GitPanelStatus> {
  return invoke<GitPanelStatus>(GIT_PANEL_IPC_CHANNELS.status, { workspacePath })
}

/** 单文件 diff(unified patch;懒加载,renderer 自行按 revision 缓存失效)。 */
export async function fetchGitPanelDiff(workspacePath: string, path: string, section: GitPanelSection): Promise<GitPanelDiff> {
  return invoke<GitPanelDiff>(GIT_PANEL_IPC_CHANNELS.diff, { workspacePath, path, section })
}
