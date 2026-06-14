import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { pendingSkillImprovementSuggestionsAtom } from '@/atoms'
import { TOOL_METADATA } from '@/components/settings/tool-metadata'
import {
  analyzeSkillImprovement,
  applySkillImprovement,
  deleteWorkspaceSkill,
  getEditableSkill,
  getSkillMarketCatalog,
  listSkillVersions,
  listEditableSkills,
  restoreSkillVersion,
  saveWorkspaceSkill,
} from '@/lib/desktop-api'
import {
  getEffectiveLumeConfig,
  updatePermissionsSection,
  updateSkillsConfig,
} from '@/lib/desktop-api/lume-config'
import { cn } from '@/lib/utils'
import type {
  AgentWorkspace,
  EditableSkillMeta,
  LumeEffectiveConfig,
  SkillImprovementAnalysisResult,
  SkillImprovementUpdate,
  SkillStorageScope,
  SkillVersionInfo,
} from '@lume/shared'
import {
  buildSkillDraftFromMeta,
  buildAllowedToolOptionRows,
  createEmptySkillDraft,
  extractSkillPrompt,
  filterSkillSettingsItems,
  getSkillDraftValidationError,
  isSelfOwnedSkill,
  normalizeAllowedToolDraft,
  toggleAllowedToolDraft,
  type SkillSettingsDraft,
  SKILL_STORAGE_SCOPE_LABELS,
  SKILL_STORAGE_SCOPE_EMPTY_LABELS,
} from './skill-settings-state'
import type { SkillSystemToolGroupId } from './skill-tool-definitions'
import {
  buildSystemToolPermissionsSection,
  buildSystemToolRows,
  isToolInGroup,
  type SystemToolGroup,
  type SystemToolRow,
} from './system-tools-state'
import {
  skillImprovementSuggestionKey,
  type PendingSkillImprovementSuggestion,
} from '@/hooks/skill-listeners-state'

export interface SkillSettingsViewHandle {
  createNewSkill: (storageScope: SkillStorageScope) => void
}

