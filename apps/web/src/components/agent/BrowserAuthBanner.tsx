import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { KeyRound } from 'lucide-react'
import { agentPendingInteractiveAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentBrowserAuthRequest, type AgentBrowserAuthResponseInput } from '@lume/shared'
import { removePendingBrowserAuthRequest } from '@/hooks/pending-interactive-state'
import { getSubagentDisplayLabel } from './subagent-label'
import { InteractiveOverlayFrame } from './InteractiveOverlayFrame'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface BrowserAuthBannerProps {
  threadId: string
  request: AgentBrowserAuthRequest
}

export function buildBrowserAuthSubmission(input: {
  threadId: string
  requestId: string
  values: Record<string, string>
}): AgentBrowserAuthResponseInput {
  return {
    threadId: input.threadId,
    requestId: input.requestId,
    status: 'submitted',
    values: input.values,
  }
}

export function BrowserAuthBanner({ threadId, request }: BrowserAuthBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [values, setValues] = useState<Record<string, string>>({})
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const subagentDisplayLabel = getSubagentDisplayLabel(request)

  useEffect(() => {
    setValues({})
    setHidden(false)
    setBusy(false)
    setError(null)
  }, [threadId, request.requestId])

  const dismiss = () => {
    setPending((prev) => removePendingBrowserAuthRequest(prev, threadId, request.requestId))
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_BROWSER_AUTH, buildBrowserAuthSubmission({
        threadId,
        requestId: request.requestId,
        values,
      }))
      setValues({})
      dismiss()
    } catch (err) {
      console.error('[BrowserAuthBanner] submit failed', err)
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setBusy(true)
    setError(null)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_BROWSER_AUTH, {
        threadId,
        requestId: request.requestId,
        status: 'cancelled',
      } satisfies AgentBrowserAuthResponseInput)
      setValues({})
      dismiss()
    } catch (err) {
      console.error('[BrowserAuthBanner] cancel failed', err)
      setError(err instanceof Error ? err.message : '取消失败')
    } finally {
      setBusy(false)
    }
  }

  const submitDisabled = request.fields.some((field) => field.required && !values[field.id])

  if (hidden) return null

  return (
    <InteractiveOverlayFrame
      kind="browser-auth"
      title="安全输入浏览器凭证"
      busy={busy}
      submitDisabled={submitDisabled}
      onIgnore={() => setHidden(true)}
      onSubmit={() => void submit()}
    >
      <div className="space-y-3">
        <div className="rounded-[16px] border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-amber-700">
              <KeyRound size={15} />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold leading-5 text-[#1f232b]">
                只会把凭证填入当前浏览器页面，Agent 只能看到提交状态。
              </p>
              <p className="mt-0.5 truncate font-mono text-[12px] leading-5 text-amber-800">{request.origin}</p>
              {request.reason && (
                <p className="text-[12px] leading-5 text-[#6f7682]">{request.reason}</p>
              )}
              {subagentDisplayLabel && (
                <p className="text-[12px] leading-5 text-[#8a8f98]">{subagentDisplayLabel}</p>
              )}
            </div>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {request.fields.map((field) => (
            <label key={field.id} className="block">
              <span className="mb-1 block px-1 text-[12px] font-semibold leading-5 text-[#5c626d]">
                {field.label}{field.required ? ' *' : ''}
              </span>
              <Input
                type={field.type === 'password' ? 'password' : 'text'}
                autoComplete={field.autocomplete}
                value={values[field.id] ?? ''}
                onChange={(event) => setValues((prev) => ({ ...prev, [field.id]: event.target.value }))}
                className="h-10 w-full rounded-[12px] border border-black/10 bg-white px-3 text-[14px] text-[#1f232b] outline-none transition-colors focus:border-[#5f9cff] focus:ring-2 focus:ring-[#5f9cff]/20"
              />
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="text-[11px] leading-4 text-[#8a8f98]">
            不要把密码或验证码粘贴到聊天消息里；如果来源不可信，请取消请求。
          </p>
          <Button
                variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => void cancel()}
            className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60"
          >
            取消请求
          </Button>
        </div>
        {error && (
          <p className="px-1 pt-1 text-[12px] leading-5 text-destructive">{error}</p>
        )}
      </div>
    </InteractiveOverlayFrame>
  )
}
