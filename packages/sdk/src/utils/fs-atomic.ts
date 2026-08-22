/**
 * Atomic file replacement shared by mutating tools.
 */

import { lstat, realpath, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'

/**
 * tmp+rename 原子替换。rename 会把 filePath 处的 symlink 本体整个换成普通
 * 文件，链接路径与真实路径的内容自此分叉；检出 symlink 后改为解析目标、
 * 对目标做沙箱复检并写入（#367）。悬空链接直接报错，不隐式替换。
 *
 * # ponytail: lstat→写入之间链接仍可被调包，check-then-use 天花板；
 * 根治需 fd 级 IO（O_NOFOLLOW / openat2）。
 */
export async function writeFileAtomic(
  filePath: string,
  content: Uint8Array,
  assertAllowed?: (resolvedPath: string) => string | null,
): Promise<void> {
  let targetPath = filePath
  const linkStat = await lstat(filePath).catch(() => undefined)
  if (linkStat?.isSymbolicLink()) {
    // 悬空链接时 realpath 以 ENOENT 拒绝，调用方收到错误而非静默换链
    targetPath = await realpath(filePath)
    const denial = assertAllowed?.(targetPath)
    if (denial) throw new Error(denial)
  }
  const dir = dirname(targetPath)
  const tempPath = join(dir, `.${basename(targetPath)}.${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content)
    await rename(tempPath, targetPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
