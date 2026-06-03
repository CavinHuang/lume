import { useCallback, useEffect, useState } from 'react'
import { Check, ClipboardCheck, ExternalLink, PlugZap, Save } from 'lucide-react'
import { toast } from 'sonner'
import type { ReadingSettingsDraft } from './reading-settings-state'
import {
  READING_ADVANCED_STAGE_OPTIONS,
  READING_CADENCE_OPTIONS,
  buildReadingSettingsSavePayload,
  getReadingSettingsDraft,
} from './reading-settings-state'
import {
  connectReadingWeread,
  disconnectReadingWeread,
  getReadingSnapshot,
  openAndFetchWereadKey,
  readWereadKeyFromClipboard,
  updateReadingSettings,
} from '@/lib/desktop-api/reading'
import { cn } from '@/lib/utils'

export function ReadingSettings() {
  const [draft, setDraft] = useState<ReadingSettingsDraft | null>(null)
  const [connected, setConnected] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [keyFlowBusy, setKeyFlowBusy] = useState(false)

  const load = useCallback(async () => {
    const snapshot = await getReadingSnapshot()
    setDraft(getReadingSettingsDraft(snapshot.settings))
    setConnected(snapshot.wereadConnection.connected)
  }, [])

  useEffect(() => {
    void load().catch((error) => {
      console.error('[ReadingSettings] 加载失败:', error)
      toast.error('读书设置加载失败')
    })
  }, [load])

  const save = async () => {
    if (!draft) return
    try {
      const settings = await updateReadingSettings(buildReadingSettingsSavePayload(draft))
      setDraft(getReadingSettingsDraft(settings))
      toast.success('读书设置已保存')
    } catch (error) {
      console.error('[ReadingSettings] 保存失败:', error)
      toast.error('保存失败')
    }
  }

  const connectWithApiKey = async (key: string) => {
    const trimmed = key.trim()
    if (!trimmed) return
    try {
      await connectReadingWeread({ apiKey: trimmed })
      setApiKey('')
      await load()
      toast.success('微信读书已连接')
    } catch (error) {
      console.error('[ReadingSettings] 微信读书连接失败:', error)
      toast.error('连接失败')
    }
  }

  const connect = () => connectWithApiKey(apiKey)

  const openWereadKeyPage = async () => {
    setKeyFlowBusy(true)
    try {
      const result = await openAndFetchWereadKey()
      if (result.ok) {
        await connectWithApiKey(result.key)
      } else if (result.reason === 'open_failed') {
        toast.error(result.message ?? '打开微信读书失败')
      } else {
        toast('已打开微信读书，复制 Key 后回到 Lume')
      }
    } finally {
      setKeyFlowBusy(false)
    }
  }

  const connectFromClipboard = async () => {
    setKeyFlowBusy(true)
    try {
      const result = await readWereadKeyFromClipboard()
      if (result.ok) {
        await connectWithApiKey(result.key)
      } else {
        toast.error(getWereadKeyErrorLabel(result.reason))
      }
    } finally {
      setKeyFlowBusy(false)
    }
  }

  const disconnect = async () => {
    try {
      await disconnectReadingWeread()
      await load()
      toast.success('微信读书已断开')
    } catch (error) {
      console.error('[ReadingSettings] 微信读书断开失败:', error)
      toast.error('断开失败')
    }
  }

  if (!draft) {
    return (
      <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-8 text-[13px] text-[var(--text-3)]">
        正在加载读书设置
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-semibold text-[var(--text-1)]">微信读书</h3>
            <p className="mt-1 text-[13px] leading-5 text-[var(--text-3)]">连接后，Lume 可以看到你的书架、划线和读书进度。</p>
          </div>
          <span className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px]',
            connected
              ? 'bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] text-[var(--brand)]'
              : 'bg-[var(--surface-2)] text-[var(--text-3)]',
          )}>
            {connected && <Check size={13} />}
            {connected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className="mt-4 flex gap-2">
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="微信读书 API Key"
            className="h-9 min-w-0 flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[13px] outline-none focus:border-[var(--brand)]"
          />
          <button type="button" onClick={connect} className="inline-flex h-9 items-center gap-2 rounded-[8px] bg-[var(--text-1)] px-3 text-[13px] font-medium text-[var(--surface-1)]">
            <PlugZap size={15} />
            连接
          </button>
          {connected && (
            <button type="button" onClick={disconnect} className="h-9 rounded-[8px] border border-[var(--border)] px-3 text-[13px] text-[var(--text-2)]">
              断开
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openWereadKeyPage}
            disabled={keyFlowBusy}
            className="inline-flex h-8 items-center gap-2 rounded-[8px] border border-[var(--border)] px-3 text-[12px] font-medium text-[var(--text-2)] disabled:opacity-55"
          >
            <ExternalLink size={14} />
            打开获取
          </button>
          <button
            type="button"
            onClick={connectFromClipboard}
            disabled={keyFlowBusy}
            className="inline-flex h-8 items-center gap-2 rounded-[8px] border border-[var(--border)] px-3 text-[12px] font-medium text-[var(--text-2)] disabled:opacity-55"
          >
            <ClipboardCheck size={14} />
            读取剪贴板
          </button>
        </div>
      </section>

      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <h3 className="text-[15px] font-semibold text-[var(--text-1)]">阅读节奏</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-[13px] text-[var(--text-2)]">
            <span className="mb-2 block">频率</span>
            <select
              value={draft.cadence}
              onChange={(event) => setDraft((current) => current ? { ...current, cadence: event.target.value as ReadingSettingsDraft['cadence'] } : current)}
              className="h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none"
            >
              {READING_CADENCE_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="text-[13px] text-[var(--text-2)]">
            <span className="mb-2 block">每周深度笔记上限</span>
            <input
              type="number"
              min={1}
              max={4}
              value={draft.maxDeepNotesPerWeek}
              onChange={(event) => setDraft((current) => current ? { ...current, maxDeepNotesPerWeek: Number(event.target.value) } : current)}
              className="h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none"
            />
          </label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-[13px] text-[var(--text-2)]">
          <input
            type="checkbox"
            checked={draft.quiet}
            onChange={(event) => setDraft((current) => current ? { ...current, quiet: event.target.checked } : current)}
          />
          安静运行
        </label>
      </section>

      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <h3 className="text-[15px] font-semibold text-[var(--text-1)]">模型</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-[13px] text-[var(--text-2)]">
            <span className="mb-2 block">文本模型</span>
            <select
              value={draft.textModelMode}
              onChange={(event) => setDraft((current) => current ? { ...current, textModelMode: event.target.value as ReadingSettingsDraft['textModelMode'] } : current)}
              className="h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none"
            >
              <option value="inherit">继承当前聊天</option>
              <option value="explicit">指定模型</option>
            </select>
          </label>
          <label className="text-[13px] text-[var(--text-2)]">
            <span className="mb-2 block">文本模型引用</span>
            <input
              value={draft.textModelRef}
              disabled={draft.textModelMode === 'inherit'}
              onChange={(event) => setDraft((current) => current ? { ...current, textModelRef: event.target.value } : current)}
              placeholder="provider/model"
              className="h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none disabled:opacity-55"
            />
          </label>
          <label className="text-[13px] text-[var(--text-2)]">
            <span className="mb-2 block">图像模型</span>
            <input
              value={draft.imageModelRef}
              onChange={(event) => setDraft((current) => current ? { ...current, imageModelRef: event.target.value } : current)}
              placeholder="provider/image-model"
              className="h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          className="mt-4 text-[13px] font-medium text-[var(--brand)]"
        >
          高级阶段模型
        </button>
        {advancedOpen && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {READING_ADVANCED_STAGE_OPTIONS.map((item) => (
              <label key={item.id} className="text-[13px] text-[var(--text-2)]">
                <span className="mb-2 block">{item.label}</span>
                <input
                  value={draft.advanced[item.id] ?? ''}
                  onChange={(event) => setDraft((current) => current ? {
                    ...current,
                    advanced: {
                      ...current.advanced,
                      [item.id]: event.target.value,
                    },
                  } : current)}
                  placeholder="继承文本模型"
                  className="h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none"
                />
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          className="inline-flex h-9 items-center gap-2 rounded-[8px] bg-[var(--brand)] px-4 text-[13px] font-medium text-[var(--brand-foreground)]"
        >
          <Save size={15} />
          保存
        </button>
      </div>
    </div>
  )
}

function getWereadKeyErrorLabel(reason: string): string {
  switch (reason) {
    case 'clipboard_unavailable':
      return '无法读取剪贴板'
    case 'clipboard_empty':
      return '剪贴板为空'
    case 'invalid_clipboard':
      return '剪贴板里不是微信读书 Key'
    default:
      return '读取微信读书 Key 失败'
  }
}
