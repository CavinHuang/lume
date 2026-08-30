/**
 * 截图子系统(执行器侧)—— 三级截图管线与 CSS 像素校正。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js [SECTION] handleScreenshot(及
 *       captureScreenshotWithCssPixelCorrection 一族)
 *
 * ZCode 原名对照:
 *   Ede → PNG_SIGNATURE                   iH → SCREENSHOT_PIXEL_TOLERANCE
 *   dM → SCREENSHOT_SCALE_TOLERANCE       Tde → SCREENSHOT_MAX_QUALITY_SCALE
 *   Ade → SCREENSHOT_MIN_QUALITY_SCALE    sH → SCREENSHOT_MAX_DIMENSION
 *   xde → SCREENSHOT_MAX_PIXELS           aM → readPngDimensions
 *   Mde → screenshotDimensionDistance     cM → screenshotMatchesTarget
 *   aH → screenshotHasUniformScale        Ode → resolveScreenshotQualityScale
 *   cH → resizeScreenshotToTarget         Dde → chooseHigherInformationScreenshot
 *   $de → readScreenshotTarget            Bg → captureScreenshotWithCssPixelCorrection
 *   uH → readScreenshotLayoutMetrics      pH → resolveScreenshotCssViewport
 *   fH → buildViewportScreenshotParams    hH → handleScreenshot
 *
 * 语义偏差:无(A$ 之外无 zod 依赖)。
 *
 * 截图管线三级:
 *   1. captureViewportScreenshot 钩子(表面协议就绪后的 Electron capturePage);
 *   2. CDP Page.captureScreenshot:clip(scale=1)/fullPage(cssContentSize/
 *      contentSize)/captureBeyondViewport;
 *   3. CSS 像素校正:对比 clip 目标尺寸,按质量比例放大 scale 重拍一次,
 *      必要时经 view.resizeScreenshotToCssPixels 重采样,最后选信息量更高的一张。
 *
 * 注意:readState 来自 ./dispatcher(提升函数绑定,ESM 活绑定安全)。
 */
import type { BrowserCommandResult, ControlledView } from "../types"
import { readState, executionError, type CommandDone, type ScreenshotCommandParams } from "./dispatcher"

/* ── 常量 ──────────────────────────────────────────────────────────── */

/** ZCode 原名 Ede:PNG 签名魔数。 */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
/** ZCode 原名 iH:目标尺寸像素容差。 */
const SCREENSHOT_PIXEL_TOLERANCE = 1
/** ZCode 原名 dM:均匀缩放/信息量比较容差。 */
const SCREENSHOT_SCALE_TOLERANCE = 0.001
/** ZCode 原名 Tde:重拍放大倍率上限。 */
const SCREENSHOT_MAX_QUALITY_SCALE = 2
/** ZCode 原名 Ade:重拍触发下限。 */
const SCREENSHOT_MIN_QUALITY_SCALE = 1.25
/** ZCode 原名 sH:重拍单边像素上限。 */
const SCREENSHOT_MAX_DIMENSION = 4096
/** ZCode 原名 xde:重拍总像素上限(16M)。 */
const SCREENSHOT_MAX_PIXELS = 16_777_216

/** CDP Page.captureScreenshot 参数/响应(仅取用字段)。 */
interface CaptureScreenshotParams {
  format?: string
  captureBeyondViewport?: boolean
  clip?: { x: number; y: number; width: number; height: number; scale: number }
  [key: string]: unknown
}

interface CaptureScreenshotResponse {
  data?: string
}

/** Page.getLayoutMetrics 响应(仅取用字段)。 */
interface LayoutMetrics {
  cssVisualViewport?: ScreenshotViewport
  cssLayoutViewport?: ScreenshotViewport
  cssContentSize?: { width?: unknown; height?: unknown; x?: unknown; y?: unknown }
  contentSize?: { width?: unknown; height?: unknown; x?: unknown; y?: unknown }
}

interface ScreenshotViewport {
  clientWidth?: unknown
  clientHeight?: unknown
  pageX?: unknown
  pageY?: unknown
}

