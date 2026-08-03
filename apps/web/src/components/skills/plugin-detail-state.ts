import type {
  PluginMarketItem,
  PluginMarketplaceSetupKind,
  PluginReadmePreview,
  PluginSetupArtifact,
  PluginSetupInstaller,
  PluginSetupDownload,
  PluginSetupBuild,
  PluginSetupTargetApp,
  PluginSetupVerify,
} from '@lume/shared'

export interface PermissionRow {
  label: string
  value: string
}

export interface PluginSetupItem {
  id?: string
  title: string
  description: string
  status: 'done' | 'attention' | 'idle'
  artifact?: PluginSetupArtifact
  artifacts?: PluginSetupArtifact[]
  download?: PluginSetupDownload
  build?: PluginSetupBuild
  installer?: PluginSetupInstaller
  targetApp?: PluginSetupTargetApp
  verify?: PluginSetupVerify
}

export interface PluginUpdateAction {
  label: string
  requiresPermissionReview: boolean
}

export function formatPluginInstallState(state: PluginMarketItem['installState']): string {
  switch (state) {
    case 'installed':
      return '已安装'
    case 'update-available':
      return '有更新'
    case 'not-installed':
      return '未安装'
  }
}

export function formatPluginEnableState(state: PluginMarketItem['enableState']): string {
  switch (state) {
    case 'global-enabled':
      return '全局启用'
    case 'workspace-enabled':
      return '工作区启用'
    case 'disabled':
      return '已禁用'
    case 'needs-review':
      return '需要审核'
    case 'not-installed':
      return '未安装'
  }
}

export function formatRiskLabel(risk: PluginMarketItem['permissions']['riskLabels'][number]): string {
  switch (risk) {
    case 'shell':
      return 'Shell'
    case 'network':
      return '网络'
    case 'write':
      return '写文件'
    case 'mcp':
      return '注册 MCP'
    case 'high-risk-tool':
      return '高风险工具'
  }
}

export function buildPluginUpdateAction(input: {
  updateAvailable: boolean
  permissionChanged: boolean
  version: string
}): PluginUpdateAction {
  if (!input.updateAvailable) {
    return { label: '确认权限并安装', requiresPermissionReview: false }
  }
  if (input.permissionChanged) {
    return { label: '确认权限并更新', requiresPermissionReview: true }
  }
  return { label: `更新到 v${input.version}`, requiresPermissionReview: false }
}

export function buildPermissionRows(item: PluginMarketItem): PermissionRow[] {
  const permissions = item.permissions
  return [
    { label: '读取文件', value: formatPermissionList(permissions.filesystemRead) },
    { label: '写入文件', value: formatPermissionList(permissions.filesystemWrite) },
    { label: '网络访问', value: formatPermissionList(permissions.networkOutbound) },
    { label: '工具允许', value: formatPermissionList(permissions.toolAllow) },
    { label: '工具询问', value: formatPermissionList(permissions.toolAsk) },
    { label: '工具拒绝', value: formatPermissionList(permissions.toolDeny) },
    { label: 'Hook 事件', value: formatPermissionList(permissions.hookEvents) },
    { label: 'Shell', value: permissions.shellAllow ? '允许' : '未声明' },
    { label: 'MCP 注册', value: permissions.mcpRegister ? '允许' : '未声明' },
  ]
}

export function buildPluginSetupItems(item: PluginMarketItem): PluginSetupItem[] {
  const currentVersionInstalled = item.installState === 'installed'
  const updateAvailable = item.installState === 'update-available'
  const enabled = item.enableState === 'global-enabled' || item.enableState === 'workspace-enabled'
  const explicitSetupItems = buildExplicitSetupItems(item, currentVersionInstalled, enabled)
  if (explicitSetupItems.length > 0) return explicitSetupItems
  const needsLocalConnection = item.permissions.networkOutbound.some((entry) =>
    entry.includes('127.0.0.1') || entry.includes('localhost')
  )
  const hasMcp = item.capabilities.mcpServerNames.length > 0 || item.permissions.mcpRegister
  const usesBrowserBridge = item.permissions.toolAllow.some((entry) => entry === 'mcp__node_repl__js')
    || item.name.toLowerCase().includes('chrome')
    || item.pluginId.toLowerCase().includes('chrome')
  const needsLocalBridgePairing = needsLocalConnection && hasMcp
  let installDescription = '安装后才能启用和配置连接。'
  if (currentVersionInstalled) {
    installDescription = `当前版本 ${item.version} 已安装。`
  } else if (updateAvailable) {
    installDescription = `当前已安装，发现可更新版本 ${item.version}。`
  }
  const items: PluginSetupItem[] = [
    {
      title: '确认插件已安装',
      description: installDescription,
      status: currentVersionInstalled ? 'done' : 'attention',
    },
    {
      title: '启用当前工作区',
      description: enabled ? formatPluginEnableState(item.enableState) : '安装后可在当前工作区启用。',
      status: enabled ? 'done' : 'idle',
    },
  ]
  if (needsLocalConnection) {
    items.push({
      title: needsLocalBridgePairing ? '完成本地桥接配对' : '检查本地连接',
      description: needsLocalBridgePairing
        ? '打开外部应用的 Lume 桥接插件，并在授权弹窗中填入验证码或确认配对。'
        : '该插件声明了本地网络访问，安装后需要确认外部应用或本地服务可用。',
      status: 'attention',
    })
  }
  if (usesBrowserBridge) {
    items.push({
      title: '完成浏览器授权',
      description: '安装或更新后在 Lume 授权弹窗中确认浏览器控制请求，再回到对话中试用。',
      status: 'attention',
    })
  }
  if (hasMcp && !needsLocalBridgePairing) {
    items.push({
      title: '检查 MCP 服务',
      description: '该插件包含 MCP 服务，安装或更新后需要等待服务注册完成。',
      status: 'attention',
    })
  }
  return items
}

function buildExplicitSetupItems(
  item: PluginMarketItem,
  currentVersionInstalled: boolean,
  enabled: boolean,
): PluginSetupItem[] {
  const setup = item.marketplace?.setup ?? []
  return setup.map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    status: setupStepStatus(step.kind, currentVersionInstalled, enabled),
    ...(step.artifact ? { artifact: step.artifact } : {}),
    ...(step.artifacts?.length ? { artifacts: step.artifacts } : {}),
    ...(step.download ? { download: step.download } : {}),
    ...(step.build ? { build: step.build } : {}),
    ...(step.installer ? { installer: step.installer } : {}),
    ...(step.targetApp ? { targetApp: step.targetApp } : {}),
    ...(step.verify ? { verify: step.verify } : {}),
  }))
}

function setupStepStatus(
  kind: PluginMarketplaceSetupKind | undefined,
  currentVersionInstalled: boolean,
  enabled: boolean,
): PluginSetupItem['status'] {
  switch (kind) {
    case 'install':
      return currentVersionInstalled ? 'done' : 'attention'
    case 'enable':
      return enabled ? 'done' : 'idle'
    case 'browser-auth':
    case 'pairing-code':
    case 'local-service':
    case 'mcp':
    case 'custom':
    default:
      return 'attention'
  }
}

export function formatReadmeMeta(readme: PluginReadmePreview | undefined): string {
  if (!readme) return '未找到 README.md'
  const base = readme.path ?? 'README.md'
  return readme.truncated ? `${base} · 已截断` : base
}

function formatPermissionList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '未声明'
}
