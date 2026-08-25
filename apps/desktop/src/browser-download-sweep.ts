import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * 任务下载文件孤儿 GC(#609):finalizeTabs 只清内存索引,downloads/<session>/<turn>
 * 磁盘随任务数无限增长。keep = 存活 ref 的 <session>/<turn> 键(结构化字段判等,
 * 不做路径字符串比较——configDir 的 realpath/大小写形态差异会让前缀匹配静默失效);
 * 其余 turn 目录 mtime 老于宽限(24h,产物体积大误删代价高)即整删。
 * EBUSY/句柄占用静默留待下次(#274/#281)。独立模块以便 bun:test 直接覆盖删除谓词。
 */
export const ORPHAN_DOWNLOAD_GRACE_MS = 24 * 60 * 60_000

/** safePartition 的产出域;外来目录一律跳过,把删除面锁死在运行时自建名上 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,120}$/

export function sweepOrphanDownloads(
  root: string,
  liveRefs: ReadonlyArray<{ browserSessionId: string; browserTurnId: string }>,
  now: number = Date.now(),
  graceMs = ORPHAN_DOWNLOAD_GRACE_MS,
): void {
  let sessionEntries: string[] = []
  try {
    sessionEntries = readdirSync(root)
  } catch {
    return
  }
  const liveKeys = new Set(liveRefs.map((ref) => `${ref.browserSessionId}/${ref.browserTurnId}`))
  for (const session of sessionEntries) {
    if (!SAFE_SEGMENT.test(session)) continue
    const sessionDir = join(root, session)
    let turnEntries: string[] = []
    try {
      turnEntries = readdirSync(sessionDir)
    } catch {
      continue
    }
    for (const turn of turnEntries) {
      if (!SAFE_SEGMENT.test(turn)) continue
      if (liveKeys.has(`${session}/${turn}`)) continue
      const turnDir = join(sessionDir, turn)
      let newestMtime = 0
      try {
        for (const entry of readdirSync(turnDir)) {
          // 逐条 try:单个悬空 symlink 不应让整个 turn 永久漏删
          try {
            newestMtime = Math.max(newestMtime, statSync(join(turnDir, entry)).mtimeMs)
          } catch {
            // 条目不可达:不计入 mtime
          }
        }
      } catch {
        continue
      }
      if (now - newestMtime < graceMs) continue
      try {
        rmSync(turnDir, { recursive: true, force: true })
      } catch {
        // Windows 句柄占用(#274/#281 先例):留待下次 sweep
      }
    }
  }
}
