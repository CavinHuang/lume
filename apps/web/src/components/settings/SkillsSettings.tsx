import { useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { SkillSettingsView } from '@/components/skills/SkillSettingsView'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FolderTree } from 'lucide-react'

export function SkillsSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)

  const currentWorkspace = useMemo(
    () => workspaces.find((w) => w.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )

  const [selectedSlug, setSelectedSlug] = useState(currentWorkspace?.slug ?? workspaces[0]?.slug ?? '')

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.slug === selectedSlug) ?? currentWorkspace,
    [selectedSlug, workspaces, currentWorkspace],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <FolderTree size={16} className="text-[var(--text-3)]" />
        <Select
          value={selectedSlug}
          onValueChange={setSelectedSlug}
        >
          <SelectTrigger className="h-9 w-[200px] rounded-[8px] text-[13px]">
            <SelectValue placeholder="选择工作区" />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.slug}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <SkillSettingsView
        workspaceSlug={selectedWorkspace?.slug ?? null}
        // 不传 cwd，SkillSettingsView 内部会自动过滤掉 project scope
        // 只展示 workspace 和 user 两个 scope
        key={selectedWorkspace?.slug ?? 'default'}
      />
    </div>
  )
}
