/**
 * 语音输入设置：流式 ASR 凭证、识别语言、热词与结果输出方式。
 */

import { invoke } from '@/lib/desktop-runtime/core'
import * as React from 'react'
import { ExternalLink, Loader2, Mic } from 'lucide-react'
import { toast } from 'sonner'
import type {
  VoiceDictationSettings,
  VoiceDictationSettingsUpdate,
  VoiceDictationTestResult,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '自动检测' },
  { value: 'zh-CN', label: '中文（普通话）' },
  { value: 'yue-CN', label: '粤语' },
  { value: 'en-US', label: '英语（美国）' },
  { value: 'ja-JP', label: '日语' },
  { value: 'ko-KR', label: '韩语' },
]

function SettingsRow({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-3 py-2">
      <div className="pt-1.5">
        <div className="text-[13px] font-medium text-[var(--text-1)]">{label}</div>
        {hint ? <div className="mt-0.5 text-xs leading-5 text-[var(--text-3)]">{hint}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function VoiceDictationSettings() {
  const [settings, setSettings] = React.useState<VoiceDictationSettings | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)

  React.useEffect(() => {
    invoke<VoiceDictationSettings>('voice_dictation_get_settings', null)
      .then(setSettings)
      .catch((error: unknown) => toast.error(`读取语音输入设置失败: ${error instanceof Error ? error.message : '未知错误'}`))
  }, [])

  const applyUpdate = React.useCallback(async (updates: VoiceDictationSettingsUpdate) => {
    setSaving(true)
    try {
      const next = await invoke<VoiceDictationSettings>('voice_dictation_update_settings', updates)
      setSettings(next)
    } catch (error) {
      toast.error(`保存失败: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setSaving(false)
    }
  }, [])

  const handleTest = React.useCallback(async () => {
    setTesting(true)
    try {
      const result = await invoke<VoiceDictationTestResult>('voice_dictation_test_connection', null)
      if (result.success) toast.success(result.message)
      else toast.error(result.message)
    } finally {
      setTesting(false)
    }
  }, [])

  if (!settings) {
    return (
      <div className="flex min-h-[160px] items-center justify-center text-[var(--text-3)]">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载中…
      </div>
    )
  }

  return (
    <div className="max-w-[720px] space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)] px-4 py-3">
        <Mic size={16} className="mt-0.5 shrink-0 text-[var(--text-3)]" />
        <p className="text-[13px] leading-6 text-[var(--text-2)]">
          在输入框点击麦克风按钮即可语音输入，转写文本实时显示并追加到光标处。
          语音识别由云端流式服务完成，音频将在录音期间上传至所配置的服务商。
        </p>
      </div>

      <div className="lume-panel divide-y divide-[var(--lume-border-subtle)] px-4 py-1">
        <SettingsRow label="APP ID">
          <Input
            value={settings.appId}
            onChange={(event) => setSettings({ ...settings, appId: event.target.value })}
            onBlur={() => void applyUpdate({ appId: settings.appId })}
            placeholder="服务商控制台的 APP ID"
          />
        </SettingsRow>
        <SettingsRow label="Access Token" hint="仅保存在本机 settings.json">
          <Input
            type="password"
            value={settings.accessToken}
            onChange={(event) => setSettings({ ...settings, accessToken: event.target.value })}
            onBlur={() => void applyUpdate({ accessToken: settings.accessToken })}
            placeholder="访问凭证"
          />
        </SettingsRow>
        <SettingsRow label="Resource ID">
          <Input
            value={settings.resourceId}
            onChange={(event) => setSettings({ ...settings, resourceId: event.target.value })}
            onBlur={() => void applyUpdate({ resourceId: settings.resourceId })}
            placeholder="例如 volcengine_input_common"
          />
        </SettingsRow>
        <SettingsRow label="识别语言">
          <select
            value={settings.language}
            onChange={(event) => void applyUpdate({ language: event.target.value })}
            className="h-9 w-full rounded-lg border border-[var(--lume-border-subtle)] bg-transparent px-2 text-[13px] text-[var(--text-1)]"
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow label="自定义热词" hint="按行或逗号分隔，最多 100 个；提升专有名词识别率">
          <textarea
            value={settings.customHotwords}
            onChange={(event) => setSettings({ ...settings, customHotwords: event.target.value })}
            onBlur={() => void applyUpdate({ customHotwords: settings.customHotwords })}
            rows={3}
            placeholder={'产品名\n人名\n术语'}
            className="w-full resize-y rounded-lg border border-[var(--lume-border-subtle)] bg-transparent px-2 py-1.5 text-[13px] leading-6 text-[var(--text-1)]"
          />
        </SettingsRow>
        <SettingsRow label="结果输出" hint="听写结束后文字的去向">
          <div className="flex gap-2 pt-1">
            <Button
              variant={settings.outputMode === 'lume-input' ? 'secondary' : 'ghost'}
              type="button"
              className="h-8 px-3 text-[13px]"
              onClick={() => void applyUpdate({ outputMode: 'lume-input' })}
            >
              追加到输入框
            </Button>
            <Button
              variant={settings.outputMode === 'clipboard' ? 'secondary' : 'ghost'}
              type="button"
              className="h-8 px-3 text-[13px]"
              onClick={() => void applyUpdate({ outputMode: 'clipboard' })}
            >
              复制到剪贴板
            </Button>
          </div>
        </SettingsRow>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="outline" type="button" disabled={testing || saving} onClick={() => void handleTest()}>
          {testing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          测试连接
        </Button>
        {saving ? <span className="text-xs text-[var(--text-3)]">正在保存…</span> : null}
        <Button
          variant="ghost"
          type="button"
          className="h-8 px-2 text-xs text-[var(--text-3)]"
          onClick={() => void invoke('open_external', { url: 'https://console.volcengine.com/speech/service/' })}
        >
          前往控制台获取凭证
          <ExternalLink size={12} className="ml-1" />
        </Button>
        <span className="text-xs text-[var(--text-3)]">文本框失焦后自动保存；修改在下次听写会话生效</span>
      </div>
    </div>
  )
}
