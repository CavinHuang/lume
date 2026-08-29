// Office 高保真预览：调用随应用分发的 OfficeCLI 二进制把 docx/xlsx/pptx
// 渲染成独立 HTML，交给渲染进程经 lume-file:// 沙箱 iframe 展示。
// 渲染失败或二进制不可用时返回 null，由调用方回退到渲染层内置查看器。
// 本模块保持零 electron 依赖以便单测；路径一律由参数注入。

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'

const execFileAsync = promisify(execFile)

export const OFFICE_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.xlsx', '.pptx'])

const MAX_OFFICE_SOURCE_BYTES = 50 * 1024 * 1024
const OFFICECLI_RENDER_TIMEOUT_MS = 15_000
const OFFICECLI_MAX_HTML_BYTES = 20 * 1024 * 1024
const OFFICE_PREVIEW_TEMP_TTL_MS = 60 * 60 * 1000
// OfficeCLI 子进程内禁用其自更新/自动安装/常驻进程：预览渲染必须是一次性的
const OFFICECLI_ISOLATED_ENV: NodeJS.ProcessEnv = {
  OFFICECLI_SKIP_UPDATE: '1',
  OFFICECLI_NO_AUTO_INSTALL: '1',
  OFFICECLI_NO_AUTO_RESIDENT: '1',
}

// 与 Proma 对齐的输出 CSP：officecli 产出的 HTML 只允许内联样式/脚本与 data:/blob: 资源，
// 禁一切外联（connect-src/frame-src/object-src 均为 none），iframe 再叠加 sandbox 双保险。
const OFFICE_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; media-src data: blob:"

export function getOfficeCliTargetId({ platform = process.platform, arch = process.arch }: { platform?: NodeJS.Platform; arch?: string } = {}): string {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (platform === 'win32' && arch === 'arm64') return 'win32-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  throw new Error(`unsupported officecli target: ${platform}-${arch}`)
}

export function getBundledOfficeCliPath({
  appIsPackaged,
  resourcesPath,
  desktopRoot,
  platform = process.platform,
  arch = process.arch,
}: {
  appIsPackaged: boolean
  resourcesPath: string
  desktopRoot: string
  platform?: NodeJS.Platform
  arch?: string
}): string {
  const targetId = getOfficeCliTargetId({ platform, arch })
  const fileName = platform === 'win32' ? 'officecli.exe' : 'officecli'
  const root = appIsPackaged
    ? join(resourcesPath, 'officecli')
    : resolve(desktopRoot, 'resources', 'officecli')
  return join(root, targetId, fileName)
}

export function isOfficePreviewPath(filePath: string): boolean {
  return OFFICE_PREVIEW_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export function restrictOfficeCliHtml(html: string): string {
  const policyTag = `<meta http-equiv="Content-Security-Policy" content="${OFFICE_HTML_CSP}">`
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policyTag}`)
  }
  return html.replace(/<html(?:\s[^>]*)?>/i, (htmlTag) => `${htmlTag}<head>${policyTag}</head>`)
}

export interface OfficeCliRenderInput {
  officeCliPath: string
  sourcePath: string
  outputDir?: string
}

export interface OfficeCliRenderResult {
  htmlPath: string
}

let tempDirSwept = false

/**
 * 用 OfficeCLI 把 office 文档渲染为独立 HTML。任何失败（二进制缺失、超时、
 * 输出异常）都返回 null，调用方据此回退内置查看器，不向渲染进程抛错。
 */
export async function renderOfficeFileToHtml(input: OfficeCliRenderInput): Promise<OfficeCliRenderResult | null> {
  if (!isOfficePreviewPath(input.sourcePath)) return null
  if (!isExecutableFile(input.officeCliPath)) return null
  try {
    const size = statSync(input.sourcePath).size
    if (size <= 0 || size > MAX_OFFICE_SOURCE_BYTES) return null
  } catch {
    return null
  }

  const outputDir = input.outputDir ?? getOfficePreviewTempDir()
  sweepStaleTempFiles(outputDir)
  const outputPath = join(outputDir, `office-${randomBytes(16).toString('hex')}.html`)

  try {
    await execFileAsync(input.officeCliPath, ['view', input.sourcePath, 'html', '-o', outputPath], {
      timeout: OFFICECLI_RENDER_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, ...OFFICECLI_ISOLATED_ENV },
      maxBuffer: 1024 * 1024,
    })
    const outputSize = statSync(outputPath).size
    if (outputSize <= 0 || outputSize > OFFICECLI_MAX_HTML_BYTES) throw new Error(`officecli html output size abnormal: ${outputSize}`)
    const html = restrictOfficeCliHtml(readFileSync(outputPath, 'utf-8'))
    if (!html.includes('<html') || !html.includes('</html>')) throw new Error('officecli html output incomplete')
    writeFileSync(outputPath, html, 'utf-8')
    scheduleTempFileCleanup(outputPath)
    return { htmlPath: outputPath }
  } catch (error) {
    try { unlinkSync(outputPath) } catch { /* 输出可能尚未生成 */ }
    console.warn('[office-preview] officecli render failed, falling back to builtin viewer:', error instanceof Error ? error.message : error)
    return null
  }
}

function getOfficePreviewTempDir(): string {
  const dir = join(tmpdir(), 'lume-office-preview')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sweepStaleTempFiles(dir: string): void {
  if (tempDirSwept) return
  tempDirSwept = true
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      try {
        if (statSync(fullPath).mtimeMs <= Date.now() - OFFICE_PREVIEW_TEMP_TTL_MS) unlinkSync(fullPath)
      } catch { /* 单个文件清理失败不影响渲染 */ }
    }
  } catch { /* 目录不可读时跳过清扫 */ }
}

function scheduleTempFileCleanup(path: string): void {
  const cleanup = setTimeout(() => {
    try { unlinkSync(path) } catch { /* 已被清扫或用户清理 */ }
  }, OFFICE_PREVIEW_TEMP_TTL_MS)
  cleanup.unref()
}

function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return false
    if (process.platform === 'win32') return true
    return (stats.mode & 0o111) !== 0
  } catch {
    return false
  }
}
