/**
 * 语音听写状态机 hook。
 *
 * 链路：getUserMedia → AudioContext(ScriptProcessor) → 16kHz PCM 分块 IPC →
 * 主进程流式 ASR → 增量转写事件回 renderer 合并显示 → 停止后提交。
 *
 * 竞态防护：recordingAttempt 代数计数让慢速异步握手（麦克风授权、ASR 连接、
 * 会话重连）在停止/取消/重开后全部失效；迟到事件经 sessionId 校验丢弃。
 */

import * as React from 'react'
import type {
  VoiceDictationSettings,
  VoiceDictationTranscriptEvent,
} from '@lume/shared'
import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'
import { toast } from 'sonner'
import {
  CHUNK_BYTES,
  concatAudioBuffers,
  floatTo16BitPcm,
  splitChunk,
} from './voice-audio-utils'
import {
  createEmptyTranscriptMergeState,
  mergeVoiceDictationTranscript,
  type VoiceDictationTranscriptMergeState,
} from './voice-transcript-merge'

export type VoiceDictationHookStatus = 'idle' | 'connecting' | 'recording' | 'stopping' | 'error'

// 停止后等服务端最终结果的兜底时限；超时则用当前累积文本提交。
const STOP_COMMIT_TIMEOUT_MS = 1400
// 收到 isFinal 转写后延迟片刻再提交，吸收紧随其后的修正事件。
const FINAL_COMMIT_DELAY_MS = 180
// ASR 未就绪期间的音频缓存上限（chunk 数），防连接异常时无限膨胀。
const MAX_QUEUED_CHUNKS = 60

interface UseVoiceDictationOptions {
  /** 输出方式为 lume-input 时，最终文本经此回调追加到输入框草稿。 */
  onCommit: (text: string) => void
  /** 凭证未配置时 toast 的跳转动作（打开设置页）。 */
  onOpenSettings?: () => void
}

/** 录音已进行的秒数（mm:ss 展示用）。 */
export function formatVoiceElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getMicrophoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return '麦克风权限被系统阻止，请在系统设置中允许 Lume 访问麦克风'
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '没有检测到可用麦克风，请检查输入设备是否已连接并启用'
      case 'NotReadableError':
      case 'TrackStartError':
        return '麦克风当前无法读取，可能被其他应用占用或被系统隐私设置阻止'
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return '当前麦克风不支持请求的采集参数，请切换输入设备后重试'
      case 'SecurityError':
        return '当前窗口被系统阻止访问麦克风，请检查应用权限设置'
      default:
        break
    }
  }
  return error instanceof Error && error.message ? error.message : '无法启动麦克风'
}

