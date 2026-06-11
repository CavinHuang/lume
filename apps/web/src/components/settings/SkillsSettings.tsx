import { useAtomValue } from 'jotai'
import { currentWorkspaceIdAtom } from '@/atoms'
import { SkillSettingsView } from '@/components/skills/SkillSettingsView'

export function SkillsSettings() {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom)

  return (
    <SkillSettingsView
      workspaceSlug={workspaceId ?? null}
      // 不传 cwd，SkillSettingsView 内部会自动过滤掉 project scope
      // 只展示 workspace 和 user 两个 scope
    />
  )
}
