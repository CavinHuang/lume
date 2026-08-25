/**
 * 流式 ASR 服务（字节跳动豆包 OpenSpeech 协议）。
 *
 * 主进程持有 WebSocket（ws 包——鉴权需要自定义 Header，浏览器/undici WebSocket
 * 不支持）：事件经回调上抛，不直接耦合 BrowserWindow。
 *
 * 协议要点：4 字节定长头 + 4 字节 payload 长度；请求 JSON/音频均 gzip；
 * 音频末帧置 FLAG_LAST_NO_SEQUENCE 触发服务端收尾。
 */

import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import WebSocket from 'ws'
import type { VoiceDictationSettings, VoiceDictationStateEvent, VoiceDictationTranscriptEvent } from '@lume/shared'

const PROTOCOL_VERSION = 0b0001
const HEADER_SIZE = 0b0001

const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0b0001
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0b0010
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001
const MESSAGE_TYPE_SERVER_ERROR = 0b1111

const FLAG_NO_SEQUENCE = 0b0000
const FLAG_LAST_NO_SEQUENCE = 0b0010
const FLAG_SERVER_SEQUENCE = 0b0001
const FLAG_SERVER_LAST_SEQUENCE = 0b0011

const SERIALIZATION_NONE = 0b0000
const SERIALIZATION_JSON = 0b0001

const COMPRESSION_NONE = 0b0000
const COMPRESSION_GZIP = 0b0001

// 听写走 async 单向端点；服务端负责端点检测与切句。
const ASR_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'

// 听写允许自然停顿，避免默认 800ms 静音就过早切句；1s 无声即强制进入识别。
const DICTATION_END_WINDOW_SIZE_MS = 5000
const DICTATION_FORCE_TO_SPEECH_TIME_MS = 1000
const MAX_INLINE_HOTWORDS = 100
const HOTWORD_SEPARATOR_PATTERN = /[\n,，、;；]+/u
// 发送 last 帧后等服务端回最终结果的收尾宽限。
const CLOSE_AFTER_STOP_MS = 800
const CONNECT_TIMEOUT_MS = 10_000
// 并发会话上限：每条会话都持用户凭证连 ASR 端点，防异常调用方烧配额。
const MAX_ACTIVE_SESSIONS = 4

interface ServerUtterance {
  text?: string
  definite?: boolean
}

interface ServerResult {
  text?: string
  confidence?: number
  utterances?: ServerUtterance[]
}

interface ServerPayload {
  result?: ServerResult | ServerResult[]
  text?: string
  message?: string
  error?: string
}

export interface ParsedServerMessage {
  text: string
  isFinal: boolean
  /** 服务端错误帧：text 是错误说明，必须走状态通道而非当作听写文本。 */
  isError?: boolean
}

export interface VoiceAsrEventHandlers {
  onState(event: VoiceDictationStateEvent): void
  onTranscript(event: VoiceDictationTranscriptEvent): void
}

interface ActiveSession {
  ws: WebSocket
  closed: boolean
}

const activeSessions = new Map<string, ActiveSession>()

function buildHeader(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

function buildFrame(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Buffer,
): Buffer {
  const header = buildHeader(messageType, flags, serialization, compression)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, size, payload])
}

function parseCustomHotwords(value: string): { word: string }[] {
  const seen = new Set<string>()
  const hotwords: { word: string }[] = []
  for (const rawWord of value.split(HOTWORD_SEPARATOR_PATTERN)) {
    const word = rawWord.trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    hotwords.push({ word })
    if (hotwords.length >= MAX_INLINE_HOTWORDS) break
  }
  return hotwords
}

function buildClientRequest(settings: VoiceDictationSettings): Buffer {
  const audio: Record<string, unknown> = {
    format: 'pcm',
    codec: 'raw',
    rate: 16000,
    bits: 16,
    channel: 1,
  }
  if (settings.language) {
    audio.language = settings.language
  }

  // 热词以 corpus.context JSON 直传服务端。
  const hotwords = parseCustomHotwords(settings.customHotwords)

  const request = {
    user: {
      uid: 'lume-desktop',
    },
    audio,
    request: {
      model_name: 'bigmodel',
      enable_nonstream: true,
      show_utterances: true,
      result_type: 'full',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      end_window_size: DICTATION_END_WINDOW_SIZE_MS,
      force_to_speech_time: DICTATION_FORCE_TO_SPEECH_TIME_MS,
      ...(hotwords.length > 0
        ? { corpus: { context: JSON.stringify({ hotwords }) } }
        : {}),
    },
  }

  const payload = gzipSync(Buffer.from(JSON.stringify(request), 'utf-8'))
  return buildFrame(
    MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    FLAG_NO_SEQUENCE,
    SERIALIZATION_JSON,
    COMPRESSION_GZIP,
    payload,
  )
}

