/**
 * Electron WebM 录制器 —— 隐藏窗口 + getDisplayMedia + canvas 重绘 + MediaRecorder(VP8 WebM)。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\05-webm-recorder.source.js
 * (ZCode 桌面端 main bundle 模块切片, 全部 390 行, s(X,"name") keep-names 标注核实)。
 * 移植规范: apps/desktop/src/browser/PORTING.md;契约: ../types.ts(不得修改)。
 *
 * ZCode 原名对照(s(X,"name") 注解还原):
 * | 本文件标识符                          | ZCode 原名 |
 * |--------------------------------------|------------|
 * | createElectronBrowserWebmRecorder    | K          |
 * | deferred                             | T          |
 * | recorderError                        | c          |
 * | abortError                           | L          |
 * | withTimeout                          | v          |
 * | toChunkBuffer                        | Q          |
 * | recorderHtml                         | U          |
 * | asTargetFrame                        | q          |
 * | closePort                            | O          |
 * | closeWindow                          | J          |
 * | clearDisplayMediaHandler             | G          |
 * | RECORDER_PORT_CHANNEL                | I          |
 * | RECORDER_READY_TIMEOUT_MS            | F(15e3)    |
 * | RECORDER_STOP_TIMEOUT_MS             | V(15e3)    |
 *
 * 内部变量对照:e=options o=log i=targetFrame s=tempHtmlPath d=recorderSession
 * a=recorderWindow m=mainPort R=rendererPort h/b/f=ready/started/stopped deferred
 * l=fileHandle M=firstWriteError g=writeChain u=cleanedUp k=stopRequested
 * p=fail E=onPortMessage S=onRendererGone P=onConsoleMessage w=cleanup C=onAbort。
 *
 * 语义偏差(应仅剩命名/平台前缀):
 * 1. 频道常量 `zcode-browser-video-recorder:port` → `lume-browser-video-recorder:port`;
 *   录制分区 `zcode-browser-video-recorder-<uuid>` → `lume-browser-video-recorder-<uuid>`
 *   (PORTING.md 规范 7 平台前缀替换;recorderHtml 模板除插值外逐字节一致,
 *    提取源里的 \uXXXX 转义按字符串值解码还原)。
 * 2. preload 路径 ZCode 固定为 `join(import.meta.dirname, "../preload/browserVideoRecorder.cjs")`;
 *    Lume 以可选 options.preloadPath 注入, 缺省同路径(PortingGap, 见下方接口注释)。
 * 3. console-message 监听按 Electron 42 事件对象签名读取
 *    `(details: Event<WebContentsConsoleMessageEventParams>)`, 访问字段与原码
 *    `r.level ?? "unknown"` / `r.message ?? ""` 一致(原码即事件对象形态)。
 */

import { randomUUID } from "crypto"
import { mkdir, open, rm, writeFile } from "fs/promises"
import { dirname, join } from "path"
import { BrowserWindow, MessageChannelMain, session } from "electron"
import type {
  Event as ElectronEvent,
  MessageEvent as RecorderMessageEvent,
  RenderProcessGoneDetails,
  WebContentsConsoleMessageEventParams,
} from "electron"
import type { RecordingRecorder, RecordingRecorderOptions } from "../types"

/* ════════════════════════════════════════════════════════════════════
 * PortingGap —— types.ts 契约之外、本文件内声明的结构性类型。
 * ════════════════════════════════════════════════════════════════════ */

/**
 * PortingGap: RecordingRecorderOptions + 录制器预加载脚本路径。
 * ZCode 原码写死 `preload: join(import.meta.dirname, "../preload/browserVideoRecorder.cjs")`;
 * Lume 允许装配方注入 preloadPath(打包后的 .cjs 绝对路径), 缺省保持同一路径。
 */
export interface ElectronBrowserWebmRecorderOptions extends RecordingRecorderOptions {
  /** MessageChannelMain 桥接用 preload 脚本绝对路径;缺省 ../preload/browserVideoRecorder.cjs */
  preloadPath?: string
}

/** 录制器渲染页 → main 的端口消息(duck-typed 读取, 与原码 r.type 判别一致)。 */
interface RecorderPortData {
  type?: unknown
  mimeType?: unknown
  data?: unknown
  message?: unknown
}

