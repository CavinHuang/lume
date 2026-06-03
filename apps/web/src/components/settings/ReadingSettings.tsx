import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Check, LogIn, MessageSquare, RefreshCw, Save, TestTube2 } from 'lucide-react'
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
  getWereadApiKey,
  getReadingSnapshot,
  openAndFetchWereadKey,
  testWereadKey,
  updateReadingSettings,
} from '@/lib/desktop-api/reading'

type WereadTestStatus = 'idle' | 'testing' | 'ok' | 'fail'

interface WereadConnectionDetail {
  total?: number
  bookCount?: number
  albumCount?: number
  error?: string
}

const WEREAD_FEATURES = [
  ['查看书架', '你书架上有什么书、读到哪了'],
  ['查看划线', '你画过的线、写过的想法'],
  ['阅读统计', '读了多久、偏好什么类型'],
  ['搜索书籍', '在微信读书书城找书'],
] as const

export function ReadingSettings() {
  const [draft, setDraft] = useState<ReadingSettingsDraft | null>(null)
  const [connected, setConnected] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [savedApiKey, setSavedApiKey] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [keyFlowBusy, setKeyFlowBusy] = useState(false)
  const [testStatus, setTestStatus] = useState<WereadTestStatus>('idle')
  const [connectionDetail, setConnectionDetail] = useState<WereadConnectionDetail | null>(null)

  const load = useCallback(async () => {
    const [snapshot, keyResult] = await Promise.all([
      getReadingSnapshot(),
      getWereadApiKey().catch(() => ({ apiKey: null })),
    ])
    setDraft(getReadingSettingsDraft(snapshot.settings))
    setConnected(snapshot.wereadConnection.connected)
    setApiKey(keyResult.apiKey ?? '')
    setSavedApiKey(keyResult.apiKey ?? '')
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

  const testAndSaveApiKey = async (key: string, options: { auto?: boolean } = {}) => {
    const trimmed = key.trim()
    if (!trimmed) {
      toast.error('请先填入 API KEY')
      return false
    }
    setTestStatus('testing')
    setConnectionDetail(null)
    try {
      const result = await testWereadKey(trimmed)
      if (!result.ok) {
        setTestStatus('fail')
        setConnectionDetail({ error: result.error ?? '连接失败' })
        toast.error(result.error ?? '连接失败')
        return false
      }
      await connectReadingWeread({ apiKey: trimmed })
      setApiKey(trimmed)
      setSavedApiKey(trimmed)
      setConnected(true)
      setTestStatus('ok')
      setConnectionDetail(result)
      await load()
      toast.success(options.auto ? 'API KEY 已自动获取并保存' : '连接成功')
      return true
    } catch (error) {
      console.error('[ReadingSettings] 微信读书连接失败:', error)
      setTestStatus('fail')
      setConnectionDetail({ error: getErrorMessage(error) })
      toast.error('连接失败')
      return false
    }
  }

  const testCurrentApiKey = () => {
    void testAndSaveApiKey(apiKey)
  }

  const openWereadKeyPage = async () => {
    setKeyFlowBusy(true)
    try {
      const result = await openAndFetchWereadKey()
      if (result.ok) {
        setApiKey(result.key)
        await testAndSaveApiKey(result.key, { auto: true })
      } else if (result.reason === 'open_failed') {
        toast.error(result.message ?? '打开微信读书失败')
      } else if (result.reason === 'timeout') {
        toast.error('获取超时，请重试或手动输入')
      } else {
        toast.error(getWereadKeyErrorLabel(result.reason))
      }
    } finally {
      setKeyFlowBusy(false)
    }
  }

  if (!draft) {
    return (
      <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-8 text-[13px] text-[var(--text-3)]">
        正在加载读书设置
      </div>
    )
  }

  const hasApiKey = apiKey.trim().length > 0
  const keyChanged = apiKey.trim() !== savedApiKey.trim()

  return (
    <div className="space-y-4">
      <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <h3 className="text-[20px] font-semibold text-[var(--text-1)]">微信读书</h3>
        <p className="mt-2 text-[15px] leading-6 text-[var(--text-3)]">
          连接微信读书官方 Skill API，让 Lume 了解你的阅读世界——书架、划线、想法、阅读统计。
        </p>

        <div className="mt-5 rounded-[10px] bg-[var(--surface-2)] p-5">
          <div className="flex items-center gap-2">
            <BookOpen size={18} className="text-green-500" />
            <div className="text-[17px] font-semibold text-[var(--text-1)]">API Key</div>
            {(connected || testStatus === 'ok') && (
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-green-50 px-2 text-[12px] text-green-600">
                <Check size={12} />
                已连接
              </span>
            )}
            {testStatus === 'fail' && (
              <span className="inline-flex h-6 items-center rounded-full bg-red-50 px-2 text-[12px] text-red-600">
                连接失败
              </span>
            )}
          </div>

          {!hasApiKey && !connected ? (
            <>
              <button
                type="button"
                onClick={() => void openWereadKeyPage()}
                disabled={keyFlowBusy}
                className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-green-500 text-[15px] font-semibold text-white transition-colors hover:bg-green-600 disabled:cursor-wait disabled:opacity-70"
              >
                {keyFlowBusy ? <RefreshCw size={18} className="animate-spin" /> : <LogIn size={18} />}
                {keyFlowBusy ? '等待扫码登录...' : '微信扫码登录并获取'}
              </button>
              <p className="mt-4 text-center text-[13px] leading-6 text-[var(--text-2)]">
                点击后弹出微信读书页面，请关闭快捷登录弹窗，用扫码方式登录
              </p>
            </>
          ) : (
            <div className="mt-5 space-y-3">
              <div className="flex gap-2">
                <input
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value)
                    setTestStatus('idle')
                    setConnectionDetail(null)
                  }}
                  placeholder="wrk-xxxxxxxx"
                  className="h-11 min-w-0 flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[15px] outline-none focus:border-[var(--brand)]"
                />
                <button
                  type="button"
                  onClick={() => void openWereadKeyPage()}
                  disabled={keyFlowBusy}
                  title="重新扫码获取"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)] disabled:cursor-wait disabled:opacity-60"
                >
                  <RefreshCw size={18} className={keyFlowBusy ? 'animate-spin' : undefined} />
                </button>
                <button
                  type="button"
                  onClick={testCurrentApiKey}
                  disabled={!hasApiKey || testStatus === 'testing'}
                  className="inline-flex h-11 items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-4 text-[14px] font-semibold text-[var(--text-1)] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <TestTube2 size={16} />
                  {testStatus === 'testing' ? '测试中' : keyChanged ? '保存并测试' : '测试'}
                </button>
              </div>

              {testStatus === 'ok' && (
                <div className="rounded-[8px] border border-green-200 bg-green-50 px-4 py-3 text-[14px] text-green-700">
                  {formatWereadConnectionDetail(connectionDetail)}
                </div>
              )}
              {testStatus === 'fail' && (
                <div className="rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-600">
                  {connectionDetail?.error ?? '连接失败，请检查 API KEY'}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-5 rounded-[10px] bg-[var(--surface-2)] p-5">
          <h4 className="text-[16px] font-semibold text-[var(--text-1)]">连接后 Lume 可以做什么</h4>
          <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-2">
            {WEREAD_FEATURES.map(([title, description]) => (
              <div key={title} className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[14px] font-semibold text-[var(--text-1)]">{title}</div>
                  <div className="mt-1 text-[13px] leading-5 text-[var(--text-3)]">{description}</div>
                </div>
                <MessageSquare size={14} className="mt-1 shrink-0 text-[var(--text-3)]" />
              </div>
            ))}
          </div>
          <p className="mt-5 text-[13px] text-[var(--text-2)]">所有数据仅在本地使用，不会上传到任何服务器。</p>
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
    case 'awaiting_copy':
      return '请在微信读书页面点击获取 API KEY'
    case 'clipboard_unavailable':
      return '无法读取剪贴板'
    case 'clipboard_empty':
      return '剪贴板为空'
    case 'invalid_clipboard':
      return '剪贴板里不是微信读书 Key'
    case 'desktop_required':
      return '需要在桌面应用中获取微信读书 Key'
    case 'timeout':
      return '获取超时，请重试或手动输入'
    default:
      return '读取微信读书 Key 失败'
  }
}

function formatWereadConnectionDetail(detail: WereadConnectionDetail | null): string {
  if (!detail || typeof detail.total !== 'number') {
    return '连接成功！'
  }

  const bookCount = typeof detail.bookCount === 'number' ? detail.bookCount : detail.total
  const albumSuffix =
    typeof detail.albumCount === 'number' && detail.albumCount > 0
      ? `，${detail.albumCount} 个有声书`
      : ''

  return `连接成功！书架共 ${detail.total} 个条目（${bookCount} 本电子书${albumSuffix}）`
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
