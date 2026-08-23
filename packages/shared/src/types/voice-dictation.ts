/**
 * 语音输入（听写）类型契约。
 *
 * 链路：renderer 采集 PCM → 主进程流式 ASR WebSocket → 增量转写回 renderer。
 * ASR 凭证与输出方式由设置页配置；录音期间设置变更不影响进行中的会话
 * （renderer 在 start 时快照，主进程在 start 时冻结）。
 */

/** 听写结果输出方式：追加到 Lume 输入框草稿，或复制到剪贴板。 */
export type VoiceDictationOutputMode = 'lume-input' | 'clipboard'

export interface VoiceDictationSettings {
  /** ASR 服务 APP ID（X-Api-App-Key 请求头） */
  appId: string
  /** ASR 服务 Access Token（X-Api-Access-Key 请求头） */
  accessToken: string
  /** ASR 服务 Resource ID（X-Api-Resource-Id 请求头） */
  resourceId: string
  /** 识别语言，空字符串表示自动检测 */
  language: string
  /** 自定义热词，按行或逗号分隔，识别启动时直传 ASR 服务 */
  customHotwords: string
  /** 听写结果输出方式 */
  outputMode: VoiceDictationOutputMode
}

export type VoiceDictationSettingsUpdate = Partial<VoiceDictationSettings>

export type VoiceDictationStatus =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'stopping'
  | 'error'

/** 主进程 → renderer 的 ASR 会话状态事件。 */
export interface VoiceDictationStateEvent {
  sessionId: string
  status: VoiceDictationStatus
  /** 人类可读的状态/错误说明；'asr_session_ended' 表示服务端关闭了会话。 */
  message?: string
}

/** 主进程 → renderer 的增量转写事件。同一会话内 text 为服务端全量累积结果。 */
export interface VoiceDictationTranscriptEvent {
  sessionId: string
  text: string
  isFinal: boolean
}

/** 设置页「测试连接」结果。 */
export interface VoiceDictationTestResult {
  success: boolean
  message: string
}
