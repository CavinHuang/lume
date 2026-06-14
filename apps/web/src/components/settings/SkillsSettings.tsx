import { useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { SkillSettingsView, type SkillSettingsViewHandle } from '@/components/skills/SkillSettingsView'
import { SkillAddSourceDialog } from '@/components/skills/SkillAddSourceDialog'

export function SkillsSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const skillSettingsViewRef = useRef<SkillSettingsViewHandle>(null)

  const currentWorkspace = useMemo(
    () => workspaces.find((w) => w.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )

  const [selectedSlug, setSelectedSlug] = useState(currentWorkspace?.slug ?? '')
  const [addSourceDialogOpen, setAddSourceDialogOpen] = useState(false)

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.slug === selectedSlug) ?? currentWorkspace,
    [selectedSlug, workspaces, currentWorkspace],
  )

  return (
    <>
      <SkillSettingsView
        ref={skillSettingsViewRef}
        workspaceSlug={selectedWorkspace?.slug ?? null}
        availableWorkspaces={workspaces}
        onWorkspaceChange={setSelectedSlug}
        onOpenMarket={() => {}}
        onAddSource={() => setAddSourceDialogOpen(true)}
        onCreateNew={(scope) => {
          skillSettingsViewRef.current?.createNewSkill(scope)
        }}
        // 不传 cwd，SkillSettingsView 内部会自动过滤掉 project scope
        // 只展示 workspace 和 user 两个 scope
        key={selectedWorkspace?.slug ?? 'default'}
      />
      <SkillAddSourceDialog
        open={addSourceDialogOpen}
        onOpenChange={setAddSourceDialogOpen}
        workspaceSlug={selectedWorkspace?.slug ?? null}
        onCreateNew={() => {
          setAddSourceDialogOpen(false)
          setTimeout(() => {
            skillSettingsViewRef.current?.createNewSkill('workspace')
          }, 50)
        }}
        onOpenMarket={() => setAddSourceDialogOpen(false)}
      />
    </>
  )
}