/* ── PNG 尺寸与比较原语 ────────────────────────────────────────────── */

/**
 * ZCode 原名 aM/readPngDimensions:解析 PNG IHDR 尺寸(签名魔数校验,
 * 仅读 base64 前 64 字符);形状不符返回 null。
 */
export function readPngDimensions(base64: string): { width: number; height: number } | null {
  try {
    const head = Buffer.from(base64.slice(0, 64), "base64")
    if (head.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => head[index] !== byte) || head.toString("ascii", 12, 16) !== "IHDR") return null
    const width = head.readUInt32BE(16)
    const height = head.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
}

/** ZCode 原名 Mde/screenshotDimensionDistance:宽高相对偏差之和。 */
export function screenshotDimensionDistance(actual: { width: number; height: number }, target: { width: number; height: number }): number {
  return Math.abs(actual.width - target.width) / target.width + Math.abs(actual.height - target.height) / target.height
}

/** ZCode 原名 cM/screenshotMatchesTarget:宽高均在像素容差内。 */
export function screenshotMatchesTarget(actual: { width: number; height: number }, target: { width: number; height: number }): boolean {
  return Math.abs(actual.width - target.width) < SCREENSHOT_PIXEL_TOLERANCE && Math.abs(actual.height - target.height) < SCREENSHOT_PIXEL_TOLERANCE
}

/** ZCode 原名 aH/screenshotHasUniformScale:宽高缩放比一致(容差内)。 */
export function screenshotHasUniformScale(actual: { width: number; height: number }, target: { width: number; height: number }): boolean {
  return Math.abs(actual.width / target.width - actual.height / target.height) <= SCREENSHOT_SCALE_TOLERANCE
}

/** ZCode 原名 Ode/resolveScreenshotQualityScale:重拍质量倍率(上限/维度约束)。 */
export function resolveScreenshotQualityScale(target: { width: number; height: number }): number {
  const pixels = target.width * target.height
  const scale = Math.min(SCREENSHOT_MAX_QUALITY_SCALE, SCREENSHOT_MAX_DIMENSION / target.width, SCREENSHOT_MAX_DIMENSION / target.height, Math.sqrt(SCREENSHOT_MAX_PIXELS / pixels))
  return Number.isFinite(scale) && scale >= SCREENSHOT_MIN_QUALITY_SCALE ? scale : 1
}

/** ZCode 原名 cH/resizeScreenshotToTarget:CSS 像素重采样并校验目标尺寸。 */
async function resizeScreenshotToTarget(view: ControlledView, captured: CaptureScreenshotResponse, target: { width: number; height: number }): Promise<CaptureScreenshotResponse | null> {
  if (!view.resizeScreenshotToCssPixels || !captured.data) return null
  try {
    const resized = await view.resizeScreenshotToCssPixels(captured.data, target)
    if (!resized) return null
    const dimensions = readPngDimensions(resized)
    return dimensions && screenshotMatchesTarget(dimensions, target)
      ? { ...captured, data: resized }
      : null
  } catch {
    return null
  }
}

/** ZCode 原名 Dde/chooseHigherInformationScreenshot:像素多者/偏差小者胜出。 */
function chooseHigherInformationScreenshot(fallback: CaptureScreenshotResponse, fallbackDimensions: { width: number; height: number }, candidate: CaptureScreenshotResponse, candidateDimensions: { width: number; height: number }, target: { width: number; height: number }): CaptureScreenshotResponse {
  const fallbackPixels = fallbackDimensions.width * fallbackDimensions.height
  const candidatePixels = candidateDimensions.width * candidateDimensions.height
  return candidatePixels !== fallbackPixels
    ? candidatePixels > fallbackPixels ? candidate : fallback
    : screenshotDimensionDistance(candidateDimensions, target) <= SCREENSHOT_SCALE_TOLERANCE ? candidate : fallback
}

