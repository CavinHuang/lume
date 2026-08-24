import type { ReactNode } from 'react'
import { asRecord, asString, parseToolCallOutput } from '../message-blocks/tool-summary'
import { DefaultResult } from './default-result'

interface Props { input: Record<string, unknown>; result: unknown }

/**
 * #601:浏览器动作结果渲染。真实数据形制（engine 事件出口已定型）：
 * - 普通动作/snapshot：JSON 对象，大段快照正文在 observation.tree（或顶层 tree）
 * - screenshot：image block 已被 engine 替换为占位文本数组 [{type:'text',text:'[Image: …]',_meta:{screenshotId}}]
 *   ——base64 不经事件流下发（#600/#630 决策面），真图内联渲染需上游取回通道，此处给干净占位而非倾倒
 */

/** 快照折叠阈值：低于该值的 tree 直接平铺，避免小快照多一次点击 */
const SNAPSHOT_FOLD_THRESHOLD_CHARS = 600
/** 非 tree 字段的整体序列化超过该值时也收进折叠区 */
const COMPACT_DUMP_LIMIT_CHARS = 2_000

function ScreenshotPlaceholder({ text, screenshotId }: { text: string; screenshotId?: string }) {
  // '[Image: image/png]' → 'image/png'
  const mediaType = text.replace(/^\[Image:\s*/, '').replace(/\]$/, '') || '图片'
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11.5px] text-foreground/55">
      <span>🖼</span>
      <span>截图（{mediaType}）已生成{screenshotId ? ` · ${screenshotId.slice(0, 12)}` : ''}</span>
    </div>
  )
}

function SnapshotSection({ tree }: { tree: string }) {
  const lineCount = tree.split('\n').length
  const chars = tree.length
  const fold = chars > SNAPSHOT_FOLD_THRESHOLD_CHARS
  const body = (
    <pre className="mt-1 max-h-[min(40vh,360px)] overflow-auto rounded-md bg-muted/30 p-2 text-[11px] font-mono leading-relaxed text-foreground/65 whitespace-pre">{tree}</pre>
  )
  if (!fold) return body
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer select-none text-[11.5px] text-foreground/45 transition-colors hover:text-foreground/70">
        页面快照（{lineCount} 行 / {chars} 字符，点击展开）
      </summary>
      {body}
    </details>
  )
}

export function BrowserResult({ input, result }: Props): ReactNode {
  const parsed = typeof result === 'string' ? parseToolCallOutput(result) : result

  // JSON 解析失败的超长字符串（如被 resultPolicy 截断的半截截图 JSON）不倾倒
  if (typeof parsed === 'string' && parsed.length > COMPACT_DUMP_LIMIT_CHARS) {
    return (
      <details className="mt-1">
        <summary className="cursor-pointer select-none text-[11.5px] text-foreground/45 transition-colors hover:text-foreground/70">
          结果较大（{parsed.length} 字符，点击展开）
        </summary>
        <pre className="mt-1 max-h-[min(40vh,360px)] overflow-auto rounded-md bg-muted/30 p-2 text-[11px] font-mono text-foreground/65 whitespace-pre-wrap break-all">{parsed}</pre>
      </details>
    )
  }

  // 截图：engine 出口已是占位文本数组
  if (Array.isArray(parsed)) {
    const shots = parsed
      .map((block) => asRecord(block))
      .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[Image'))
      .map((block) => ({ text: block.text as string, screenshotId: asString(asRecord(block._meta).screenshotId) }))
    if (shots.length > 0) {
      return (
        <div className="space-y-1">
          {shots.map((shot, index) => (
            <ScreenshotPlaceholder key={shot.screenshotId ?? index} text={shot.text} screenshotId={shot.screenshotId} />
          ))}
        </div>
      )
    }
    return <DefaultResult input={input} result={result} />
  }

  const record = asRecord(parsed)
  if (!record || Object.keys(record).length === 0) {
    return <DefaultResult input={input} result={result} />
  }

  // 结构化错误：sidecar 浏览器错误为 {ok:false, code, message}
  if (record.ok === false) {
    const code = asString(record.code)
    const message = asString(record.message)
    return (
      <div className="rounded-md bg-destructive/8 px-2 py-1 text-[11.5px] text-destructive/85">
        {message ?? code ?? '浏览器动作失败'}
        {code && message ? ` (${code})` : ''}
      </div>
    )
  }

  // snapshot / 动作后观察：大段正文在 observation.tree 或顶层 tree
  const observation = asRecord(record.observation)
  const treeSource = typeof observation.tree === 'string'
    ? observation
    : typeof record.tree === 'string'
      ? record
      : undefined

  if (treeSource) {
    const title = asString(treeSource.title)
    const url = asString(treeSource.url)
    return (
      <div className="space-y-1">
        {(title || url) && (
          <div className="truncate text-[11.5px] text-foreground/60">
            {title ?? ''}{title && url ? ' · ' : ''}{url ?? ''}
          </div>
        )}
        <SnapshotSection tree={treeSource.tree as string} />
      </div>
    )
  }

  // 其余对象形制：整体不大则维持默认渲染；异常巨大（防御 resultPolicy 截断残留）只给预览
  const dumped = JSON.stringify(parsed, null, 2)
  if (dumped.length > COMPACT_DUMP_LIMIT_CHARS) {
    return (
      <details className="mt-1">
        <summary className="cursor-pointer select-none text-[11.5px] text-foreground/45 transition-colors hover:text-foreground/70">
          结果较大（{dumped.length} 字符，点击展开）
        </summary>
        <pre className="mt-1 max-h-[min(40vh,360px)] overflow-auto rounded-md bg-muted/30 p-2 text-[11px] font-mono text-foreground/65 whitespace-pre-wrap break-all">{dumped}</pre>
      </details>
    )
  }
  return <DefaultResult input={input} result={result} />
}
