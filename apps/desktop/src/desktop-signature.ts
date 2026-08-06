import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DesktopAppSignature {
  /**
   * macOS 当前 app 是否具备稳定 TeamID 签名（Developer ID）。
   * - true：Developer ID 签名，Squirrel.Mac 的 quitAndInstall 签名校验可通过
   * - false：ad-hoc 签名（TeamIdentifier=not set），Squirrel 安装校验必失败，需改走 DMG asset 通道
   * - null：非 macOS / 未打包 / 非 .app bundle（dev 或其他平台，不触发降级）
   *
   * 见 issue #22：ad-hoc 包 designated requirement 为 cdhash，跨版本必不匹配。
   */
  macSignatureStable: boolean | null
}

/**
 * 解析 `codesign -dv --verbose=4` 输出，判断是否具备稳定 TeamID。
 * 纯函数，便于单测。codesign 的 verbose 信息输出在 stderr。
 */
export function parseMacSignatureStable(output: string): boolean {
  const match = output.match(/TeamIdentifier=(.*)/)
  const teamId = match?.[1].trim()
  return Boolean(teamId) && teamId !== 'not set'
}

let cachedMacSignatureStable: boolean | null | undefined

/**
 * 检测当前 macOS app 的签名稳定性。仅 darwin + packaged 时执行；
 * 结果缓存避免重复 spawn codesign。检测失败时保守按 ad-hoc（不稳）处理，
 * 让更新走 DMG asset 通道而非必定失败的 Squirrel 校验。
 */
export async function detectMacSignatureStable(params: {
  platform: string
  isPackaged: boolean
  execPath: string
}): Promise<boolean | null> {
  if (params.platform !== 'darwin' || !params.isPackaged) return null
  if (cachedMacSignatureStable !== undefined) return cachedMacSignatureStable

  // process.execPath 形如 .../Lume.app/Contents/MacOS/Lume，三层 dirname 得到 .app bundle
  const appBundle = dirname(dirname(dirname(params.execPath)))
  if (!appBundle.endsWith('.app')) {
    cachedMacSignatureStable = null
    return null
  }

  try {
    const { stdout, stderr } = await execFileAsync('codesign', ['-dv', '--verbose=4', appBundle])
    cachedMacSignatureStable = parseMacSignatureStable(`${stderr}\n${stdout}`)
  } catch (error) {
    // 未签名 / 损坏时 codesign 非零退出；stderr 可能仍含部分签名信息，尝试解析
    const stderr = (error as { stderr?: string })?.stderr
    cachedMacSignatureStable =
      typeof stderr === 'string' && stderr.length > 0 ? parseMacSignatureStable(stderr) : false
  }
  return cachedMacSignatureStable
}
