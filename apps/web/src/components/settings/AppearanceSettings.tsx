import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { AgentMessageDisplayMode } from '@lume/shared'
import { updateGeneralSettings } from '@/lib/desktop-api'
import { generalSettingsAtom } from '@/atoms'
import { cn } from '@/lib/utils'
import { mergeGeneralSettings } from './general-settings-state'

const DISPLAY_MODE_OPTIONS: Array<{ value: AgentMessageDisplayMode; label: string; desc: string }> = [
  { value: 'minimal', label: '极简', desc: '只显示文字结论，过程收进可展开的一行' },
  { value: 'verbose', label: '明细', desc: '每个工具/思考/子代理独立折叠展示' },
]

export function AppearanceSettings() {
  const [settings, setSettings] = useAtom(generalSettingsAtom)
  const [saving, setSaving] = React.useState(false)

  const handleChange = async (mode: AgentMessageDisplayMode) => {
    if (mode === settings.agentMessageDisplayMode || saving) return
    const optimistic = mergeGeneralSettings(settings, { agentMessageDisplayMode: mode })
    setSettings(optimistic)
    setSaving(true)
    try {
      const saved = await updateGeneralSettings({ agentMessageDisplayMode: mode })
      setSettings(saved)
      toast.success('外观设置已保存')
    } catch (error) {
      console.error('[AppearanceSettings] 保存失败:', error)
      setSettings(settings)
      toast.error('保存外观设置失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">Agent 消息显示</h2>
      <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">显示方式</div>
          <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
            控制 agent 回合中工具调用 / 思考 / 子代理的展示密度
          </div>
        </div>
        <div className="grid h-9 w-[220px] grid-cols-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
          {DISPLAY_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void handleChange(option.value)}
              disabled={saving}
              title={option.desc}
              className={cn(
                'inline-flex items-center justify-center rounded-[6px] text-[13px] font-medium transition-colors disabled:opacity-60',
                settings.agentMessageDisplayMode === option.value
                  ? 'border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
