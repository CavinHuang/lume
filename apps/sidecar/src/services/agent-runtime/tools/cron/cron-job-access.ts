import type { AutomationJob } from "@lume/shared";
import { isSystemAutomationJob } from "../../../automation/automation-manager";

/**
 * agent 侧自动化工具的统一可达性判定（#647 follow-up1）：
 * 1. system 任务（routine 映射/记忆蒸馏等 sidecar 内部通道）对 agent 工具面
 *    不可见也不可操作——与 RPC 侧同源谓词同口径，堵住会话内模型触碰
 *    无人值守 bypass 通道的守卫缺口；
 * 2. workspace 会话只见本工作区与全局任务。
 * 此前本判定在 automation-list-tools / create-cron-tools 各有一份仅查
 * workspace 的复制，system 守卫两处皆缺。
 */
export function isJobAccessible(job: AutomationJob, workspaceId?: string): boolean {
  if (isSystemAutomationJob(job)) return false;
  if (!workspaceId) return true;
  return !job.workspaceId || job.workspaceId === workspaceId;
}
