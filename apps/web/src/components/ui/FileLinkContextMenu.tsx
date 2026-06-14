import { type ReactElement } from "react"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { resolveFileLinkActions } from "@/components/agent/file-link-actions"
import type { FileLinkContext } from "@/components/agent/file-link-types"

export type FileLinkMenuItem =
  | { kind: "item"; key: string; label: string; onSelect: () => void }
  | { kind: "separator"; key: string }

/** 菜单项构造（纯函数，便于 SSR 测试）。onPreview 缺省时不显示「预览」项。 */
export function buildFileLinkMenuItems(
  ctx: FileLinkContext,
  opts: { hasPreview?: boolean; onPreview?: () => void } = {},
): FileLinkMenuItem[] {
  const actions = resolveFileLinkActions(ctx)
  const items: FileLinkMenuItem[] = []
  let n = 0
  const sep = () => ({ kind: "separator" as const, key: `sep-${n++}` })

  if (opts.hasPreview && opts.onPreview) {
    items.push({ kind: "item", key: "preview", label: "在右侧预览", onSelect: opts.onPreview })
    items.push(sep())
  }
  items.push({ kind: "item", key: "open", label: "用系统应用打开", onSelect: actions.openInSystem })
  items.push({ kind: "item", key: "reveal", label: "在 Finder 中显示", onSelect: actions.revealInFolder })
  items.push(sep())
  if (ctx.source !== "local") {
    items.push({ kind: "item", key: "copy-rel", label: "复制相对路径", onSelect: actions.copyRelativePath })
  }
  items.push({ kind: "item", key: "copy-abs", label: "复制绝对路径", onSelect: actions.copyAbsolutePath })
  items.push(sep())
  items.push({ kind: "item", key: "save-as", label: "另存为…", onSelect: actions.saveAs })
  return items
}

function isContextUsable(ctx: FileLinkContext): boolean {
  if (ctx.source === "thread") return Boolean(ctx.threadId)
  if (ctx.source === "workspace") return Boolean(ctx.workspaceSlug)
  return true // local
}

interface FileLinkContextMenuProps {
  context: FileLinkContext
  onPreview?: () => void
  /** 内联场景（markdown 行内胶囊）用 span 作 trigger 外壳，避免 div 破坏行内流；块级场景默认 div。 */
  inline?: boolean
  children: ReactElement
}

export function FileLinkContextMenu({ context, onPreview, inline = false, children }: FileLinkContextMenuProps) {
  if (!isContextUsable(context)) return <>{children}</>

  const items = buildFileLinkMenuItems(context, {
    hasPreview: Boolean(onPreview),
    onPreview,
  })

  return (
    <ContextMenu>
      <ContextMenuTrigger render={inline ? <span /> : <div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {items.map((item) =>
          item.kind === "separator" ? (
            <ContextMenuSeparator key={item.key} />
          ) : (
            <ContextMenuItem key={item.key} onSelect={item.onSelect}>
              {item.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