/* ── 常量 ─────────────────────────────────────────────────────────── */

/** 渲染页识别 MessagePort 的频道常量(ZCode I;平台前缀替换) */
export const RECORDER_PORT_CHANNEL = "lume-browser-video-recorder:port"

/** ready / started 等待超时(ZCode F = 15e3) */
const RECORDER_READY_TIMEOUT_MS = 15_000

/** stopped 等待超时(ZCode V = 15e3) */
const RECORDER_STOP_TIMEOUT_MS = 15_000

/* ── 小工具(命名对照见文件头) ─────────────────────────────────────── */

/** T —— 首次 settle 即锁定的 deferred(promise 预挂 catch, 防未处理拒绝) */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let settled = false
  let resolveFn!: (value: T) => void
  let rejectFn!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  promise.catch(() => {})
  return {
    promise,
    resolve: value => {
      if (!settled) {
        settled = true
        resolveFn(value)
      }
    },
    reject: error => {
      if (!settled) {
        settled = true
        rejectFn(error)
      }
    },
  }
}

/** c —— 录制器统一错误包装 */
function recorderError(message: string): Error {
  return new Error(`Electron WebM recorder failed: ${message}`)
}

/** L —— 标准中止异常 */
function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError")
}

/** v —— promise 与超时竞速, 超时按 recorderError(message) 拒绝 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(recorderError(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Q —— 端口分片 → Buffer(ArrayBuffer / TypedView / Buffer, 其余 null) */
function toChunkBuffer(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (Buffer.isBuffer(data)) return data
  return null
}

/**
 * U —— 录制器渲染页 HTML。
 * 除 `${JSON.stringify(RECORDER_PORT_CHANNEL)}` 插值与平台前缀(偏差 1)外
 * 与 ZCode 原码逐字节一致;CSP default-src 'none' + script-src 'unsafe-inline'。
 */
function recorderHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
  </head>
  <body>
    <script>
      (() => {
        const channel = ${JSON.stringify(RECORDER_PORT_CHANNEL)};
        let mediaRecorder = null;
        let mediaStream = null;
        let recordingStream = null;
        let sourceVideo = null;
        let recordingCanvas = null;
        let drawTimer = null;
        let chunkQueue = Promise.resolve();
        let cancelling = false;

        const messageText = (error) => error instanceof Error ? error.message : String(error);
        const stopTracks = () => {
          for (const track of mediaStream?.getTracks?.() ?? []) track.stop();
          for (const track of recordingStream?.getTracks?.() ?? []) track.stop();
          mediaStream = null;
          recordingStream = null;
          if (drawTimer !== null) clearInterval(drawTimer);
          drawTimer = null;
          sourceVideo?.remove();
          recordingCanvas?.remove();
          sourceVideo = null;
          recordingCanvas = null;
        };

        window.addEventListener("message", (event) => {
          if (event.source !== window || event.data !== channel) return;
          const port = event.ports[0];
          if (!port) return;
          port.onmessage = async ({ data }) => {
            if (data?.type === "start") {
              try {
                const candidates = ["video/webm;codecs=vp8", "video/webm"];
                const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
                if (!mimeType) throw new Error("Chromium does not support VP8 WebM MediaRecorder");
                const fps = Number(data.fps) || 25;
                const width = Number(data.width);
                const height = Number(data.height);
                if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
                  throw new Error("invalid recorder viewport");
                }
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                  video: { frameRate: fps },
                  audio: false,
                });
                const [videoTrack] = mediaStream.getVideoTracks();
                port.postMessage({
                  type: "diagnostic",
                  message: "track=" + JSON.stringify({
                    active: mediaStream.active,
                    muted: videoTrack?.muted,
                    readyState: videoTrack?.readyState,
                    settings: videoTrack?.getSettings?.(),
                  }),
                });
                videoTrack?.addEventListener("mute", () => port.postMessage({ type: "diagnostic", message: "track muted" }));
                videoTrack?.addEventListener("unmute", () => port.postMessage({ type: "diagnostic", message: "track unmuted" }));
                videoTrack?.addEventListener("ended", () => port.postMessage({ type: "diagnostic", message: "track ended" }));
                sourceVideo = document.createElement("video");
                sourceVideo.muted = true;
                sourceVideo.playsInline = true;
                sourceVideo.srcObject = mediaStream;
                sourceVideo.style.position = "fixed";
                sourceVideo.style.opacity = "0";
                document.body.append(sourceVideo);
                await sourceVideo.play();

                recordingCanvas = document.createElement("canvas");
                recordingCanvas.width = width;
                recordingCanvas.height = height;
                const context = recordingCanvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("2D canvas recorder is unavailable");
                const drawFrame = () => context.drawImage(sourceVideo, 0, 0, width, height);
                drawFrame();
                drawTimer = setInterval(drawFrame, Math.max(1, Math.round(1000 / fps)));
                recordingStream = recordingCanvas.captureStream(fps);
                mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
                mediaRecorder.addEventListener("dataavailable", (chunkEvent) => {
                  port.postMessage({ type: "diagnostic", message: "dataavailable bytes=" + chunkEvent.data?.size });
                  if (!chunkEvent.data || chunkEvent.data.size === 0) return;
                  chunkQueue = chunkQueue.then(async () => {
                    const bytes = await chunkEvent.data.arrayBuffer();
                    // Bug 原因：DOM MessagePort → Electron MessagePortMain 对 ArrayBuffer transfer
                    // 在部分 Electron 平台会静默丢弃整条消息；让 structured clone 复制分片才能
                    // 保证 dataavailable 与后续 stopped 都按序抵达 main。
                    port.postMessage({ type: "chunk", data: bytes });
                  });
                });
                mediaRecorder.addEventListener("error", (recorderEvent) => {
                  port.postMessage({
                    type: "error",
                    message: messageText(recorderEvent.error ?? "MediaRecorder error"),
                  });
                });
                mediaRecorder.addEventListener("stop", async () => {
                  try {
                    await chunkQueue;
                    port.postMessage({ type: cancelling ? "cancelled" : "stopped" });
                  } catch (error) {
                    port.postMessage({ type: "error", message: messageText(error) });
                  } finally {
                    stopTracks();
                  }
                }, { once: true });
                mediaRecorder.start(1000);
                port.postMessage({ type: "started", mimeType: mediaRecorder.mimeType || mimeType });
              } catch (error) {
                stopTracks();
                port.postMessage({ type: "error", message: messageText(error) });
              }
              return;
            }
            if (data?.type === "stop") {
              if (mediaRecorder?.state === "recording" || mediaRecorder?.state === "paused") {
                mediaRecorder.stop();
              } else {
                port.postMessage({ type: "error", message: "MediaRecorder is not recording" });
              }
              return;
            }
            if (data?.type === "cancel") {
              cancelling = true;
              if (mediaRecorder?.state === "recording" || mediaRecorder?.state === "paused") {
                mediaRecorder.stop();
              } else {
                stopTracks();
                port.postMessage({ type: "cancelled" });
              }
            }
          };
          port.start();
          port.postMessage({ type: "ready" });
        }, { once: true });
      })();
    </script>
  </body>
