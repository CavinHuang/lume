import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { AgentMessageDisplayMode } from '@lume/shared'
import { updateGeneralSettings } from '@/lib/desktop-api'
import { generalSettingsAtom } from '@/atoms'
import { cn } from '@/lib/utils'
import { mergeGeneralSettings } from './general-settings-state'

import { Button } from '@/components/ui/button'
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
    <section className="lume-panel-padded">
      <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">Agent 消息显示</h2>
      <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">显示方式</div>
          <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
            控制 agent 回合中工具调用 / 思考 / 子代理的展示密度
          </div>
        </div>
        <div className="lume-segmented grid w-[220px] grid-cols-2">
          {DISPLAY_MODE_OPTIONS.map((option) => (
            <Button
                variant="ghost"
              key={option.value}
              type="button"
              onClick={() => void handleChange(option.value)}
              disabled={saving}
              title={option.desc}
              className={cn(
                'lume-segmented-item disabled:opacity-60',
                settings.agentMessageDisplayMode === option.value
                  ? 'lume-segmented-item-active'
                  : '',
              )}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    </section>
  )
}
