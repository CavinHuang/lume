import * as React from 'react'
import { Loader2, RotateCcw, Save } from 'lucide-react'
import { toast } from 'sonner'
import type {
  Channel,
  LumeConfigSubagentModelStrategy,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { listChannels } from '@/lib/desktop-api/channel'
import {
  getEffectiveLumeConfig,
  updateSubagentModelStrategy,
} from '@/lib/desktop-api/lume-config'
import { ModelOptionList } from '@/components/model-selection/ModelOptionList'
import { buildModelSelectionGroups } from '@/components/model-selection/model-selection-state'
import {
  buildModelOptions,
  getEnabledChannels,
  getModelLabel,
} from './model-option-utils'
import {
  buildSubagentDefaultModelPayload,
  getSubagentDefaultModelDraft,
  hasSubagentDraftChanges,
  type SubagentDefaultModelDraft,
} from './subagent-default-model-state'

export function SubagentDefaultModelPanel() {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<SubagentDefaultModelDraft>({
    hasExplicitDefaultModel: false,
  })
  const [persistedStrategy, setPersistedStrategy] = React.useState<LumeConfigSubagentModelStrategy>({})
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    let cancelled = false

    Promise.all([listChannels(), getEffectiveLumeConfig()])
      .then(([loadedChannels, config]) => {
        if (cancelled) return

        const nextDraft = getSubagentDefaultModelDraft({
          channels: loadedChannels,
          strategy: config.models?.subagent,
        })
        setChannels(loadedChannels)
        setDraft(nextDraft)
        setPersistedStrategy(config.models?.subagent ?? {})
      })
      .catch((error) => {
        console.error('[SubagentDefaultModelPanel] 加载子 Agent 默认模型失败:', error)
        toast.error('加载子 Agent 默认模型失败')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpen])

  const enabledChannels = React.useMemo(() => getEnabledChannels(channels), [channels])
  const allModelOptions = React.useMemo(() => buildModelOptions(enabledChannels), [enabledChannels])
  const activeDefaultModel = React.useMemo(
    () => allModelOptions.find((option) => option.modelRef === draft.defaultModelRef),
    [allModelOptions, draft.defaultModelRef]
  )
  const defaultModelGroups = React.useMemo(
    () => buildModelSelectionGroups({
      channels: enabledChannels,
      activeChannelId: activeDefaultModel?.channelId,
      activeModelRef: draft.defaultModelRef,
    }),
    [activeDefaultModel?.channelId, draft.defaultModelRef, enabledChannels]
  )
  const hasChanges = React.useMemo(
    () => hasSubagentDraftChanges({ persistedStrategy, draft }),
    [persistedStrategy, draft]
  )

  const handleModelSelect = (value: { modelRef: string }) => {
    setMenuOpen(false)
    setDraft((current) => ({
      ...current,
      defaultModelRef: value.modelRef,
      hasExplicitDefaultModel: true,
      unavailableDefaultModelRef: undefined,
    }))
  }

  const handleResetToInherit = () => {
    setDraft({
      hasExplicitDefaultModel: false,
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const config = await updateSubagentModelStrategy(buildSubagentDefaultModelPayload(draft))
      const nextDraft = getSubagentDefaultModelDraft({
        channels,
        strategy: config.models?.subagent,
      })
      setDraft(nextDraft)
      setPersistedStrategy(config.models?.subagent ?? {})
      toast.success('子 Agent 默认模型已保存')
    } catch (error) {
      console.error('[SubagentDefaultModelPanel] 保存子 Agent 默认模型失败:', error)
      toast.error('保存子 Agent 默认模型失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border bg-background/70 p-5">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          加载子 Agent 默认模型...
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-2xl border bg-background/70 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-[14px] font-semibold">子 Agent 默认模型</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            控制 Agent 工具拉起的子 Agent 默认使用哪个模型。未设置时，子 Agent 会继承当前对话模型。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleResetToInherit} disabled={saving}>
            <RotateCcw size={13} />
            继承当前对话
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            保存设置
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-[13px] font-medium">默认模型</Label>
        <div ref={menuRef} className="relative">
          <Button
                variant="ghost"
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            className={cn(
              'flex h-8 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 text-[13px] text-left transition-colors hover:bg-muted/30',
              draft.unavailableDefaultModelRef && 'border-amber-500/50'
            )}
          >
            <span className="truncate">
              {draft.hasExplicitDefaultModel
                ? getModelLabel(allModelOptions, draft.defaultModelRef)
                : '继承当前对话模型'}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {draft.hasExplicitDefaultModel ? (activeDefaultModel?.channelLabel ?? '未设置') : '自动'}
            </span>
          </Button>

          {menuOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-full overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg">
              <div className="border-b border-border/40 p-1">
                <Button
                variant="ghost"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    handleResetToInherit()
                  }}
                  className="flex h-8 w-full items-center justify-between rounded-md px-2.5 text-[13px] text-left transition-colors hover:bg-muted/50"
                >
                  <span>继承当前对话模型</span>
                  {!draft.hasExplicitDefaultModel && (
                    <span className="text-[11px] text-primary">当前</span>
                  )}
                </Button>
              </div>
              <ModelOptionList groups={defaultModelGroups} onSelect={handleModelSelect} />
            </div>
          )}
        </div>

        {draft.unavailableDefaultModelRef && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            已保存的子 Agent 默认模型 `{draft.unavailableDefaultModelRef}` 当前不可用，面板已回退到继承模式。
          </p>
        )}

        <p className="text-[11px] text-muted-foreground">
          显式在 Agent 工具里传入 `model` 时，会覆盖这里的默认值。
        </p>
      </div>

      <div className="rounded-xl bg-muted/30 px-4 py-3 text-[12px] text-muted-foreground">
        当前生效策略：
        {' '}
        <span className="font-medium text-foreground">
          {draft.hasExplicitDefaultModel
            ? getModelLabel(allModelOptions, draft.defaultModelRef)
            : '继承当前对话模型'}
        </span>
      </div>
    </div>
  )
}
