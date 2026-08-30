import { atomWithStorage } from 'jotai/utils'

/** 任务通知总开关（任务完成/出错/待确认时提示） */
export const taskNotificationEnabledAtom = atomWithStorage('task-notification-enabled', true)
/** 任务通知提示音（总开关关闭时提示音不播放） */
export const taskNotificationSoundEnabledAtom = atomWithStorage('task-notification-sound', true)