</html>`
}

/** q —— 目标帧活性守卫(销毁/分离即报错) */
function asTargetFrame(frame: Electron.WebFrameMain): Electron.WebFrameMain {
  if (!frame || typeof frame.isDestroyed !== "function" || frame.isDestroyed() || frame.detached) {
    throw recorderError("target WebFrameMain is unavailable")
  }
  return frame
}

/** O —— 端口静默关闭 */
function closePort(port: Electron.MessagePortMain): void {
  try {
    port.close()
  } catch {}
}

/** J —— 窗口强制销毁 */
function closeWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy()
}

/** G —— 清理 displayMedia 处理器 */
function clearDisplayMediaHandler(recorderSession: Electron.Session): void {
  try {
    recorderSession.setDisplayMediaRequestHandler(null)
  } catch {}
}

/* ════════════════════════════════════════════════════════════════════
 * createElectronBrowserWebmRecorder(ZCode K)
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 创建 Electron WebM 录制器:按 recordingId 分区启动隐藏渲染窗口, 经
 * MessageChannelMain 桥接收分片并顺序写入 outputPath。
 *
 * 生命周期:mkdir → 写临时 HTML(mode 0600)→ setDisplayMediaRequestHandler
 * (仅对录制页 frame 且只给 video)→ open 输出文件 → loadFile 后删临时 HTML →
 * postMessage 移交端口 → ready(15s)→ start(15s)。失败即全量清理并抛错。
 *
 * stop():通知 MediaRecorder 停止 → 等 stopped(15s)→ 排空写链 → 重放首个写错误;
 * cancel():立即清理(先向渲染页投递 cancel)。signal 中止等价 cancel 并使
 * ready/started/stopped 全部按 AbortError 拒绝;render-process-gone / 端口关闭
 * 使所有等待按错误拒绝。已清理后再次 stop 抛 "recorder is already closed"。
 *
 * @param log 可选诊断日志(原码第二参数 o, 装配时通常注入 deps.warn/log)
 */
export async function createElectronBrowserWebmRecorder(
  options: ElectronBrowserWebmRecorderOptions,
  log?: (message: string) => void,
): Promise<RecordingRecorder> {
  if (options.signal.aborted) throw abortError()
  const targetFrame = asTargetFrame(options.targetFrame)
  await mkdir(dirname(options.outputPath), { recursive: true })
  const tempHtmlPath = join(dirname(options.outputPath), `.${randomUUID()}-browser-video-recorder.html`)
  const recorderSession = session.fromPartition(`lume-browser-video-recorder-${randomUUID()}`)
  const recorderWindow = new BrowserWindow({
    show: false,
    width: Math.max(1, options.viewport.width),
    height: Math.max(1, options.viewport.height),
    webPreferences: {
      session: recorderSession,
      preload: options.preloadPath ?? join(import.meta.dirname, "../preload/browserVideoRecorder.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  })
  recorderWindow.webContents.setWindowOpenHandler(() => ({
    action: "deny",
  }))
  const { port1: mainPort, port2: rendererPort } = new MessageChannelMain()
  const readyDeferred = deferred<void>()
  const startedDeferred = deferred<void>()
  const stoppedDeferred = deferred<void>()
  let fileHandle: import("fs/promises").FileHandle | undefined
  let firstWriteError: unknown
  let writeChain = Promise.resolve()
  let cleanedUp = false
  let stopRequested = false

  /** p —— 三个 deferred 全部按同一错误拒绝 */
  const fail = (error: unknown): void => {
    const normalized = error instanceof Error ? error : recorderError(String(error))
    readyDeferred.reject(normalized)
    startedDeferred.reject(normalized)
    stoppedDeferred.reject(normalized)
  }

  /** E —— main 侧端口消息:ready/started/chunk/stopped/error/diagnostic */
  const onPortMessage = (event: RecorderMessageEvent): void => {
    const data = event.data as RecorderPortData | null | undefined
    if (!data || typeof data.type !== "string") return
    if (log) log(`[browser-recording] recorder message type=${data.type}`)
    if (data.type === "ready") {
      readyDeferred.resolve()
      return
    }
    if (data.type === "started") {
      if (data.mimeType !== "video/webm;codecs=vp8" && data.mimeType !== "video/webm") {
        fail(recorderError(`unexpected MediaRecorder MIME type: ${String(data.mimeType)}`))
        return
      }
      startedDeferred.resolve()
      return
    }
    if (data.type === "chunk") {
      const chunk = toChunkBuffer(data.data)
      if (!chunk || chunk.byteLength === 0) {
        log?.(`[browser-recording] ignored empty chunk value=${Object.prototype.toString.call(data.data)}`)
        return
      }
      log?.(`[browser-recording] received WebM chunk bytes=${chunk.byteLength}`)
      writeChain = writeChain
        .then(async () => {
          if (!fileHandle) throw recorderError("output file is already closed")
          await fileHandle.write(chunk)
        })
        .catch(error => {
          firstWriteError ??= error
        })
      return
    }
    if (data.type === "stopped") {
      stoppedDeferred.resolve()
      return
    }
    if (data.type === "error") {
      fail(recorderError(typeof data.message === "string" ? data.message : "unknown error"))
      return
    }
    if (data.type === "diagnostic") log?.(`[browser-recording] ${String(data.message ?? "")}`)
  }
  mainPort.on("message", onPortMessage)
  mainPort.on("close", () => {
    if (!cleanedUp) fail(recorderError("recorder MessagePort closed unexpectedly"))
  })
  mainPort.start()
  /** S —— 渲染进程崩溃使全部等待失败 */
  const onRendererGone = (_event: ElectronEvent, details: RenderProcessGoneDetails): void => {
    if (!cleanedUp) fail(recorderError(`recorder renderer exited: ${details.reason ?? "unknown"}`))
  }
  recorderWindow.webContents.on("render-process-gone", onRendererGone)
  /** P —— 录制页 console 透传诊断日志(Electron 42 事件对象签名, 字段 level/message) */
  const onConsoleMessage = (details: ElectronEvent<WebContentsConsoleMessageEventParams>): void => {
    log?.(`[browser-recording] recorder console level=${details.level ?? "unknown"} message=${details.message ?? ""}`)
  }
  recorderWindow.webContents.on("console-message", onConsoleMessage)

  /**
   * w —— 全量清理:可选 cancel 投递 → 排空写链 → 关文件 → 解绑/关端口 →
   * 清 displayMedia 处理器 → 解绑监听 → 销毁窗口 → 删临时 HTML。
   */
  const cleanup = async (sendCancel: boolean): Promise<void> => {
    if (cleanedUp) return
    cleanedUp = true
    options.signal.removeEventListener("abort", onAbort)
    if (sendCancel) {
      try {
        mainPort.postMessage({ type: "cancel" })
      } catch {}
    }
    await writeChain.catch(() => {})
    await fileHandle?.close().catch(() => {})
    fileHandle = undefined
    mainPort.removeListener("message", onPortMessage)
    closePort(mainPort)
    closePort(rendererPort)
    clearDisplayMediaHandler(recorderSession)
    recorderWindow.webContents.removeListener("render-process-gone", onRendererGone)
    recorderWindow.webContents.removeListener("console-message", onConsoleMessage)
    closeWindow(recorderWindow)
    await rm(tempHtmlPath, { force: true }).catch(() => {})
  }
  /** C —— 外部中止:全 deferred 按 AbortError 拒绝 + cancel 清理 */
  const onAbort = (): void => {
    fail(abortError())
    void cleanup(true)
  }
  options.signal.addEventListener("abort", onAbort, { once: true })
  try {
    await writeFile(tempHtmlPath, recorderHtml(), { encoding: "utf8", mode: 0o600 })
    recorderSession.setDisplayMediaRequestHandler((request, callback) => {
      if (
        cleanedUp ||
        request.frame !== recorderWindow.webContents.mainFrame ||
        !request.videoRequested ||
        request.audioRequested ||
        targetFrame.isDestroyed() ||
        targetFrame.detached
      ) {
        callback({})
        return
      }
      callback({ video: targetFrame })
    })
    fileHandle = await open(options.outputPath, "w")
    await recorderWindow.loadFile(tempHtmlPath)
    await rm(tempHtmlPath, { force: true }).catch(() => {})
    recorderWindow.webContents.postMessage(RECORDER_PORT_CHANNEL, null, [rendererPort])
    await withTimeout(readyDeferred.promise, RECORDER_READY_TIMEOUT_MS, "recorder renderer did not become ready")
    mainPort.postMessage({
      type: "start",
      fps: options.fps,
      width: options.viewport.width,
      height: options.viewport.height,
    })
    await withTimeout(startedDeferred.promise, RECORDER_READY_TIMEOUT_MS, "MediaRecorder did not start")
  } catch (error) {
    fail(error)
    await cleanup(true)
    throw error
  }
  return {
    stop: async (): Promise<void> => {
      if (cleanedUp) throw recorderError("recorder is already closed")
      if (stopRequested) {
        await withTimeout(stoppedDeferred.promise, RECORDER_STOP_TIMEOUT_MS, "MediaRecorder did not stop")
        return
      }
      stopRequested = true
      mainPort.postMessage({ type: "stop" })
      try {
        await withTimeout(stoppedDeferred.promise, RECORDER_STOP_TIMEOUT_MS, "MediaRecorder did not stop")
        await writeChain
        if (firstWriteError) throw firstWriteError
      } finally {
        await cleanup(false)
      }
    },
    cancel: (): Promise<void> => cleanup(true),
  }
}