function buildAudioFrame(audio: Buffer, isLast: boolean): Buffer {
  return buildFrame(
    MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    isLast ? FLAG_LAST_NO_SEQUENCE : FLAG_NO_SEQUENCE,
    SERIALIZATION_NONE,
    COMPRESSION_GZIP,
    gzipSync(audio),
  )
}

export function buildAuthHeaders(settings: VoiceDictationSettings): Record<string, string> {
  return {
    'X-Api-App-Key': settings.appId,
    'X-Api-Access-Key': settings.accessToken,
    'X-Api-Resource-Id': settings.resourceId,
    'X-Api-Connect-Id': randomUUID(),
  }
}

function getResultText(result: ServerResult): string {
  return result.text ?? result.utterances?.map((item) => item.text ?? '').join('') ?? ''
}

function getAuthoritativeResult(results: ServerResult[]): ServerResult | null {
  const candidates = results
    .map((result) => ({ result, text: getResultText(result) }))
    .filter((item) => item.text.trim().length > 0)

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!.result

  // result 数组表示识别候选而非分句；拼接会制造重复文本，取置信度最高者。
  return [...candidates]
    .sort((left, right) => (right.result.confidence ?? 0) - (left.result.confidence ?? 0))[0]!
    .result
}

function isResultFinal(result: ServerResult): boolean {
  return result.utterances?.some((item) => item.definite === true) ?? false
}

function parseServerPayload(value: unknown, fallbackFinal: boolean): ParsedServerMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const payload = value as ServerPayload
  const results = Array.isArray(payload.result)
    ? payload.result
    : payload.result
      ? [payload.result]
      : []

  if (results.length === 0) {
    const message = payload.text ?? payload.message ?? payload.error
    return message ? { text: message, isFinal: fallbackFinal } : null
  }

  if (payload.text) {
    return {
      text: payload.text,
      isFinal: fallbackFinal || results.some(isResultFinal),
    }
  }

  const authoritativeResult = getAuthoritativeResult(results)
  if (!authoritativeResult) return null
  const text = getResultText(authoritativeResult)
  if (!text) return null
  return {
    text,
    isFinal: fallbackFinal || isResultFinal(authoritativeResult),
  }
}

/** 解析服务端二进制帧为转写消息；非响应/无文本时返回 null。 */
export function parseServerMessage(data: Buffer): ParsedServerMessage | null {
  if (data.length < 8) return null

  const headerSize = (data[0]! & 0x0f) * 4
  const messageType = data[1]! >> 4
  const flags = data[1]! & 0x0f
  const serialization = data[2]! >> 4
  const compression = data[2]! & 0x0f
  let offset = headerSize

  const hasSequence = flags === FLAG_SERVER_SEQUENCE || flags === FLAG_SERVER_LAST_SEQUENCE
  if (hasSequence) {
    offset += 4
  }

  if (messageType === MESSAGE_TYPE_SERVER_ERROR) {
    if (data.length < offset + 8) return null
    const code = data.readUInt32BE(offset)
    offset += 4
    const size = data.readUInt32BE(offset)
    offset += 4
    const message = data.subarray(offset, offset + size).toString('utf-8')
    return { text: `语音识别服务错误 ${code}: ${message}`, isFinal: true, isError: true }
  }

  if (messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE || data.length < offset + 4) {
    return null
  }

  const payloadSize = data.readUInt32BE(offset)
  offset += 4
  // 解析函数契约：任何畸形帧（截断/坏 gzip/坏 JSON）都返回 null 而非抛错，
  // 由 message handler 统一丢弃该帧继续收流。
  try {
    const payload = data.subarray(offset, offset + payloadSize)
    const decoded = compression === COMPRESSION_GZIP ? gunzipSync(payload) : payload
    if (serialization !== SERIALIZATION_JSON) return null
    const parsed = JSON.parse(decoded.toString('utf-8')) as unknown
    return parseServerPayload(parsed, flags === FLAG_SERVER_LAST_SEQUENCE)
  } catch {
    return null
  }
}

/** 测试 ASR 连接，仅验证 WebSocket 握手与鉴权 Header。 */
export async function testVoiceAsrConnection(
  settings: VoiceDictationSettings,
): Promise<{ success: boolean; message: string }> {
  if (!settings.appId || !settings.accessToken || !settings.resourceId) {
    return { success: false, message: '请先填写 APP ID、Access Token 和 Resource ID' }
  }

  return await new Promise((resolve) => {
    const ws = new WebSocket(ASR_ENDPOINT, { headers: buildAuthHeaders(settings) })

    const timer = setTimeout(() => {
      ws.terminate()
      resolve({ success: false, message: '连接超时，请检查网络或凭证' })
    }, CONNECT_TIMEOUT_MS)

    ws.once('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve({ success: true, message: 'ASR 连接成功' })
    })

    ws.once('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ success: false, message: `连接失败: ${error.message}` })
    })
  })
}

