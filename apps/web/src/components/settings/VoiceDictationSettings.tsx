/**
 * 语音输入设置：流式 ASR 凭证、识别语言、热词与结果输出方式。
 */

import { invoke } from '@/lib/desktop-runtime/core'
import { relaunch } from '@/lib/desktop-runtime/process'
import * as React from 'react'
import { ExternalLink, Loader2, Mic } from 'lucide-react'
import { toast } from 'sonner'
import type {
  VoiceDictationSettings,
  VoiceDictationSettingsUpdate,
  VoiceDictationSettingsUpdateResult,
  VoiceDictationTestResult,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** KeyboardEvent → Electron accelerator；无有效组合时返回 null。 */
export function keyboardEventToAccelerator(event: React.KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('CommandOrControl')
  if (event.metaKey) parts.push('Super')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const key = event.key
  let mainKey: string | null = null
  if (/^F([1-9]|1[0-2])$/u.test(key)) mainKey = key
  else if (key === ' ') mainKey = 'Space'
  else if (/^[a-z0-9]$/iu.test(key)) mainKey = key.toUpperCase()
  else if (/^[`\-=[\];'",.]$/u.test(key)) mainKey = key === '`' ? '`' : key
  else if (key.startsWith('Arrow') || ['PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete'].includes(key)) mainKey = key

  if (!mainKey) return null
  // 纯 Shift+字符会劫持普通打字，要求至少含一个非 Shift 修饰键。
  const hasRealModifier = event.ctrlKey || event.metaKey || event.altKey
  if (!hasRealModifier) return null
  return [...parts, mainKey].join('+')
}

function ShortcutCaptureRow({ value, onApply }: {
  value: string
  onApply: (accelerator: string) => Promise<VoiceDictationSettingsUpdateResult | null>
}) {
  const [recording, setRecording] = React.useState(false)
  const [applying, setApplying] = React.useState(false)
  const [hint, setHint] = React.useState<string | null>(null)

  const handleKeyDown = async (event: React.KeyboardEvent) => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      setHint(null)
      return
    }
    const accelerator = keyboardEventToAccelerator(event)
    if (!accelerator) {
      // 无效按键不再静默吞掉——明确告知支持范围，避免用户以为录制坏了。
      setHint('不支持该按键，请使用字母/数字/F1-F12/方向键等搭配 Ctrl 或 Alt')
      return
    }
    setRecording(false)
    setHint(null)
    setApplying(true)
    try {
      const result = await onApply(accelerator)
      if (result && !result.shortcutRegistered) {
        toast.error(`快捷键 ${accelerator} 注册失败，可能被其他程序占用，已保持原快捷键`)
      }
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="min-w-0">
      <Button
        type="button"
        variant="ghost"
        onClick={() => { setHint(null); setRecording(true) }}
        onKeyDown={(event) => void handleKeyDown(event)}
        onBlur={() => { setRecording(false); setHint(null) }}
        aria-label={`全局快捷键，当前为 ${formatAcceleratorForDisplay(value)}，点击后按下新的组合键`}
        className={cn(
          'h-9 min-w-[140px] justify-start rounded-lg border px-3 text-left font-mono text-body',
          recording
            ? 'border-[color:color-mix(in_oklab,var(--brand)_46%,var(--lume-border-strong))] text-[var(--brand)]'
            : 'border-[var(--lume-border-subtle)] text-[var(--text-1)]',
        )}
      >
        {recording ? '按下新的组合键…' : applying ? '应用中…' : formatAcceleratorForDisplay(value)}
      </Button>
      {hint ? <div className="mt-1 text-caption text-[var(--lume-warning)]">{hint}</div> : null}
    </div>
  )
}

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '自动检测' },
  { value: 'zh-CN', label: '中文（普通话）' },
  { value: 'yue-CN', label: '粤语' },
  { value: 'en-US', label: '英语（美国）' },
  { value: 'ja-JP', label: '日语' },
  { value: 'ko-KR', label: '韩语' },
]

function ShortcutRow({ settings, onApply }: {
  settings: VoiceDictationSettings
  onApply: (accelerator: string) => Promise<VoiceDictationSettingsUpdateResult | null>
}) {
  return (
    <SettingsRow label="全局快捷键" hint="在任意应用中唤起语音听写；需包含 Ctrl/Alt 等修饰键">
      <ShortcutCaptureRow value={settings.shortcut} onApply={onApply} />
    </SettingsRow>
  )
}

/** accelerator → 人类可读展示（mac 用 ⌘/⌥ 符号，win 用 Ctrl/Alt）。 */
export function formatAcceleratorForDisplay(accelerator: string): string {
  const isMac = typeof document !== 'undefined' && document.documentElement.classList.contains('darwin')
  return accelerator
    .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Super/g, isMac ? '⌘' : 'Win')
    .replace(/Alt/g, isMac ? '⌥' : 'Alt')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
}

function SettingsRow({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-3 py-2">
      <div className="pt-1.5">
        <div className="text-body font-medium text-[var(--text-1)]">{label}</div>
        {hint ? <div className="mt-0.5 text-ui leading-5 text-[var(--text-3)]">{hint}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function VoiceDictationSettings() {
  const [settings, setSettings] = React.useState<VoiceDictationSettings | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  // macOS 系统级麦克风权限四态；Windows/Linux 为 unsupported，卡片整体隐藏。
  const [micPermission, setMicPermission] = React.useState<'granted' | 'denied' | 'not-determined' | null>(null)
  /** 本进程曾被拒绝后系统侧又改为允许：界面显示已授权但需重启才能生效。 */
  const [restartRequired, setRestartRequired] = React.useState(false)
  const [requestingMic, setRequestingMic] = React.useState(false)
  // blur 前面板被卸载（键盘切 tab/关窗）不会触发 onBlur——已输入内容经此兜底落盘。
  const pendingUpdateRef = React.useRef<VoiceDictationSettingsUpdate | null>(null)

  const refreshMicPermission = React.useCallback(() => {
    return invoke<{ status: string; restartRequired?: boolean }>('voice_dictation_check_microphone', null)
      .then((permission) => {
        setMicPermission(permission.status === 'unsupported' ? null : permission.status as 'granted' | 'denied' | 'not-determined')
        setRestartRequired(permission.restartRequired === true)
      })
      .catch(() => undefined)
  }, [])

  React.useEffect(() => {
    invoke<VoiceDictationSettings>('voice_dictation_get_settings', null)
      .then(setSettings)
      .catch((error: unknown) => toast.error(`读取语音输入设置失败: ${error instanceof Error ? error.message : '未知错误'}`))
    void refreshMicPermission()
    // 用户可能切到系统设置改权限，回焦时自动刷新状态。
    window.addEventListener('focus', refreshMicPermission)
    return () => {
      window.removeEventListener('focus', refreshMicPermission)
      if (pendingUpdateRef.current) {
        invoke('voice_dictation_update_settings', pendingUpdateRef.current).catch(() => {})
        pendingUpdateRef.current = null
      }
    }
  }, [refreshMicPermission])

  const handleRequestMicPermission = React.useCallback(async () => {
    setRequestingMic(true)
    try {
      const result = await invoke<{ status: string }>('voice_dictation_request_microphone', null)
      if (result.status === 'granted') toast.success('麦克风权限已授权')
      else if (result.status === 'denied') toast.error('麦克风权限请求被拒绝，可在系统设置中重新开启')
    } catch (error) {
      toast.error(`请求麦克风权限失败: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setRequestingMic(false)
      void refreshMicPermission()
    }
  }, [refreshMicPermission])

  const credentialsComplete = Boolean(settings && settings.appId && settings.accessToken && settings.resourceId)

  /** 本地编辑立即上屏并登记未保存变更；onBlur 时与显式保存共用 flush。 */
  const editLocally = React.useCallback((updates: VoiceDictationSettingsUpdate) => {
    pendingUpdateRef.current = { ...pendingUpdateRef.current, ...updates }
    setSettings((current) => (current ? { ...current, ...updates } : current))
  }, [])

  const applyUpdate = React.useCallback(async (updates?: VoiceDictationSettingsUpdate) => {
    const payload = { ...pendingUpdateRef.current, ...updates }
    pendingUpdateRef.current = null
    if (Object.keys(payload).length === 0) return null
    setSaving(true)
    try {
      const next = await invoke<VoiceDictationSettingsUpdateResult>('voice_dictation_update_settings', payload)
      setSettings(next)
      return next
    } catch (error) {
      toast.error(`保存失败: ${error instanceof Error ? error.message : '未知错误'}`)
      return null
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
      {micPermission && (
        <div
          className={cn(
            'rounded-xl border px-4 py-3',
            (micPermission === 'denied' || restartRequired)
              ? 'border-[color:color-mix(in_oklab,var(--lume-danger)_36%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,transparent)]'
              : 'border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)]',
          )}
        >
          <div className="flex items-center gap-2" role="status">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                micPermission === 'granted' && !restartRequired && 'bg-[var(--lume-success)]',
                micPermission === 'denied' && 'bg-[var(--lume-danger)]',
                micPermission !== 'granted' && micPermission !== 'denied' && 'bg-[var(--text-3)]',
              )}
            />
            <span className="text-body font-medium text-[var(--text-1)]">麦克风权限</span>
            <span className="text-ui text-[var(--text-3)]">
              {restartRequired
                ? '已在系统设置中允许，重启 Lume 后生效'
                : micPermission === 'granted' ? '已授权' : micPermission === 'denied' ? '已被系统拒绝' : '尚未授权'}
            </span>
          </div>
          {(micPermission === 'denied' || restartRequired) && (
            <div className="mt-2 space-y-2">
              {micPermission === 'denied' && (
                <p className="text-[13px] leading-6 text-[var(--text-2)]">
                  语音输入无法工作。请在系统设置中允许 Lume 访问麦克风——修改后需要<strong> 重启 Lume </strong>才能生效。
                </p>
              )}
              {micPermission !== 'denied' && (
                <p className="text-[13px] leading-6 text-[var(--text-2)]">
                  权限已允许，但本进程需要<strong> 重启 Lume </strong>后才能使用新的麦克风权限。
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    invoke('voice_dictation_open_microphone_settings', null)
                      .catch((error: unknown) => toast.error(`打开系统设置失败: ${error instanceof Error ? error.message : '未知错误'}`))
                  }}
                >
                  打开系统设置
                  <ExternalLink size={12} className="ml-1.5" />
                </Button>
                <Button variant="ghost" type="button" onClick={() => void relaunch().catch((error: unknown) => toast.error(`重启失败: ${error instanceof Error ? error.message : '未知错误'}`))}>
                  重启 Lume
                </Button>
              </div>
            </div>
          )}
          {micPermission === 'not-determined' && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="min-w-0 flex-1 text-[13px] leading-6 text-[var(--text-2)]">
                授权后即可在任意入口使用语音输入。
              </p>
              <Button
                variant="outline"
                type="button"
                disabled={requestingMic}
                aria-busy={requestingMic}
                onClick={() => void handleRequestMicPermission()}
              >
                {requestingMic ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin motion-reduce:animate-none" />
                    正在请求…
                  </>
                ) : null}
                {requestingMic ? '' : '授权麦克风'}
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="space-y-2.5 rounded-xl border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Mic size={15} className="shrink-0 text-[var(--text-2)]" />
          <span className="text-body font-medium text-[var(--text-1)]">识别服务</span>
          <span className="rounded-md bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)] px-1.5 py-0.5 text-ui text-[var(--brand)]">
            字节跳动火山引擎 · 流式语音识别大模型
          </span>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-body leading-6 text-[var(--text-2)]">
          <li>
            前往
            <button
              type="button"
              className="mx-1 inline-flex items-center gap-0.5 text-[var(--brand)] hover:underline"
              onClick={() => void invoke('open_external', { url: 'https://console.volcengine.com/speech/service/' })}
            >
              火山引擎语音服务控制台
              <ExternalLink size={11} />
            </button>
            开通「流式语音识别大模型」服务（有免费试用额度）
          </li>
          <li>在语音服务的应用管理中创建应用并授权该服务，拿到 APP ID 与 Access Token</li>
          <li>Resource ID 填 <code className="rounded bg-[var(--surface-3)] px-1 py-0.5 text-ui">volcengine_input_common</code>（或你开通的服务实例 ID）</li>
          <li>对照下方逐项填写凭证，点「测试连接」，然后在输入框点麦克风或按全局快捷键开始听写</li>
        </ol>
      </div>

      <div className="lume-panel divide-y divide-[var(--lume-border-subtle)] px-4 py-1">
        <SettingsRow label="APP ID">
          <Input
            value={settings.appId}
            onChange={(event) => editLocally({ appId: event.target.value })}
            onBlur={() => void applyUpdate()}
            aria-label="APP ID"
            placeholder="服务商控制台的 APP ID"
          />
        </SettingsRow>
        <SettingsRow label="Access Token" hint="仅保存在本机 settings.json">
          <Input
            type="password"
            value={settings.accessToken}
            onChange={(event) => editLocally({ accessToken: event.target.value })}
            onBlur={() => void applyUpdate()}
            aria-label="Access Token"
            placeholder="访问凭证"
          />
        </SettingsRow>
        <SettingsRow label="Resource ID">
          <Input
            value={settings.resourceId}
            onChange={(event) => editLocally({ resourceId: event.target.value })}
            onBlur={() => void applyUpdate()}
            aria-label="Resource ID"
            placeholder="例如 volcengine_input_common"
          />
        </SettingsRow>
        <SettingsRow label="识别语言">
          <Select
            value={settings.language || 'auto'}
            onValueChange={(value) => void applyUpdate({ language: value === 'auto' ? '' : value ?? '' })}
          >
            <SelectTrigger className="w-full" aria-label="识别语言">
              <SelectValue placeholder="自动检测" />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value || 'auto'}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="自定义热词" hint="按行或逗号分隔，最多 100 个；提升专有名词识别率">
          <Textarea
            value={settings.customHotwords}
            onChange={(event) => editLocally({ customHotwords: event.target.value })}
            onBlur={() => void applyUpdate()}
            rows={3}
            aria-label="自定义热词"
            placeholder={'产品名\n人名\n术语'}
            className="w-full resize-y rounded-lg border-[var(--lume-border-subtle)] bg-transparent px-2 py-1.5 text-body leading-6 text-[var(--text-1)]"
          />
        </SettingsRow>
        {settings && (
          <ShortcutRow
            settings={settings}
            onApply={(accelerator) => applyUpdate({ shortcut: accelerator })}
          />
        )}
        <SettingsRow label="结果输出" hint="「写入当前应用」：在 Lume 之外按快捷键唤起听写，结束后粘贴到当时的前台应用光标处（Windows 首次使用需允许；macOS 需辅助功能权限）">
          <ToggleGroup
            value={settings.outputMode}
            onValueChange={(value) => void applyUpdate({ outputMode: value as VoiceDictationSettings['outputMode'] })}
            aria-label="结果输出方式"
            className="flex flex-wrap gap-2 pt-1"
          >
            <ToggleGroupItem value="lume-input" className="h-8 px-3 text-body">
              追加到输入框
            </ToggleGroupItem>
            <ToggleGroupItem value="system-cursor" className="h-8 px-3 text-body">
              写入当前应用
            </ToggleGroupItem>
            <ToggleGroupItem value="clipboard" className="h-8 px-3 text-body">
              复制到剪贴板
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingsRow>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="outline"
          type="button"
          disabled={testing || saving || !credentialsComplete}
          title={credentialsComplete ? undefined : '请先填写完整的 APP ID、Access Token 和 Resource ID'}
          onClick={() => void handleTest()}
        >
          {testing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          测试连接
        </Button>
        {saving ? <span className="text-ui text-[var(--text-3)]">正在保存…</span> : null}
        <span className="text-ui text-[var(--text-3)]">文本框失焦后自动保存；修改在下次听写会话生效。全局快捷键可随时唤起听写。</span>
      </div>
    </div>
  )
}