export const SkillSettingsView = forwardRef<SkillSettingsViewHandle, {
  workspaceSlug: string | null
  cwd?: string | null
  onOpenMarket: () => void
  availableWorkspaces?: AgentWorkspace[]
  onWorkspaceChange?: (slug: string) => void
  onAddSource?: () => void
  onCreateNew?: (storageScope: SkillStorageScope) => void
}>(function SkillSettingsView({
  workspaceSlug,
  cwd,
  onOpenMarket,
  availableWorkspaces,
  onWorkspaceChange,
  onAddSource,
  onCreateNew,
}, ref) {
  const [skills, setSkills] = useState<EditableSkillMeta[]>([])
  const [activeStorageScope, setActiveStorageScope] = useState<SkillStorageScope>(
    () => (cwd?.trim() ? 'project' : 'workspace'),
  )
  const [scopeTouched, setScopeTouched] = useState(false)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<SkillSettingsDraft | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [loadingEditorSlug, setLoadingEditorSlug] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)
  const [toolConfig, setToolConfig] = useState<LumeEffectiveConfig | null>(null)
  const [toolLoading, setToolLoading] = useState(true)
  const [toolError, setToolError] = useState<string | null>(null)
  const [savingToolId, setSavingToolId] = useState<string | null>(null)
  const [builtInSkills, setBuiltInSkills] = useState<EditableSkillMeta[]>([])
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set())
  const [busySkillSlug, setBusySkillSlug] = useState<string | null>(null)
  const pendingSkillImprovementSuggestions = useAtomValue(pendingSkillImprovementSuggestionsAtom)
  const setPendingSkillImprovementSuggestions = useSetAtom(pendingSkillImprovementSuggestionsAtom)

  useImperativeHandle(ref, () => ({
    createNewSkill: (scope: SkillStorageScope) => {
      setEditorError(null)
      setDraft(createEmptySkillDraft(scope))
    },
  }))

  const projectCwd = cwd?.trim() || undefined
  const storageScopes = useMemo(
    () => [
      { value: 'workspace' as SkillStorageScope, label: SKILL_STORAGE_SCOPE_LABELS.workspace, emptyLabel: SKILL_STORAGE_SCOPE_EMPTY_LABELS.workspace },
      { value: 'user' as SkillStorageScope, label: SKILL_STORAGE_SCOPE_LABELS.user, emptyLabel: SKILL_STORAGE_SCOPE_EMPTY_LABELS.user },
      ...(projectCwd ? [{ value: 'project' as SkillStorageScope, label: SKILL_STORAGE_SCOPE_LABELS.project, emptyLabel: SKILL_STORAGE_SCOPE_EMPTY_LABELS.project }] : []),
    ],
    [projectCwd],
  )

  useEffect(() => {
    if (projectCwd && !scopeTouched && activeStorageScope === 'workspace') {
      setActiveStorageScope('project')
      return
    }
    if (!projectCwd && activeStorageScope === 'project') {
      setActiveStorageScope('workspace')
    }
  }, [activeStorageScope, projectCwd, scopeTouched])

  const loadSkills = useCallback(async () => {
    if (!workspaceSlug) {
      setSkills([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      setSkills(await listEditableSkills(workspaceSlug, projectCwd))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSkills([])
    } finally {
      setLoading(false)
    }
  }, [projectCwd, workspaceSlug])

  const loadSystemTools = useCallback(async () => {
    setToolLoading(true)
    setToolError(null)
    try {
      setToolConfig(await getEffectiveLumeConfig(workspaceSlug ?? undefined))
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err))
      setToolConfig(null)
    } finally {
      setToolLoading(false)
    }
  }, [workspaceSlug])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    void loadSystemTools()
  }, [loadSystemTools])

  const loadBuiltInSkills = useCallback(async () => {
    if (!workspaceSlug) {
      setBuiltInSkills([])
      return
    }
    try {
      const catalog = await getSkillMarketCatalog(workspaceSlug)
      const builtIn = catalog.items
        .filter((item) => item.sourceType === 'built-in')
        .map((item) => ({
          slug: item.slug,
          name: item.name,
          description: item.description ?? '',
          whenToUse: '',
          storageScope: 'workspace' as SkillStorageScope,
          managementSurface: 'market' as const,
          sourceType: 'built-in' as const,
          allowedTools: [],
          argumentHint: '',
          disableModelInvocation: false,
          version: item.version ?? '',
          icon: item.icon,
          installState: item.installState,
        }))
      setBuiltInSkills(builtIn)
    } catch {
      setBuiltInSkills([])
    }
  }, [workspaceSlug])

  useEffect(() => {
    void loadBuiltInSkills()
  }, [loadBuiltInSkills])

  const loadDisabledSkills = useCallback(async () => {
    if (!workspaceSlug) {
      setDisabledSkills(new Set())
      return
    }
    try {
      const config = await getEffectiveLumeConfig(workspaceSlug)
      setDisabledSkills(new Set(config.skills?.disabled ?? []))
    } catch {
      setDisabledSkills(new Set())
    }
  }, [workspaceSlug])

  useEffect(() => {
    void loadDisabledSkills()
  }, [loadDisabledSkills])

  const handleToggleSkill = async (skillSlug: string, enabled: boolean) => {
    if (!workspaceSlug) return
    setBusySkillSlug(skillSlug)
    try {
      const next = new Set(disabledSkills)
      if (enabled) {
        next.delete(skillSlug)
      } else {
        next.add(skillSlug)
      }
      await updateSkillsConfig({ disabled: Array.from(next).sort() }, workspaceSlug)
      setDisabledSkills(next)
    } catch (err) {
      console.error('[SkillSettingsView] 切换技能启用状态失败:', err)
    } finally {
      setBusySkillSlug(null)
    }
  }

  const visibleSkills = useMemo(
    () => filterSkillSettingsItems(
      skills.filter((skill) => skill.storageScope === activeStorageScope && isSelfOwnedSkill(skill)),
      query,
    ),
    [activeStorageScope, query, skills],
  )
  const systemToolRows = useMemo(
    () => buildSystemToolRows(toolConfig?.permissions?.toolPolicy?.deny),
    [toolConfig?.permissions?.toolPolicy?.deny],
  )
  const disabledSystemGroupIds = useMemo(
    () => systemToolRows
      .filter((row) => !row.enabled)
      .map((row) => row.id),
    [systemToolRows],
  )
  const activeScopeMeta = storageScopes.find((scope) => scope.value === activeStorageScope) ?? storageScopes[0]!
  const activePendingSuggestion = useMemo(() => {
    if (!workspaceSlug || !draft || draft.mode !== 'edit') return null
    const key = skillImprovementSuggestionKey({
      workspaceSlug,
      storageScope: draft.storageScope,
      skillSlug: draft.skillSlug,
      cwd: draft.storageScope === 'project' ? projectCwd : undefined,
    })
    return pendingSkillImprovementSuggestions.find((suggestion) => suggestion.key === key) ?? null
  }, [draft, pendingSkillImprovementSuggestions, projectCwd, workspaceSlug])

  const handleCreate = () => {
    setEditorError(null)
    if (onAddSource) {
      onAddSource()
    } else if (onCreateNew) {
      onCreateNew(activeStorageScope)
    } else {
      setDraft(createEmptySkillDraft(activeStorageScope))
    }
  }

  const handleEdit = async (skill: EditableSkillMeta) => {
    if (!workspaceSlug) return
    setLoadingEditorSlug(skillSettingsKey(skill))
    setEditorError(null)
    try {
      const detail = await getEditableSkill({
        workspaceSlug,
        skillSlug: skill.slug,
        storageScope: skill.storageScope,
        ...(skill.storageScope === 'project' && projectCwd ? { cwd: projectCwd } : {}),
      })
      setDraft(buildSkillDraftFromMeta(detail.skill, extractSkillPrompt(detail.content)))
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingEditorSlug(null)
    }
  }

  const handleDelete = async (skill: EditableSkillMeta) => {
    if (!workspaceSlug) return
    const confirmed = window.confirm(`删除技能「${skill.name}」？`)
    if (!confirmed) return

    setDeletingSlug(skillSettingsKey(skill))
    setError(null)
    try {
      await deleteWorkspaceSkill(
        workspaceSlug,
        skill.slug,
        skill.storageScope,
        skill.storageScope === 'project' ? projectCwd : undefined,
      )
      await loadSkills()
      if (draft?.skillSlug === skill.slug && draft.storageScope === skill.storageScope) {
        setDraft(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingSlug(null)
    }
  }

  const handleSave = async () => {
    if (!workspaceSlug || !draft) return
    const skillSlug = draft.skillSlug.trim()
    const name = draft.name.trim()
    const validationError = getSkillDraftValidationError(draft)
    if (validationError) {
      setEditorError(validationError)
      return
    }

    setSaving(true)
    setEditorError(null)
    try {
      await saveWorkspaceSkill({
        workspaceSlug,
        skillSlug,
        storageScope: draft.storageScope,
        ...(draft.storageScope === 'project' && projectCwd ? { cwd: projectCwd } : {}),
        name,
        description: draft.description,
        whenToUse: draft.whenToUse,
        allowedTools: normalizeAllowedToolDraft(draft.allowedToolsText),
        argumentHint: draft.argumentHint,
        disableModelInvocation: draft.disableModelInvocation,
        version: draft.version,
        prompt: draft.prompt,
      })
      await loadSkills()
      setDraft(null)
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleToggleSystemTool = async (group: SystemToolGroup, enabled: boolean) => {
    if (group.locked || !toolConfig) return
    setSavingToolId(group.id)
    setToolError(null)
    try {
      const nextPermissions = buildSystemToolPermissionsSection(
        toolConfig.permissions ?? {},
        group,
        enabled,
      )
      setToolConfig(await updatePermissionsSection(nextPermissions, workspaceSlug ?? undefined))
    } catch (err) {
      setToolError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingToolId(null)
    }
  }

  const reloadActiveDraft = useCallback(async () => {
    if (!workspaceSlug || !draft || draft.mode !== 'edit') return
    const detail = await getEditableSkill({
      workspaceSlug,
      skillSlug: draft.skillSlug,
      storageScope: draft.storageScope,
      ...(draft.storageScope === 'project' && projectCwd ? { cwd: projectCwd } : {}),
    })
    setDraft(buildSkillDraftFromMeta(detail.skill, extractSkillPrompt(detail.content)))
    await loadSkills()
  }, [draft, loadSkills, projectCwd, workspaceSlug])

  const consumeActivePendingSuggestion = useCallback(() => {
    if (!activePendingSuggestion) return
    setPendingSkillImprovementSuggestions((current) => (
      current.filter((suggestion) => suggestion.key !== activePendingSuggestion.key)
    ))
  }, [activePendingSuggestion, setPendingSkillImprovementSuggestions])

  const systemToolsPanel = (
    <SystemToolsPanel
      rows={systemToolRows}
      loading={toolLoading}
      error={toolError}
      savingToolId={savingToolId}
      onToggle={(group, enabled) => void handleToggleSystemTool(group, enabled)}
    />
  )

  if (draft) {
    return (
      <section className="min-h-0 overflow-y-auto pr-2">
        <SkillEditor
          workspaceSlug={workspaceSlug}
          draft={draft}
          saving={saving}
          error={editorError}
          disabledSystemGroupIds={disabledSystemGroupIds}
          storageScopes={storageScopes}
          projectCwd={projectCwd}
          pendingSuggestion={activePendingSuggestion}
          onDraftChange={setDraft}
          onSkillContentChanged={() => reloadActiveDraft()}
          onPendingSuggestionConsumed={consumeActivePendingSuggestion}
          onCancel={() => {
            setDraft(null)
            setEditorError(null)
          }}
          onSave={() => void handleSave()}
        />
        {systemToolsPanel}
      </section>
    )
  }

  return (
    <section className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-[8px] border border-[#e4e7f1] bg-[#f7f8fb] p-1">
          {storageScopes.map((scope) => (
              <button
                key={scope.value}
                type="button"
                onClick={() => {
                  setScopeTouched(true)
                  setActiveStorageScope(scope.value)
                }}
                className={cn(
                  'h-8 rounded-[6px] px-3 text-[13px] font-semibold transition-colors',
                  activeStorageScope === scope.value
                    ? 'bg-white text-[#20232d] shadow-[0_8px_18px_-16px_rgba(43,52,103,0.54)]'
                    : 'text-[#687196] hover:text-[#20232d]',
                )}
              >
                {scope.label}
              </button>
            ))}
        </div>
        <label className="flex h-10 min-w-[280px] flex-1 items-center gap-3 rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[#687196] shadow-[0_8px_20px_-18px_rgba(48,58,110,0.32)]">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能名称、描述或触发条件..."
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#1d2440] outline-none placeholder:text-[#8b94b4]"
          />
        </label>
        <button
          type="button"
          onClick={handleCreate}
          className="flex h-10 shrink-0 items-center gap-2 rounded-[8px] bg-[#2f2f31] px-4 text-[13px] font-semibold text-white shadow-[0_14px_28px_-22px_rgba(20,24,40,0.62)] hover:bg-[#1f2023]"
        >
          <Plus size={17} />
          添加技能
        </button>
      </div>

      {loading ? (
        <div className="mt-6 flex h-[180px] items-center justify-center gap-2 rounded-[8px] border border-[#e4e7f1] text-[13px] text-[#626b8f]">
          <Loader2 size={16} className="animate-spin" />
          正在读取技能...
        </div>
      ) : error ? (
        <div className="mt-6 rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-4 text-[13px] text-[#ba3636]">
          {error}
        </div>
      ) : (
        <div className="mt-5 min-h-0 overflow-y-auto pr-2">
          {activeStorageScope === 'workspace' && availableWorkspaces && availableWorkspaces.length > 0 && onWorkspaceChange && (
            <div className="mb-4 flex items-center gap-2">
              <span className="text-[12px] font-medium text-[#687196]">当前工作区</span>
              <Select
                value={workspaceSlug ?? ''}
                onValueChange={(val) => onWorkspaceChange?.(val)}
              >
                <SelectTrigger className="h-8 flex-1 max-w-[280px] border border-[#e4e7f1] bg-white px-3 text-[13px] font-medium text-[#20232d] shadow-none hover:border-[#cfd5e8]">
                  {availableWorkspaces.find((w) => w.slug === workspaceSlug)?.name ?? '选择工作区'}
                </SelectTrigger>
                <SelectContent>
                  {availableWorkspaces.map((w) => (
                    <SelectItem key={w.id} value={w.slug}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="mb-3 text-[13px] font-medium text-[#687196]">{activeScopeMeta.label}技能</div>
          <div className="grid gap-3">
            {visibleSkills.map((skill) => (
              <SkillSettingsRow
                key={skillSettingsKey(skill)}
                skill={skill}
                editing={loadingEditorSlug === skillSettingsKey(skill)}
                deleting={deletingSlug === skillSettingsKey(skill)}
                disabled={disabledSkills.has(skill.slug)}
                busy={busySkillSlug === skill.slug}
                onEdit={() => void handleEdit(skill)}
                onDelete={() => void handleDelete(skill)}
                onToggle={(checked) => void handleToggleSkill(skill.slug, checked)}
              />
            ))}
          </div>
          {builtInSkills.length > 0 && (
            <>
              <div className="mt-5 mb-3 text-[13px] font-medium text-[#687196]">系统内置技能</div>
              <div className="grid gap-3">
                {builtInSkills.map((skill) => (
                  <article
                    key={skill.slug}
                    className="grid min-h-[72px] grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-[8px] border border-[#edf0f6] bg-[#f5f4ff] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <h2 className="truncate text-[15px] font-semibold text-[#20232d]" title={skill.name}>{skill.name}</h2>
                        <span className="font-mono text-[12px] text-[#4f566d]">/{skill.slug}</span>
                        <span className="inline-flex items-center rounded-full bg-[#eae6ff] px-2 py-0.5 text-[11px] font-medium text-[#635bff]">
                          系统内置 · 全局可用
                        </span>
                        {skill.version && <span className="text-[12px] text-[#8a91a8]">v{skill.version}</span>}
                      </div>
                      {skill.description && (
                        <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-[#687196]">{skill.description}</p>
                      )}
                    </div>
                    <div className="flex items-center">
                      <Switch
                        size="sm"
                        checked={!disabledSkills.has(skill.slug)}
                        disabled={busySkillSlug === skill.slug}
                        onCheckedChange={(checked) => void handleToggleSkill(skill.slug, checked)}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          {visibleSkills.length === 0 && builtInSkills.length === 0 && (
            <div className="rounded-[8px] border border-dashed border-[#d8ddec] p-8 text-center text-[13px] leading-6 text-[#687196]">
              {activeScopeMeta.emptyLabel}
              {activeStorageScope === 'workspace' && (
                <button
                  type="button"
                  onClick={onOpenMarket}
                  className="ml-2 font-semibold text-[#4f46e5] hover:text-[#3730a3]"
                >
                  去技能市场发现技能
                </button>
              )}
            </div>
          )}
          {systemToolsPanel}
        </div>
      )}
    </section>
  )
})


const SkillSettingsRow = ({
  skill,
  editing,
  deleting,
  disabled,
  busy,
  onEdit,
  onDelete,
  onToggle,
}: {
  skill: EditableSkillMeta
  editing: boolean
  deleting: boolean
  disabled: boolean
  busy: boolean
  onEdit: () => void
  onDelete: () => void
  onToggle: (checked: boolean) => void
}) => {
  return (
    <article className="grid min-h-[108px] grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-[8px] border border-[#edf0f6] bg-[#fbfbfa] px-4 py-3">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="truncate text-[15px] font-semibold text-[#20232d]" title={skill.name}>{skill.name}</h2>
          <span className="font-mono text-[12px] text-[#4f566d]">/{skill.slug}</span>
          <span className="text-[12px] text-[#8a91a8]">{formatSkillStorageScopeLabel(skill.storageScope)}</span>
          {skill.version && <span className="text-[12px] text-[#8a91a8]">v{skill.version}</span>}
        </div>
        {skill.description && (
          <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-[#687196]">{skill.description}</p>
        )}
        {skill.whenToUse && (
          <p className="mt-1 line-clamp-1 text-[13px] italic leading-5 text-[#20232d]">{skill.whenToUse}</p>
        )}
        {skill.allowedTools && skill.allowedTools.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {skill.allowedTools.slice(0, 8).map((tool) => (
              <span key={tool} className="font-mono text-[12px] text-[#20232d]">{tool}</span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Switch
          size="sm"
          checked={!disabled}
          disabled={busy}
          onCheckedChange={onToggle}
        />
        <div className="flex items-start gap-1">
          <button
            type="button"
            title="编辑技能"
            disabled={editing}
            onClick={onEdit}
            className="flex size-8 items-center justify-center rounded-[6px] text-[#656d83] hover:bg-white hover:text-[#20232d] disabled:cursor-wait disabled:opacity-60"
          >
            {editing ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={16} />}
          </button>
          <button
            type="button"
            title="删除技能"
            disabled={deleting}
            onClick={onDelete}
            className="flex size-8 items-center justify-center rounded-[6px] text-[#656d83] hover:bg-white hover:text-[#ba3636] disabled:cursor-wait disabled:opacity-60"
          >
            {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
          </button>
        </div>
      </div>
    </article>
  )
}

const SkillEditor = ({
  workspaceSlug,
  draft,
  saving,
  error,
  disabledSystemGroupIds,
  storageScopes,
  projectCwd,
  pendingSuggestion,
  onDraftChange,
  onSkillContentChanged,
  onPendingSuggestionConsumed,
  onCancel,
  onSave,
}: {
  workspaceSlug: string | null
  draft: SkillSettingsDraft
  saving: boolean
  error: string | null
  disabledSystemGroupIds: SkillSystemToolGroupId[]
  storageScopes: Array<{ value: SkillStorageScope; label: string; emptyLabel: string }>
  projectCwd?: string
  pendingSuggestion: PendingSkillImprovementSuggestion | null
  onDraftChange: (draft: SkillSettingsDraft) => void
  onSkillContentChanged: () => Promise<void>
  onPendingSuggestionConsumed: () => void
  onCancel: () => void
  onSave: () => void
}) => {
  const allowedTools = normalizeAllowedToolDraft(draft.allowedToolsText)
  const canSave = !getSkillDraftValidationError(draft) && !saving
  const canChangeScope = draft.mode === 'create'

  const updateDraft = (patch: Partial<SkillSettingsDraft>) => {
    onDraftChange({ ...draft, ...patch })
  }
  const allowedToolRows = buildAllowedToolOptionRows(draft.allowedToolsText, disabledSystemGroupIds)

  return (
    <section className="min-h-0">
      <button
        type="button"
        onClick={onCancel}
        className="mb-5 flex h-8 items-center gap-2 rounded-[6px] text-[13px] font-semibold text-[#60698d] hover:text-[#20232d]"
      >
        <ArrowLeft size={17} />
        返回
      </button>

      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 className="text-[20px] font-semibold text-[#121832]">
          {draft.mode === 'create' ? '添加技能' : `编辑「${draft.name || draft.skillSlug}」`}
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-[8px] px-4 text-[14px] font-semibold text-[#60698d] hover:bg-[#f5f6fa]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={onSave}
            className="flex h-10 items-center gap-2 rounded-[8px] bg-[#2f2f31] px-5 text-[14px] font-semibold text-white shadow-[0_14px_28px_-22px_rgba(20,24,40,0.62)] hover:bg-[#1f2023] disabled:cursor-not-allowed disabled:opacity-55"
          >
            {saving ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />}
            保存技能
          </button>
        </div>
      </div>

      <div className="grid max-w-[980px] gap-5">
        <div>
          <div className="mb-2 text-[13px] font-semibold text-[#6b7286]">存储位置</div>
          <div className="flex flex-wrap gap-3">
            {storageScopes.map((scope) => (
              <button
                key={scope.value}
                type="button"
                disabled={!canChangeScope && draft.storageScope !== scope.value}
                onClick={() => {
                  if (canChangeScope) updateDraft({ storageScope: scope.value })
                }}
                className={cn(
                  'h-11 rounded-[8px] border px-5 text-[14px] font-semibold transition-colors',
                  draft.storageScope === scope.value
                    ? 'border-[#2f2f31] text-[#2f2f31]'
                    : 'border-[#e4e7f1] text-[#9aa2b8]',
                  canChangeScope && draft.storageScope !== scope.value && 'hover:border-[#cfd5e8] hover:text-[#60698d]',
                  !canChangeScope && 'disabled:cursor-not-allowed disabled:opacity-55',
                )}
              >
                {scope.label}
              </button>
            ))}
          </div>
        </div>

        <SkillEditorField label="技能 ID">
          <input
            value={draft.skillSlug}
            disabled={draft.mode === 'edit'}
            onChange={(event) => updateDraft({ skillSlug: event.target.value })}
            placeholder="code-review"
            className="h-12 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-4 font-mono text-[14px] text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff] disabled:bg-[#fafafa] disabled:text-[#8a91a8]"
          />
        </SkillEditorField>

        <SkillEditorField label="展示名称">
          <input
            value={draft.name}
            onChange={(event) => updateDraft({ name: event.target.value })}
            placeholder="Skill 生成器"
            className="h-12 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[14px] text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff]"
          />
        </SkillEditorField>

        <SkillEditorField label="描述">
          <input
            value={draft.description}
            onChange={(event) => updateDraft({ description: event.target.value })}
            placeholder="帮助用户创建、优化或评测 Skill"
            className="h-12 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[14px] text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff]"
          />
        </SkillEditorField>

        <SkillEditorField label="触发条件">
          <input
            value={draft.whenToUse}
            onChange={(event) => updateDraft({ whenToUse: event.target.value })}
            placeholder="当用户说「帮我创建一个 skill」时"
            className="h-12 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[14px] text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff]"
          />
        </SkillEditorField>

        <SkillEditorField label="允许使用的工具">
          <div className="flex flex-wrap gap-2">
            {allowedToolRows.map((tool) => (
              <button
                key={tool.value}
                type="button"
                disabled={tool.disabled}
                title={tool.disabledReason}
                aria-pressed={tool.selected}
                onClick={() => {
                  if (!tool.disabled) {
                    updateDraft({ allowedToolsText: toggleAllowedToolDraft(draft.allowedToolsText, tool.value) })
                  }
                }}
                className={cn(
                  'h-9 rounded-[8px] border px-3 font-mono text-[13px] transition-colors',
                  tool.selected
                    ? 'border-[#2f2f31] bg-white text-[#20232d]'
                    : 'border-[#dfe3f0] bg-white text-[#60698d] hover:border-[#bcc4d8] hover:text-[#20232d]',
                  tool.disabled && 'cursor-not-allowed border-[#edf0f6] bg-[#fafafa] text-[#a7adbd] hover:border-[#edf0f6] hover:text-[#a7adbd]',
                )}
              >
                {tool.label}
              </button>
            ))}
          </div>
          <input
            value={draft.allowedToolsText}
            onChange={(event) => updateDraft({ allowedToolsText: event.target.value })}
            placeholder="custom_tool, mcp__server__tool"
            className="mt-3 h-11 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-4 font-mono text-[13px] text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff]"
          />
          {allowedTools.length > 0 && (
            <div className="mt-2 text-[12px] font-medium text-[#687196]">
              当前: <span className="font-mono text-[#20232d]">{allowedTools.join(', ')}</span>
            </div>
          )}
        </SkillEditorField>

        <div className="grid gap-5 md:grid-cols-2">
          <SkillEditorField label="版本">
            <input
              value={draft.version}
              onChange={(event) => updateDraft({ version: event.target.value })}
              placeholder="1.0.0"
              className="h-12 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[14px] text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff]"
            />
          </SkillEditorField>
          <SkillEditorField label="参数提示">
            <input
              value={draft.argumentHint}
              onChange={(event) => updateDraft({ argumentHint: event.target.value })}
              placeholder="请告诉我文件路径"
              className="h-12 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[14px] text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff]"
            />
          </SkillEditorField>
        </div>

        <div className="flex min-h-[68px] items-center justify-between gap-4 border-y border-[#edf0f6] py-4">
          <div>
            <div className="text-[14px] font-semibold text-[#20232d]">禁止模型自动调用</div>
            <div className="mt-1 text-[13px] text-[#687196]">开启后仅允许手动触发</div>
          </div>
          <button
            type="button"
            aria-pressed={draft.disableModelInvocation}
            onClick={() => updateDraft({ disableModelInvocation: !draft.disableModelInvocation })}
            className={cn(
              'relative h-8 w-14 rounded-full transition-colors',
              draft.disableModelInvocation ? 'bg-[#2f2f31]' : 'bg-[#e6e8ee]',
            )}
          >
            <span
              className={cn(
                'absolute top-1 size-6 rounded-full bg-white shadow transition-transform',
                draft.disableModelInvocation ? 'translate-x-7' : 'translate-x-1',
              )}
            />
          </button>
        </div>

        <SkillEditorField label="提示词内容">
          <textarea
            value={draft.prompt}
            onChange={(event) => updateDraft({ prompt: event.target.value })}
            spellCheck={false}
            className="min-h-[320px] w-full resize-y rounded-[8px] border border-[#e4e7f1] bg-white px-4 py-3 font-mono text-[14px] leading-6 text-[#20232d] outline-none placeholder:text-[#9aa2b8] focus:border-[#bdb6ff]"
            placeholder="这里是 SKILL.md 的正文，支持 ${ARG} 占位符。"
          />
        </SkillEditorField>

        {workspaceSlug && draft.mode === 'edit' && (
          <SkillEvolutionPanel
            workspaceSlug={workspaceSlug}
            cwd={draft.storageScope === 'project' ? projectCwd : undefined}
            draft={draft}
            pendingSuggestion={pendingSuggestion}
            onSkillContentChanged={onSkillContentChanged}
            onPendingSuggestionConsumed={onPendingSuggestionConsumed}
          />
        )}

        {error && (
          <div className="rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-3 text-[13px] leading-5 text-[#ba3636]">
            {error}
          </div>
        )}
      </div>
    </section>
  )
};

const SkillEditorField = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-semibold text-[#6b7286]">{label}</span>
      {children}
    </label>
  )
}

const SkillEvolutionPanel = ({
  workspaceSlug,
  cwd,
  draft,
  pendingSuggestion,
  onSkillContentChanged,
  onPendingSuggestionConsumed,
}: {
  workspaceSlug: string
  cwd?: string
  draft: SkillSettingsDraft
  pendingSuggestion: PendingSkillImprovementSuggestion | null
  onSkillContentChanged: () => Promise<void>
  onPendingSuggestionConsumed: () => void
}) => {
  const [versions, setVersions] = useState<SkillVersionInfo[]>([])
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [analysis, setAnalysis] = useState<SkillImprovementAnalysisResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [restoringFilename, setRestoringFilename] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const skillInput = useMemo(() => ({
    workspaceSlug,
    skillSlug: draft.skillSlug,
    storageScope: draft.storageScope,
    ...(draft.storageScope === 'project' && cwd ? { cwd } : {}),
  }), [cwd, draft.skillSlug, draft.storageScope, workspaceSlug])

  const loadVersions = useCallback(async () => {
    setVersionsLoading(true)
    setError(null)
    try {
      setVersions(await listSkillVersions(skillInput))
    } catch (err) {
      setVersions([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setVersionsLoading(false)
    }
  }, [skillInput])

  useEffect(() => {
    void loadVersions()
  }, [loadVersions])

  useEffect(() => {
    if (!pendingSuggestion) return
    setAnalysis(pendingSuggestion)
    setNotice('已载入来自最近会话的改进建议。')
  }, [pendingSuggestion])

  const handleAnalyze = async () => {
    setAnalyzing(true)
    setError(null)
    setNotice(null)
    try {
      const result = await analyzeSkillImprovement(skillInput)
      setAnalysis(result)
      setNotice(result.updates.length === 0 ? '最近使用记录没有发现需要自动改进的地方。' : null)
    } catch (err) {
      setAnalysis(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAnalyzing(false)
    }
  }

  const handleApply = async (updates: SkillImprovementUpdate[]) => {
    if (updates.length === 0) return
    setApplying(true)
    setError(null)
    setNotice(null)
    try {
      const result = await applySkillImprovement({
        ...skillInput,
        updates,
      })
      if (!result.success) {
        setError(result.error ?? '应用改进失败')
        return
      }
      setAnalysis(null)
      await onSkillContentChanged()
      await loadVersions()
      onPendingSuggestionConsumed()
      setNotice(result.warning ?? '已应用改进，并备份旧版本。')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  const handleRestore = async (filename: string) => {
    setRestoringFilename(filename)
    setError(null)
    setNotice(null)
    try {
      const result = await restoreSkillVersion({
        ...skillInput,
        filename,
      })
      if (!result.success) {
        setError(result.error ?? '恢复版本失败')
        return
      }
      setAnalysis(null)
      await onSkillContentChanged()
      await loadVersions()
      setNotice('已恢复选中的历史版本，并备份恢复前内容。')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoringFilename(null)
    }
  }

  const updates = analysis?.updates ?? []

  return (
    <section className="rounded-[8px] border border-[#edf0f6] bg-[#fbfbfa] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-[#20232d]">
            <Sparkles size={16} />
            技能进化
          </div>
          <p className="mt-1 text-[13px] leading-5 text-[#687196]">
            基于使用记录分析自有技能，并在应用或恢复前自动备份旧版本。
          </p>
        </div>
        <button
          type="button"
          title="分析技能改进"
          disabled={analyzing || applying}
          onClick={() => void handleAnalyze()}
          className="flex h-9 items-center gap-2 rounded-[8px] border border-[#dfe3f0] bg-white px-3 text-[13px] font-semibold text-[#20232d] hover:border-[#bcc4d8] disabled:cursor-wait disabled:opacity-60"
        >
          {analyzing ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          分析改进
        </button>
      </div>

      {analysis && (
        <div className="mt-4 rounded-[8px] border border-[#e4e7f1] bg-white p-3">
          <div className="mb-2 text-[12px] font-semibold text-[#687196]">
            使用记录 {analysis.usageCount} 条，分析会话 {analysis.analyzedSessionIds.length} 个
          </div>
          {updates.length > 0 ? (
            <>
              <div className="grid gap-2">
                {updates.map((update, index) => (
                  <div key={`${update.section}-${index}`} className="rounded-[6px] bg-[#f7f8fb] p-3 text-[13px] leading-5">
                    <div className="font-semibold text-[#20232d]">{update.section}</div>
                    <div className="mt-1 text-[#20232d]">{update.change}</div>
                    <div className="mt-1 text-[#687196]">{update.reason}</div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={applying}
                onClick={() => void handleApply(updates)}
                className="mt-3 flex h-9 items-center gap-2 rounded-[8px] bg-[#2f2f31] px-3 text-[13px] font-semibold text-white hover:bg-[#1f2023] disabled:cursor-wait disabled:opacity-60"
              >
                {applying ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                应用改进
              </button>
            </>
          ) : (
            <div className="text-[13px] leading-5 text-[#687196]">暂无改进建议。</div>
          )}
        </div>
      )}

      <div className="mt-5">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[#20232d]">
          <History size={15} />
          版本历史
        </div>
        {versionsLoading ? (
          <div className="flex h-16 items-center justify-center gap-2 rounded-[8px] border border-[#edf0f6] bg-white text-[13px] text-[#687196]">
            <Loader2 size={15} className="animate-spin" />
            正在读取版本...
          </div>
        ) : versions.length > 0 ? (
          <div className="grid gap-2">
            {versions.map((version) => (
              <div
                key={version.filename}
                className="grid min-h-[44px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[8px] bg-white px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-[12px] text-[#20232d]" title={version.filename}>
                    {version.filename}
                  </div>
                  <div className="mt-1 text-[12px] text-[#687196]">{version.timestamp}</div>
                </div>
                <button
                  type="button"
                  title={`恢复版本 ${version.filename}`}
                  disabled={restoringFilename === version.filename}
                  onClick={() => void handleRestore(version.filename)}
                  className="flex size-8 items-center justify-center rounded-[6px] text-[#656d83] hover:bg-[#f5f6fa] hover:text-[#20232d] disabled:cursor-wait disabled:opacity-60"
                >
                  {restoringFilename === version.filename
                    ? <Loader2 size={15} className="animate-spin" />
                    : <RotateCcw size={15} />}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[8px] border border-dashed border-[#d8ddec] bg-white p-4 text-center text-[13px] text-[#687196]">
            还没有历史版本。
          </div>
        )}
      </div>

      {notice && (
        <div className="mt-3 rounded-[8px] border border-[#dcebd8] bg-[#f7fbf5] p-3 text-[13px] leading-5 text-[#4c7a41]">
          {notice}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-3 text-[13px] leading-5 text-[#ba3636]">
          {error}
        </div>
      )}
    </section>
  );
};

const SystemToolsPanel = ({
  rows,
  loading,
  error,
  savingToolId,
  onToggle,
}: {
  rows: SystemToolRow[]
  loading: boolean
  error: string | null
  savingToolId: string | null
  onToggle: (group: SystemToolGroup, enabled: boolean) => void
}) => {
  const [query, setQuery] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const toolsByGroup = useMemo(() => {
    const map = new Map<string, Array<{ name: string; label: string; description: string }>>()
    for (const row of rows) {
      map.set(row.id, [])
    }
    for (const meta of Object.values(TOOL_METADATA)) {
      for (const row of rows) {
        if (isToolInGroup(meta.name, row.id)) {
          map.get(row.id)?.push({ name: meta.name, label: meta.label, description: meta.description })
          break
        }
      }
    }
    return map
  }, [rows])

  const visibleRows = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return rows
    return rows.filter((row) => {
      const tools = toolsByGroup.get(row.id) ?? []
      const haystack = `${row.label} ${row.description} ${tools.map((t) => `${t.label} ${t.name} ${t.description}`).join(' ')}`.toLowerCase()
      return haystack.includes(keyword)
    })
  }, [query, rows, toolsByGroup])

  const toggleExpand = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  return (
    <section className="mt-10 border-t border-[#edf0f6] pt-8">
      <div className="mb-5">
        <h2 className="text-[18px] font-semibold text-[#20232d]">系统工具</h2>
        <p className="mt-2 text-[13px] leading-5 text-[#687196]">
          管理 Lume 可使用的内置工具。锁定工具为核心能力，不允许关闭。
        </p>
      </div>

      <label className="mb-5 flex h-10 items-center gap-3 rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[#687196] shadow-[0_8px_20px_-18px_rgba(48,58,110,0.32)]">
        <Search size={18} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索工具名称或描述..."
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#1d2440] outline-none placeholder:text-[#8b94b4]"
        />
      </label>

      {loading ? (
        <div className="flex h-[128px] items-center justify-center gap-2 rounded-[8px] border border-[#edf0f6] text-[13px] text-[#626b8f]">
          <Loader2 size={16} className="animate-spin" />
          正在读取系统工具...
        </div>
      ) : error ? (
        <div className="rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-4 text-[13px] text-[#ba3636]">
          {error}
        </div>
      ) : (
        <div className="grid gap-2">
          {visibleRows.map((row) => {
            const isExpanded = expandedGroups.has(row.id)
            const tools = toolsByGroup.get(row.id) ?? []
            const isSaving = savingToolId === row.id
            return (
              <div
                key={row.id}
                className={cn(
                  'rounded-[8px] border transition-colors',
                  row.enabled ? 'border-[#edf0f6] bg-[#fbfbfa]' : 'border-[#f0d0d0] bg-[#fef8f8]',
                )}
              >
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(row.id)}
                    className="flex size-6 items-center justify-center rounded-[4px] text-[#687196] hover:bg-[#edf0f6]"
                  >
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14px] font-semibold text-[#20232d]">{row.label}</h3>
                      <span className="text-[12px] text-[#687196]">{tools.length} 个工具</span>
                      {row.locked && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#f0f0f0] px-2 py-0.5 text-[11px] font-medium text-[#6b7280]">
                          <ShieldCheck size={11} />
                          锁定
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] text-[#8a91a8]">{row.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isSaving && <Loader2 size={14} className="animate-spin text-[#687196]" />}
                    {!row.locked && (
                      <Switch
                        checked={row.enabled}
                        onCheckedChange={() => onToggle(row, !row.enabled)}
                        disabled={isSaving}
                      />
                    )}
                  </div>
                </div>
                {isExpanded && tools.length > 0 && (
                  <div className="border-t border-[#edf0f6]">
                    {tools.map((tool) => (
                      <div
                        key={tool.name}
                        className="grid min-h-[44px] grid-cols-[24px_minmax(0,1fr)] items-center gap-3 px-4 py-2"
                      >
                        <div className="size-3 shrink-0" />
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-[13px] font-medium text-[#20232d]">{tool.label}</span>
                            <span className="font-mono text-[11px] text-[#8a91a8]">{tool.name}</span>
                          </div>
                          <p className="mt-0.5 text-[12px] text-[#8a91a8]">{tool.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {visibleRows.length === 0 && (
            <div className="rounded-[8px] border border-dashed border-[#d8ddec] p-6 text-center text-[13px] leading-6 text-[#687196]">
              没有匹配的系统工具。
            </div>
          )}
        </div>
      )}

      <p className="mt-5 text-[12px] leading-5 text-[#687196]">
        禁用工具后，模型将无法在对话中调用该工具组。MCP 工具请在「MCP」设置中管理。
      </p>
    </section>
  )
}


function formatSkillStorageScopeLabel(scope: SkillStorageScope): string {
  return SKILL_STORAGE_SCOPE_LABELS[scope] ?? scope
}

function skillSettingsKey(skill: EditableSkillMeta): string {
  return `${skill.storageScope}:${skill.slug}`
}


