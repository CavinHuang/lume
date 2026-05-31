import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

describe('Model settings UI contract', () => {
  test('McpSettings moves the MCP overview into top statistics and removes the right panel', () => {
    const source = readWebFile('src', 'components', 'settings', 'McpSettings.tsx')

    expect(source).toContain('McpOverviewStats')
    expect(source).toContain('grid h-[78px] grid-cols-4')
    expect(source).toContain('已发现服务')
    expect(source).toContain('已连接')
    expect(source).toContain('最近扫描')
    expect(source).not.toContain('grid-cols-[minmax(0,730px)_288px]')
    expect(source).not.toContain('McpOverviewCard')
    expect(source).not.toContain('OverviewRow')
    expect(source).not.toContain('OVERVIEW_IMAGE')
    expect(source).not.toContain('<aside className="h-fit')
    expect(source).not.toContain('MCP 概览')
    expect(source).not.toContain('查看诊断日志')
  })

  test('GeneralSettings does not render the removed right-side system information panel', () => {
    const source = readWebFile('src', 'components', 'settings', 'GeneralSettings.tsx')

    expect(source).toContain('<div className="space-y-3">')
    expect(source).not.toContain('grid-cols-[minmax(0,664px)_318px]')
    expect(source).not.toContain('<aside className=')
    expect(source).not.toContain('系统状态')
    expect(source).not.toContain('客户端版本')
    expect(source).not.toContain('当前模型')
    expect(source).not.toContain('本地存储')
    expect(source).not.toContain('数据位置')
    expect(source).not.toContain('StatusRow')
  })

  test('SettingsView keeps the secondary settings navigation compact', () => {
    const source = readWebFile('src', 'components', 'settings', 'SettingsView.tsx')
    const sidebarLine =
      source.split('\n').find((line) => line.includes('<aside className=')) ?? ''

    expect(source).toContain("import { WorkspacesSettings } from './WorkspacesSettings'")
    expect(source).toContain("{tab === 'workspaces' && <WorkspacesSettings />}")
    expect(source).toContain('pl-0 pr-8 pt-4 pb-0')
    expect(source).toContain('min-h-[calc(100vh-70px)]')
    expect(source).toContain('grid-cols-[174px_minmax(0,1fr)]')
    expect(sidebarLine).toContain('rounded-tr-[12px] border-r border-t border-border bg-white')
    expect(source).toContain('space-y-1.5')
    expect(source).toContain('flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-[13px]')
    expect(source).toContain('<Icon size={16}')
    expect(source).not.toContain('px-8 py-0')
    expect(source).not.toContain('pt-2 pb-0')
    expect(sidebarLine).not.toContain('border-x')
    expect(sidebarLine).not.toContain('border-l')
    expect(sidebarLine).not.toContain('border-[#e7e9f1]')
    expect(source).not.toContain('flex h-12 w-full items-center gap-3')
  })

  test('WorkspacesSettings restores the workspace settings design instead of a placeholder', () => {
    const settingsViewSource = readWebFile('src', 'components', 'settings', 'SettingsView.tsx')
    const source = readWebFile('src', 'components', 'settings', 'WorkspacesSettings.tsx')

    expect(settingsViewSource).toContain("workspaces: '工作区设置'")
    expect(settingsViewSource).toContain('管理多个本地工作区的基本信息、目录和默认行为')
    expect(source).toContain('WorkspaceStats')
    expect(source).toContain('grid grid-cols-4 gap-3')
    expect(source).toContain('工作区数量')
    expect(source).toContain('默认工作区')
    expect(source).toContain('最近打开')
    expect(source).toContain('本地模式')
    expect(source).toContain('grid grid-cols-[minmax(0,438px)_minmax(0,1fr)] gap-4')
    expect(source).toContain('工作区列表')
    expect(source).toContain('搜索工作区')
    expect(source).toContain('本地目录')
    expect(source).toContain('工作区概览')
    expect(source).toContain('工作区偏好')
    expect(source).toContain('危险操作')
    expect(source).toContain('AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH')
    expect(settingsViewSource).not.toContain('工作区管理入口会继续复用左上角工作区选择与创建能力。')
  })

  test('WorkspacesSettings exposes workspace tabs and lightweight file management', () => {
    const source = readWebFile('src', 'components', 'settings', 'WorkspacesSettings.tsx')

    expect(source).toContain('WORKSPACE_SETTINGS_TABS')
    expect(source).toContain("id: 'overview'")
    expect(source).toContain("id: 'files'")
    expect(source).toContain("id: 'capabilities'")
    expect(source).toContain('WorkspaceFilesPanel')
    expect(source).toContain('WorkspaceFileBrowser')
    expect(source).toContain('AGENT_IPC_CHANNELS.LIST_WORKSPACE_ROOT_DIRECTORY')
    expect(source).toContain('AGENT_IPC_CHANNELS.READ_WORKSPACE_ROOT_FILE')
    expect(source).toContain('AGENT_IPC_CHANNELS.OPEN_WORKSPACE_ROOT_FILE')
    expect(source).toContain('AGENT_IPC_CHANNELS.RENAME_WORKSPACE_ROOT_FILE')
    expect(source).toContain('AGENT_IPC_CHANNELS.MOVE_WORKSPACE_ROOT_FILE')
    expect(source).toContain('AGENT_IPC_CHANNELS.DELETE_WORKSPACE_ROOT_FILE')
    expect(source).toContain('AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE_ROOT')
  })

  test('WorkspacesSettings stacks MCP and skill capability sections with search', () => {
    const source = readWebFile('src', 'components', 'settings', 'WorkspacesSettings.tsx')

    expect(source).toContain("const [mcpSearchQuery, setMcpSearchQuery]")
    expect(source).toContain("const [skillSearchQuery, setSkillSearchQuery]")
    expect(source).toContain('filteredMcpServers')
    expect(source).toContain('filteredSkills')
    expect(source).toContain("item.installState === 'installed' || nextDisabledSkills.has(item.slug)")
    expect(source).toContain('搜索 MCP 服务')
    expect(source).toContain('搜索技能')
    expect(source).toContain('<div className="space-y-4">')
    expect(source).not.toContain('<div className="grid grid-cols-2 gap-4">')
  })

  test('AgentSettings follows the model-provider design surface instead of the old overview panel', () => {
    const source = readWebFile('src', 'components', 'settings', 'AgentSettings.tsx')

    expect(source).toContain('ModelProviderStats')
    expect(source).toContain('ProviderConfigurationWorkbench')
    expect(source).toContain('MODEL_PROVIDER_QUICK_FILTERS')
    expect(source).toContain('搜索供应商')
    expect(source).toContain('拉取模型列表')
    expect(source).toContain('grid-cols-[296px_1px_minmax(0,1fr)]')
    expect(source).toContain('grid-cols-[minmax(0,330px)_minmax(0,1fr)]')
    expect(source).toContain('min-h-[365px] grid-cols-[282px_minmax(0,1fr)]')
    expect(source).toContain('h-[78px] grid-cols-4')
    expect(source).toContain('size-12')
    expect(source).not.toContain('OVERVIEW_IMAGE')
    expect(source).not.toContain('连接概览')
  })
})
