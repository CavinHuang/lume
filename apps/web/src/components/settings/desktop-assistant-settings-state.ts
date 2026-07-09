import type { DesktopAssistantSettings, DesktopAssistantStatus } from '@lume/shared'

export type DesktopAssistantDiagnosticTone = 'ok' | 'warning' | 'error'

export function buildDesktopAssistantDiagnostics({
  settings,
  status,
}: {
  settings: DesktopAssistantSettings
  status: DesktopAssistantStatus
}): {
  tone: DesktopAssistantDiagnosticTone
  title: string
  details: string[]
} {
  if (status.host.status === 'permission_denied' && status.host.permissionTarget) {
    const appName = permissionTargetName(status.host.permissionTarget)
    const missingPermissions = (status.host.permissions ?? [])
      .filter((permission) => permission.status === 'missing')
      .map((permission) => permission.title?.trim() || permission.id?.trim())
      .filter((permission): permission is string => Boolean(permission))
    return {
      tone: 'error',
      title: `需要授权 ${appName}`,
      details: [
        `授权对象：${appName}（不是 Lume 主应用）。`,
        missingPermissions.length > 0
          ? `缺少权限：${missingPermissions.join('、')}。`
          : '请在 macOS 系统设置中补齐 Accessibility 和 Screen Recording 权限。',
      ],
    }
  }
  if (status.host.status !== 'ok') {
    return {
      tone: 'error',
      title: '桌面 Host 不可用',
      details: [status.host.message?.trim() || 'Lume 无法连接桌面 Host，Computer Use 和当前应用读取会暂不可用。'],
    }
  }
  if (!status.store.unlocked) {
    return {
      tone: 'warning',
      title: '本地加密存储未解锁',
      details: ['重启后需要 Electron 主进程完成安全密钥初始化，之后才能保留桌面快照。'],
    }
  }
  if (!settings.enabled) {
    return {
      tone: 'warning',
      title: '后台桌面收集已关闭',
      details: ['Alt+L 和输入框加号仍可做用户主动的一次性当前应用绑定；后台活动、搜索和主动建议不会运行。'],
    }
  }
  if (settings.allowedApps.length === 0) {
    return {
      tone: 'warning',
      title: '应用白名单为空',
      details: ['请添加进程名，例如 WeChat.exe 或 chrome.exe。空白名单不会进行后台采集。'],
    }
  }
  return {
    tone: 'ok',
    title: '桌面助手运行正常',
    details: ['Host 已连接，本地加密存储可用。'],
  }
}

function permissionTargetName(target: NonNullable<DesktopAssistantStatus['host']['permissionTarget']>): string {
  return target.appBundleName?.trim() || target.appName?.trim() || 'Lume Computer Use.app'
}
