/**
 * 任务通知提示音（能力移植自 ZCode）：
 * 单例 Audio + preload 预加载，播放前重置进度避免连续触发叠音；
 * 「任务通知」「通知声音」两级开关持久化在 localStorage。
 */
let audio: HTMLAudioElement | null = null

export const TASK_NOTIFICATION_ENABLED_KEY = 'task-notification-enabled'
export const TASK_NOTIFICATION_SOUND_KEY = 'task-notification-sound'

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === 'true'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // localStorage 不可用时开关不持久化，当次会话仍生效（由调用方另行管理）
  }
}

export function isTaskNotificationEnabled(): boolean {
  return readFlag(TASK_NOTIFICATION_ENABLED_KEY, true)
}

export function setTaskNotificationEnabled(value: boolean): void {
  writeFlag(TASK_NOTIFICATION_ENABLED_KEY, value)
}

export function isTaskNotificationSoundEnabled(): boolean {
  return readFlag(TASK_NOTIFICATION_SOUND_KEY, true)
}

export function setTaskNotificationSoundEnabled(value: boolean): void {
  writeFlag(TASK_NOTIFICATION_SOUND_KEY, value)
}

export async function playTaskNotificationSound(): Promise<void> {
  if (!isTaskNotificationEnabled() || !isTaskNotificationSoundEnabled()) return
  try {
    audio ??= new Audio('/sounds/task-notification-pop.wav')
    audio.preload = 'auto'
    audio.pause()
    audio.currentTime = 0
    await audio.play()
  } catch {
    // 自动播放策略或设备问题导致失败时静默，不影响主流程
  }
}