/** ZCode 原名 $de/readScreenshotTarget:从 clip 参数读取重拍目标(scale/尺寸)。 */
function readScreenshotTarget(params: CaptureScreenshotParams): { scale: number; target: { width: number; height: number } } | null {
  const clip = params.clip
  if (!clip || typeof clip !== "object" || Array.isArray(clip)) return null
  const candidate = clip as Record<string, unknown>
  return typeof candidate.width !== "number" || !Number.isFinite(candidate.width) || candidate.width <= 0
    || typeof candidate.height !== "number" || !Number.isFinite(candidate.height) || candidate.height <= 0
    || typeof candidate.scale !== "number" || !Number.isFinite(candidate.scale) || candidate.scale <= 0
    ? null
    : {
        scale: candidate.scale,
        target: {
          width: Math.max(1, Math.round(candidate.width)),
          height: Math.max(1, Math.round(candidate.height)),
        },
      }
}

/**
 * ZCode 原名 Bg/captureScreenshotWithCssPixelCorrection:CSS 像素校正捕获。
 * 首拍与 clip 目标比对:已匹配则直返;过大走重采样;过小按质量倍率(或宽高
 * 平均比)放大 scale 重拍一次,仍不匹配则二选一(信息量高者胜)。
 */
export async function captureScreenshotWithCssPixelCorrection(view: ControlledView, params: CaptureScreenshotParams): Promise<CaptureScreenshotResponse> {
  const captured = await view.cdp.send("Page.captureScreenshot", params as Record<string, unknown>) as CaptureScreenshotResponse
  if (!view.normalizeScreenshotToCssPixels || !captured.data) return captured
  const shotTarget = readScreenshotTarget(params)
  const dimensions = captured.data ? readPngDimensions(captured.data) : null
  if (!shotTarget || !dimensions || !screenshotHasUniformScale(dimensions, shotTarget.target)) return captured
  if (dimensions.width > shotTarget.target.width && dimensions.height > shotTarget.target.height) {
    return await resizeScreenshotToTarget(view, captured, shotTarget.target) ?? captured
  }
  const matched = screenshotMatchesTarget(dimensions, shotTarget.target)
  const widthRatio = shotTarget.target.width / dimensions.width
  const heightRatio = shotTarget.target.height / dimensions.height
  const qualityScale = view.resizeScreenshotToCssPixels ? resolveScreenshotQualityScale(shotTarget.target) : 1
  if (matched && qualityScale === 1) return captured
  const boostedScale = shotTarget.scale * (matched ? qualityScale : (widthRatio + heightRatio) / 2 * qualityScale)
  if (!Number.isFinite(boostedScale) || boostedScale < shotTarget.scale || Math.abs(boostedScale - shotTarget.scale) < SCREENSHOT_SCALE_TOLERANCE) return captured
  let recaptured: CaptureScreenshotResponse
  try {
    // shotTarget 仅在 params.clip 有效时非空(readScreenshotTarget),此处直接复用。
    const clip = params.clip as { x: number; y: number; width: number; height: number; scale: number }
    recaptured = await view.cdp.send("Page.captureScreenshot", {
      ...params,
      clip: {
        ...clip,
        scale: boostedScale,
      },
    } as Record<string, unknown>) as CaptureScreenshotResponse
  } catch {
    return captured
  }
  if (!recaptured.data) return captured
  const recapturedDimensions = readPngDimensions(recaptured.data)
  if (!recapturedDimensions || !screenshotHasUniformScale(recapturedDimensions, shotTarget.target)) return captured
  if (screenshotMatchesTarget(recapturedDimensions, shotTarget.target)) return recaptured
  if (recapturedDimensions.width > shotTarget.target.width && recapturedDimensions.height > shotTarget.target.height) {
    const resized = await resizeScreenshotToTarget(view, recaptured, shotTarget.target)
    if (resized) return resized
  }
  return chooseHigherInformationScreenshot(captured, dimensions, recaptured, recapturedDimensions, shotTarget.target)
}

/** ZCode 原名 uH/readScreenshotLayoutMetrics:读取 Page.getLayoutMetrics。 */
export async function readScreenshotLayoutMetrics(view: ControlledView): Promise<LayoutMetrics> {
  return await view.cdp.send("Page.getLayoutMetrics") as LayoutMetrics
}