export function useVoiceDictation({ onCommit, onOpenSettings }: UseVoiceDictationOptions) {
  const [status, setStatus] = React.useState<VoiceDictationHookStatus>('idle')
  const [transcript, setTranscript] = React.useState('')
  const [volume, setVolume] = React.useState(0)
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0)

  const statusRef = React.useRef<VoiceDictationHookStatus>('idle')
  const setStatusTracked = React.useCallback((next: VoiceDictationHookStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const attemptRef = React.useRef(0)
  const sessionIdRef = React.useRef<string | null>(null)
  const discardRef = React.useRef(false)
  const stoppingRef = React.useRef(false)
  const asrReadyRef = React.useRef(false)
  const settingsRef = React.useRef<VoiceDictationSettings | null>(null)

  const streamRef = React.useRef<MediaStream | null>(null)
  const audioContextRef = React.useRef<AudioContext | null>(null)
  const processorRef = React.useRef<ScriptProcessorNode | null>(null)
  const sourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null)
  const pendingAudioRef = React.useRef<ArrayBuffer[]>([])
  const queuedAudioRef = React.useRef<ArrayBuffer[]>([])

  const mergeStateRef = React.useRef<VoiceDictationTranscriptMergeState>(createEmptyTranscriptMergeState())
  const transcriptRef = React.useRef('')
  const commitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCommitRef = React.useRef(onCommit)
  onCommitRef.current = onCommit
  const onOpenSettingsRef = React.useRef(onOpenSettings)
  onOpenSettingsRef.current = onOpenSettings

  // 录音计时：会话活跃期间每秒递增，归位随 settleIdle。
  React.useEffect(() => {
    if (status !== 'connecting' && status !== 'recording') return
    const timer = setInterval(() => setElapsedSeconds((current) => current + 1), 1000)
    return () => clearInterval(timer)
  }, [status])

  const cleanupAudio = React.useCallback(() => {
    processorRef.current?.disconnect()
    processorRef.current = null
    sourceRef.current?.disconnect()
    sourceRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const invalidateSession = React.useCallback(() => {
    sessionIdRef.current = null
    discardRef.current = true
    attemptRef.current += 1
    setVolume(0)
  }, [])

  /** 归零所有会话状态回到 idle。 */
  const settleIdle = React.useCallback(() => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    invalidateSession()
    cleanupAudio()
    mergeStateRef.current = createEmptyTranscriptMergeState()
    setTranscript('')
    transcriptRef.current = ''
    setElapsedSeconds(0)
    setStatusTracked('idle')
  }, [cleanupAudio, invalidateSession, setStatusTracked])

  const commitText = React.useCallback((text: string) => {
    const finalText = text.trim()
    const mode = settingsRef.current?.outputMode ?? 'lume-input'
    // 窗口不在前台时任务栏/Dock 提醒听写已完成。
    if (typeof document !== 'undefined' && !document.hasFocus()) {
      void invoke('desktop_flash_window', null).catch(() => {})
    }
    settleIdle()
    if (!finalText) {
      toast.info('未识别到语音内容')
      return
    }
    if (mode === 'clipboard') {
      invoke('write_clipboard_text', { text: finalText })
        .then(() => toast.success('听写结果已复制到剪贴板'))
        .catch((error: unknown) => toast.error(`写入剪贴板失败: ${error instanceof Error ? error.message : '未知错误'}`))
      return
    }
    onCommitRef.current(finalText)
  }, [settleIdle])

  const scheduleCommit = React.useCallback((delayMs: number) => {
    if (commitTimerRef.current) return
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null
      commitText(transcriptRef.current)
    }, delayMs)
  }, [commitText])

  const sendAudioChunk = React.useCallback((sessionId: string, chunk: ArrayBuffer) => {
    if (!asrReadyRef.current) {
      if (queuedAudioRef.current.length < MAX_QUEUED_CHUNKS) queuedAudioRef.current.push(chunk)
      return
    }
    void invoke('voice_dictation_audio_chunk', { sessionId, data: chunk }).catch(() => {})
  }, [])

  const flushQueuedAudio = React.useCallback(() => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    for (const chunk of queuedAudioRef.current) {
      void invoke('voice_dictation_audio_chunk', { sessionId, data: chunk }).catch(() => {})
    }
    queuedAudioRef.current = []
  }, [])

  /** 把不足一个 CHUNK 的残余音频补发给服务端（停止前调用，避免丢尾部）。 */
  const flushPendingAudio = React.useCallback(() => {
    const sessionId = sessionIdRef.current
    if (!sessionId || pendingAudioRef.current.length === 0) return
    const merged = concatAudioBuffers(pendingAudioRef.current)
    pendingAudioRef.current = []
    if (merged.byteLength > 0) sendAudioChunk(sessionId, merged)
  }, [sendAudioChunk])

  const startAsrSession = React.useCallback(async (sessionId: string, attempt: number): Promise<void> => {
    await invoke('voice_dictation_start', { sessionId })
    if (attempt !== attemptRef.current || sessionIdRef.current !== sessionId) {
      void invoke('voice_dictation_cancel', { sessionId }).catch(() => {})
      return
    }
    asrReadyRef.current = true
    flushQueuedAudio()
    // 连接建立前用户已按了停止：立即补发缓存与收尾帧并进入提交流程。
    if (stoppingRef.current) {
      for (const chunk of queuedAudioRef.current.splice(0)) {
        sendAudioChunk(sessionId, chunk)
      }
      await invoke('voice_dictation_stop', { sessionId }).catch(() => {})
      scheduleCommit(STOP_COMMIT_TIMEOUT_MS)
    }
  }, [flushQueuedAudio, scheduleCommit, sendAudioChunk])

  const startAudioCapture = React.useCallback(async (attempt: number): Promise<void> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境不支持麦克风采集')
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
        },
      })
    } catch (error) {
      // 部分设备不支持完整约束，退回裸 audio 重试一次。
      if (error instanceof DOMException && error.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } else {
        throw error
      }
    }
    if (attempt !== attemptRef.current) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    streamRef.current = stream

    const audioContext = new AudioContext()
    if (attempt !== attemptRef.current) {
      stream.getTracks().forEach((track) => track.stop())
      void audioContext.close().catch(() => {})
      return
    }
    audioContextRef.current = audioContext
    const source = audioContext.createMediaStreamSource(stream)
    sourceRef.current = source
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    processorRef.current = processor

    processor.onaudioprocess = (event) => {
      const sessionId = sessionIdRef.current
      if (!sessionId || stoppingRef.current) return
      const input = event.inputBuffer.getChannelData(0)

      let peak = 0
      for (let i = 0; i < input.length; i += 1) peak = Math.max(peak, Math.abs(input[i] ?? 0))
      setVolume(Math.min(1, peak * 4))

      const pcm = floatTo16BitPcm(input, audioContext.sampleRate)
      pendingAudioRef.current.push(pcm)
      let merged = concatAudioBuffers(pendingAudioRef.current)
      while (merged.byteLength >= CHUNK_BYTES) {
        const { chunk, rest } = splitChunk(merged, CHUNK_BYTES)
        if (!chunk) break
        sendAudioChunk(sessionId, chunk)
        merged = rest
      }
      pendingAudioRef.current = merged.byteLength > 0 ? [merged] : []
    }

    source.connect(processor)
    processor.connect(audioContext.destination)
    if (audioContext.state === 'suspended') await audioContext.resume().catch(() => {})

    if (!stream.getAudioTracks().some((track) => track.readyState === 'live' && track.enabled)) {
      throw new Error('麦克风未就绪，请检查系统权限与设备连接')
    }

    // getUserMedia 授予且音频图恢复即认定采集就绪；不依赖首个 ScriptProcessor
    // 回调——部分系统会延后回调，导致界面永远停在"准备中"。
    if (attempt === attemptRef.current && !stoppingRef.current && statusRef.current !== 'recording') {
      setStatusTracked('recording')
    }
  }, [sendAudioChunk, setStatusTracked])

  /** 启动失败统一出口：toast + 清理 + 回 idle；凭证缺失时附带设置页跳转。 */
  const failStart = React.useCallback((message: string, options?: { missingCredentials?: boolean }): void => {
    toast.error(message, options?.missingCredentials && onOpenSettingsRef.current
      ? { action: { label: '去配置', onClick: onOpenSettingsRef.current } }
      : undefined)
    settleIdle()
  }, [settleIdle])

  const startRecording = React.useCallback(async (): Promise<void> => {
    stoppingRef.current = false
    asrReadyRef.current = false
    queuedAudioRef.current = []
    pendingAudioRef.current = []

    setStatusTracked('connecting')
    const attempt = ++attemptRef.current
    const isCurrent = (): boolean => attempt === attemptRef.current
    const shouldProceed = (): boolean => isCurrent() && !stoppingRef.current

    let settings: VoiceDictationSettings
    try {
      settings = await invoke<VoiceDictationSettings>('voice_dictation_get_settings', null)
    } catch {
      failStart('读取语音输入设置失败')
      return
    }
    if (!shouldProceed()) return
    settingsRef.current = settings
    if (!settings.appId || !settings.accessToken || !settings.resourceId) {
      failStart('语音输入尚未配置，请先填写识别服务凭证', { missingCredentials: true })
      return
    }

    // macOS 系统级 TCC 权限预检：已拒绝直接指路系统设置；首次使用主动弹授权框。
    // Windows/Linux 返回 unsupported，由 getUserMedia 触发系统授权。
    try {
      const permission = await invoke<{ status: string }>('voice_dictation_check_microphone', null)
      if (!shouldProceed()) return
      if (permission.status === 'denied') {
        failStart('麦克风权限已被系统阻止，请在系统设置中允许 Lume 访问麦克风')
        return
      }
      if (permission.status === 'not-determined') {
        const requested = await invoke<{ status: string }>('voice_dictation_request_microphone', null)
        if (!shouldProceed()) return
        if (requested.status !== 'granted') {
          failStart('需要麦克风权限才能使用语音输入')
          return
        }
      }
    } catch {
      // 预检失败不阻断：交给 getUserMedia 的错误路径兜底。
    }

    const sessionId = crypto.randomUUID()
    sessionIdRef.current = sessionId
    setTranscript('')
    transcriptRef.current = ''
    mergeStateRef.current = createEmptyTranscriptMergeState()

    const audioCapture = startAudioCapture(attempt).catch((error: unknown) => {
      if (!isCurrent()) return
      failStart(getMicrophoneErrorMessage(error))
      void invoke('voice_dictation_cancel', { sessionId }).catch(() => {})
    })

    startAsrSession(sessionId, attempt).catch((error: unknown) => {
      if (!isCurrent() || stoppingRef.current) return
      failStart(error instanceof Error ? error.message : '启动语音识别失败')
      void invoke('voice_dictation_cancel', { sessionId }).catch(() => {})
    })

    await audioCapture
  }, [failStart, startAsrSession, startAudioCapture, setStatusTracked])

  const stopRecording = React.useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current
    if (statusRef.current !== 'recording' && statusRef.current !== 'connecting') return
    if (!sessionId) {
      settleIdle()
      return
    }
    stoppingRef.current = true
    setStatusTracked('stopping')
    flushPendingAudio()
    await invoke('voice_dictation_stop', { sessionId }).catch(() => {})
    scheduleCommit(STOP_COMMIT_TIMEOUT_MS)
  }, [flushPendingAudio, scheduleCommit, settleIdle, setStatusTracked])

  const cancelRecording = React.useCallback((): void => {
    const sessionId = sessionIdRef.current
    if (sessionId) void invoke('voice_dictation_cancel', { sessionId }).catch(() => {})
    settleIdle()
  }, [settleIdle])

  // 组件级事件订阅：转写合并 / 会话状态 / 服务端断线自动续录。
  React.useEffect(() => {
    let cancelled = false

    const unlistenTranscript = listen<VoiceDictationTranscriptEvent>('voice-dictation:transcript', (event) => {
      const data = event.payload
      if (cancelled || discardRef.current || data.sessionId !== sessionIdRef.current) return
      const merged = mergeVoiceDictationTranscript(
        mergeStateRef.current,
        typeof data.text === 'string' ? data.text : '',
        data.sessionId,
      )
      mergeStateRef.current = merged.state
      setTranscript(merged.text)
      transcriptRef.current = merged.text
      if (statusRef.current === 'stopping' && data.isFinal) {
        scheduleCommit(FINAL_COMMIT_DELAY_MS)
      }
    })

    const unlistenState = listen<{ sessionId: string; status: string; message?: string }>('voice-dictation:state', (event) => {
      const data = event.payload
      if (cancelled || data.sessionId !== sessionIdRef.current) return
      // 停止/提交途中的错误不再打断提交流程。
      if (stoppingRef.current && data.status === 'error') return

      if (data.status === 'idle' && data.message === 'asr_session_ended') {
        // 服务端静音超时关会话：仍在录音则开新会话续录（attempt 不变，
        // 已积累的转写由 merge 的跨会话拼接保留）。
        if (stoppingRef.current || discardRef.current) return
        const attempt = attemptRef.current
        const previousSessionId = data.sessionId
        if (!previousSessionId || sessionIdRef.current !== previousSessionId) return
        const nextSessionId = crypto.randomUUID()
        sessionIdRef.current = nextSessionId
        asrReadyRef.current = false
        queuedAudioRef.current = []
        startAsrSession(nextSessionId, attempt).catch((error: unknown) => {
          if (attemptRef.current !== attempt || stoppingRef.current) return
          failStart(error instanceof Error ? error.message : '语音识别会话已断开')
        })
        return
      }

      if (data.status === 'error') {
        failStart(data.message ?? '语音识别出错')
        void invoke('voice_dictation_cancel', { sessionId: data.sessionId }).catch(() => {})
      }
      // connecting/recording 状态以本地采集就绪为准，不覆盖本地状态机。
    })

    // Alt+V 全局快捷键：活跃输入框切换录音（TabContent 只挂载活跃 tab，无多实例竞态）。
    const unlistenToggle = listen<null>('voice-dictation:toggle', () => {
      if (cancelled) return
      const current = statusRef.current
      if (current === 'recording' || current === 'connecting') {
        void stopRecording()
        return
      }
      if (current === 'idle') {
        void startRecording()
      }
    })

    return () => {
      cancelled = true
      unlistenTranscript.then((fn) => fn())
      unlistenState.then((fn) => fn())
      unlistenToggle.then((fn) => fn())
      // 卸载时作废会话并通知主进程终止 ASR 连接。
      const sessionId = sessionIdRef.current
      if (sessionId && !discardRef.current) {
        void invoke('voice_dictation_cancel', { sessionId }).catch(() => {})
      }
      invalidateSession()
      cleanupAudio()
    }
  }, [cleanupAudio, failStart, invalidateSession, scheduleCommit, startAsrSession, startRecording, stopRecording])

  return {
    status,
    transcript,
    volume,
    elapsedSeconds,
    isActive: status === 'connecting' || status === 'recording' || status === 'stopping',
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
  }
}
