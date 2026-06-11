import { useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { SkillSettingsView } from '@/components/skills/SkillSettingsView'

export function SkillsSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)

  const currentWorkspace = useMemo(
    () => workspaces.find((w) => w.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )

  const [selectedSlug, setSelectedSlug] = useState(currentWorkspace?.slug ?? '')

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.slug === selectedSlug) ?? currentWorkspace,
    [selectedSlug, workspaces, currentWorkspace],
  )

  return (
    <SkillSettingsView
      workspaceSlug={selectedWorkspace?.slug ?? null}
      availableWorkspaces={workspaces}
      onWorkspaceChange={setSelectedSlug}
      // 不传 cwd，SkillSettingsView 内部会自动过滤掉 project scope
      // 只展示 workspace 和 user 两个 scope
      key={selectedWorkspace?.slug ?? 'default'}
    />
  )
}