/**
 * ZCode 原名 pH/resolveScreenshotCssViewport:cssVisualViewport(兜底
 * cssLayoutViewport)解析为截图 clip 原点/尺寸;无效返回 null。
 */
export function resolveScreenshotCssViewport(metrics: LayoutMetrics): { x: number; y: number; width: number; height: number } | null {
  const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport
  const clientWidth = viewport?.clientWidth
  const clientHeight = viewport?.clientHeight
  return typeof clientWidth !== "number" || !Number.isFinite(clientWidth) || clientWidth <= 0
    || typeof clientHeight !== "number" || !Number.isFinite(clientHeight) || clientHeight <= 0
    ? null
    : {
        x: typeof viewport?.pageX === "number" ? viewport.pageX : 0,
        y: typeof viewport?.pageY === "number" ? viewport.pageY : 0,
        width: clientWidth,
        height: clientHeight,
      }
}

/**
 * ZCode 原名 fH/buildViewportScreenshotParams:视口截图参数
 * (captureBeyondViewport:false + CSS 视口 clip(scale=1));非 CSS 校正模式
 * 仅 format+captureBeyondViewport。
 */
export async function buildViewportScreenshotParams(view: ControlledView): Promise<CaptureScreenshotParams> {
  const params: CaptureScreenshotParams = {
    format: "png",
    captureBeyondViewport: false,
  }
  if (!view.normalizeScreenshotToCssPixels) return params
  const viewport = resolveScreenshotCssViewport(await readScreenshotLayoutMetrics(view))
  if (viewport) {
    params.clip = {
      ...viewport,
      scale: 1,
    }
  }
  return params
}

/**
 * ZCode 原名 hH/handleScreenshot:三级管线。
 * 1. 无 clip/fullPage 且表面钩子可用 → captureViewportScreenshot;
 * 2. 组装 CDP 参数(clip / fullPage(cssContentSize 兜底 contentSize) / CSS 视口);
 * 3. 经 captureScreenshotWithCssPixelCorrection 校正后返回。
 */
export async function handleScreenshot(view: ControlledView, params: ScreenshotCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  if (params.clip === undefined && params.fullPage !== true && view.captureViewportScreenshot) {
    const hooked = await view.captureViewportScreenshot()
    return done(hooked
      ? {
          ok: true,
          image: {
            base64: hooked,
            mimeType: "image/png",
          },
          state: readState(view.webContents),
        }
      : {
          ok: false,
          error: {
            code: "execution_error",
            message: "screenshot returned empty data",
          },
        })
  }
  const metrics = params.fullPage === true || view.normalizeScreenshotToCssPixels ? await readScreenshotLayoutMetrics(view) : null
  const cssViewport = view.normalizeScreenshotToCssPixels && metrics ? resolveScreenshotCssViewport(metrics) : null
  const captureParams: CaptureScreenshotParams = {
    format: "png",
    captureBeyondViewport: params.clip !== undefined || params.fullPage === true,
  }
  if (params.clip) {
    captureParams.clip = {
      x: params.clip.x,
      y: params.clip.y,
      width: params.clip.width,
      height: params.clip.height,
      scale: 1,
    }
  } else if (params.fullPage === true) {
    const contentSize = metrics?.cssContentSize ?? metrics?.contentSize
    if (contentSize && typeof contentSize.width === "number" && typeof contentSize.height === "number") {
      captureParams.clip = {
        x: typeof contentSize.x === "number" ? contentSize.x : 0,
        y: typeof contentSize.y === "number" ? contentSize.y : 0,
        width: contentSize.width,
        height: contentSize.height,
        scale: 1,
      }
    }
  } else if (cssViewport) {
    captureParams.clip = {
      ...cssViewport,
      scale: 1,
    }
  }
  const captured = await captureScreenshotWithCssPixelCorrection(view, captureParams)
  return captured?.data
    ? done({
        ok: true,
        image: {
          base64: captured.data,
          mimeType: "image/png",
        },
        state: readState(view.webContents),
      })
    : done({
        ok: false,
        error: {
          code: "execution_error",
          message: "screenshot returned empty data",
        },
      })
}