function requireValidCredentials(settings: VoiceDictationSettings): void {
  if (!settings.appId || !settings.accessToken || !settings.resourceId) {
    throw new Error('请先在设置中填写语音识别凭证')
  }
}

function toBuffer(message: unknown): Buffer {
  if (Array.isArray(message)) return Buffer.concat(message.map(toBuffer))
  if (Buffer.isBuffer(message)) return message
  if (message instanceof ArrayBuffer) return Buffer.from(message)
  return Buffer.from((message as ArrayBufferView).buffer as ArrayBuffer)
}

export async function startVoiceAsrSession(
  sessionId: string,
  settings: VoiceDictationSettings,
  handlers: VoiceAsrEventHandlers,
): Promise<void> {
  requireValidCredentials(settings)
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    throw new Error('语音识别并发会话已达上限，请稍后再试')
  }
  await cancelVoiceAsrSession(sessionId)

  handlers.onState({ sessionId, status: 'connecting', message: '正在连接语音识别...' })

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(ASR_ENDPOINT, { headers: buildAuthHeaders(settings) })
    const active: ActiveSession = { ws, closed: false }
    activeSessions.set(sessionId, active)

    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    // 同 sessionId 重开时（cancel 的 terminate 异步派发 close），旧连接的
    // close/error 回调晚于新会话 set 入 Map——必须身份校验，否则会误删新会话。
    const removeIfCurrent = (): void => {
      if (activeSessions.get(sessionId) === active) activeSessions.delete(sessionId)
    }

    const timer = setTimeout(() => {
      active.closed = true
      removeIfCurrent()
      ws.terminate()
      fail(new Error('连接语音识别服务超时'))
    }, CONNECT_TIMEOUT_MS)

    ws.once('open', () => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      ws.send(buildClientRequest(settings))
      handlers.onState({ sessionId, status: 'recording', message: '正在听写' })
      resolve()
    })

    ws.on('message', (message: unknown) => {
      try {
        const parsed = parseServerMessage(toBuffer(message))
        if (!parsed) return
        if (parsed.isError) {
          // 配额/鉴权/协议错误走状态通道，绝不能混进听写文本被提交。
          handlers.onState({ sessionId, status: 'error', message: parsed.text })
          return
        }
        handlers.onTranscript({ sessionId, text: parsed.text, isFinal: parsed.isFinal })
      } catch (error) {
        // 单帧损坏不代表会话失效：丢弃该帧继续收流，
        // 上报会话级 error 会让状态与仍在推送的转写数据流脱节。
        console.warn('[voice-asr] dropped malformed frame:', error instanceof Error ? error.message : error)
      }
    })

    ws.once('close', () => {
      clearTimeout(timer)
      active.closed = true
      // 仅当仍是 Map 中的当前会话才删除并广播——被同 id 重开顶替的旧连接
      // 静默退场，避免污染新会话状态机；正常关闭必须下发 asr_session_ended，
      // 否则 renderer 的自动续录永远不会触发。
      const isCurrent = activeSessions.get(sessionId) === active
      if (isCurrent) removeIfCurrent()
      // 未结算的 promise 必须了结（即使本连接已被顶替）。
      if (!settled) {
        settled = true
        reject(new Error('连接语音识别服务在建立前已关闭'))
      }
      if (!isCurrent) return
      handlers.onState({ sessionId, status: 'idle', message: 'asr_session_ended' })
    })

    ws.once('error', (error: Error) => {
      clearTimeout(timer)
      active.closed = true
      const isCurrent = activeSessions.get(sessionId) === active
      if (isCurrent) removeIfCurrent()
      if (!settled) {
        settled = true
        reject(error)
      }
      if (!isCurrent) return
      handlers.onState({ sessionId, status: 'error', message: error.message })
    })
  })
}

export function sendVoiceAsrAudio(sessionId: string, data: ArrayBuffer): void {
  const active = activeSessions.get(sessionId)
  if (!active || active.closed || active.ws.readyState !== WebSocket.OPEN) return
  const audio = Buffer.from(data)
  if (audio.length === 0) return
  active.ws.send(buildAudioFrame(audio, false))
}

export async function stopVoiceAsrSession(sessionId: string): Promise<void> {
  const active = activeSessions.get(sessionId)
  if (!active || active.closed) return

  if (active.ws.readyState === WebSocket.OPEN) {
    active.ws.send(buildAudioFrame(Buffer.alloc(0), true))
    setTimeout(() => {
      if (!active.closed) active.ws.close()
    }, CLOSE_AFTER_STOP_MS)
  } else {
    active.ws.terminate()
  }
}

export async function cancelVoiceAsrSession(sessionId: string): Promise<void> {
  const active = activeSessions.get(sessionId)
  if (!active) return
  active.closed = true
  activeSessions.delete(sessionId)
  active.ws.terminate()
}

export function cancelAllVoiceAsrSessions(): void {
  for (const session of activeSessions.values()) {
    session.closed = true
    session.ws.terminate()
  }
  activeSessions.clear()
}
