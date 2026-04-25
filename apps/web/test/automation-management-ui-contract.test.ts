import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

describe('Automation management UI contract', () => {
  test('routes the sidebar automation entry to a dedicated main tab', () => {
    const tabAtoms = readWebFile('src', 'atoms', 'tab-atoms.ts')
    const leftSidebar = readWebFile('src', 'components', 'app-shell', 'LeftSidebar.tsx')
    const tabContent = readWebFile('src', 'components', 'tabs', 'TabContent.tsx')
    const viewModel = readWebFile('src', 'components', 'app-shell', 'lume-sidebar-view-model.ts')

    expect(tabAtoms).toContain("export type TabType = 'agent' | 'settings' | 'welcome' | 'automation'")
    expect(leftSidebar).toContain("const automationId = '__automation__'")
    expect(leftSidebar).toContain("{ id: automationId, type: 'automation', title: '自动化' }")
    expect(tabContent).toContain("import { AutomationManagementView } from '@/components/automation/AutomationManagementView'")
    expect(tabContent).toContain("if (activeTab.type === 'automation')")
    expect(viewModel).toContain("activeTabId === '__automation__'")
    expect(viewModel).not.toContain("id: 'automations', label: '自动化', icon: 'clock', kind: 'button', badge: '即将推出', disabled: true")
  })

  test('implements both automation mocks: management surface and create-task modal', () => {
    const source = readWebFile('src', 'components', 'automation', 'AutomationManagementView.tsx')

    expect(source).toContain('AutomationTaskList')
    expect(source).toContain('AutomationTaskDetail')
    expect(source).toContain('AutomationTaskModal')
    expect(source).toContain('Agent 自动化')
    expect(source).toContain('创建可复用的 Agent 任务，按需运行或在对话中调用。')
    expect(source).toContain('PRD 初稿生成')
    expect(source).toContain('运行方式（可多选）')
    expect(source).toContain('手动运行')
    expect(source).toContain('定时')
    expect(source).toContain('Webhook')
    expect(source).toContain('对话中调用')
    expect(source).toContain('Agent 指令')
    expect(source).toContain('工具与资源')
    expect(source).toContain('最近运行')
    expect(source).toContain('创建并运行')
    expect(source).toContain('bg-black/28 backdrop-blur-[2px]')
    expect(source).toContain('max-w-[760px]')
  })
})
