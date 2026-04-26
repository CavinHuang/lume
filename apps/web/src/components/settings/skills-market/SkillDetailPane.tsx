import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { sidecarCall } from '@/lib/desktop-api'
import { getSkillMarketDetail } from '@/lib/desktop-api/skills-market'
import { buildSourceLabel, buildTrustMeta } from '../skills-market-state'
import type { SkillCatalogItem, SkillFileTreeNode } from '@lume/shared'

function flattenFiles(nodes: SkillFileTreeNode[]): SkillFileTreeNode[] {
  const result: SkillFileTreeNode[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push(node)
    }
    if (node.children) {
      result.push(...flattenFiles(node.children))
    }
  }
  return result
}

export function SkillDetailPane({
  item,
  workspaceSlug,
  onChanged,
}: {
  item: SkillCatalogItem | null
  workspaceSlug: string
  onChanged: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [detail, setDetail] = React.useState<{ files: SkillFileTreeNode[] } | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)

  const trustMeta = item ? buildTrustMeta(item.trustLevel) : null

  // 加载技能文件树
  React.useEffect(() => {
    if (!item) {
      setDetail(null)
      setSelectedPath(null)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    setSelectedPath(null)

    getSkillMarketDetail({ workspaceSlug, skillSlug: item.slug })
      .then((result) => {
        if (cancelled) return
        setDetail({ files: result.files })
        // 默认选中 SKILL.md
        const allFiles = flattenFiles(result.files)
        const skillMd = allFiles.find((f) => f.name === 'SKILL.md')
        setSelectedPath(skillMd?.path ?? allFiles[0]?.path ?? null)
      })
      .catch(() => {
        if (cancelled) return
        setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [item?.slug, workspaceSlug])

  const handleInstall = async () => {
    if (!item?.sourceId || item.sourceType !== 'local') return
    setBusy(true)
    try {
      await sidecarCall('agent:import-global-skill-to-workspace', {
        workspaceSlug,
        skillId: item.sourceId,
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    if (!item) return
    setBusy(true)
    try {
      await sidecarCall('agent:delete-skill', {
        workspaceSlug,
        skillSlug: item.slug,
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (!item) {
    return (
      <div className="rounded-2xl border border-dashed p-8 text-center text-[13px] text-muted-foreground">
        选择左侧 Skill 查看详情
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border bg-[var(--surface-1)] overflow-hidden">
      {/* 头部信息 */}
      <div className="space-y-2 border-b border-[var(--border)] px-5 pb-4 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[16px] font-semibold text-[var(--text-1)]">{item.name}</h3>
          {trustMeta && (
            <Badge variant={trustMeta.badgeVariant} className={trustMeta.toneClass}>
              {trustMeta.label}
            </Badge>
          )}
          <Badge variant="outline">{buildSourceLabel(item.sourceType)}</Badge>
        </div>
        <p className="text-[13px] text-[var(--text-2)]">
          {item.description ?? '暂无描述。'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {item.installState === 'installed' ? (
            <Button variant="outline" size="sm" onClick={() => void handleRemove()} disabled={busy}>
              移除
            </Button>
          ) : item.sourceType === 'local' && item.sourceId?.startsWith('claude:skill:') ? (
            <Button size="sm" onClick={() => void handleInstall()} disabled={busy}>
              导入工作区
            </Button>
          ) : item.sourceType === 'built-in' ? (
            <Button size="sm" disabled>
              内置技能自动同步
            </Button>
          ) : (
            <Button size="sm" disabled>
              安装路径不可用
            </Button>
          )}
          <span className="text-[12px] text-[var(--text-3)]">
            {item.version ?? 'Unknown version'}
          </span>
        </div>
      </div>

      {/* 文件树 + 文件内容 */}
      {detailLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[var(--text-3)]">
          <Loader2 size={14} className="animate-spin" />
          加载文件结构...
        </div>
      ) : detail ? (
        <div className="grid min-h-[340px] grid-cols-[220px_minmax(0,1fr)]">
          {/* 左侧文件树 */}
          <div className="border-r border-[var(--border)] px-3 py-3 overflow-y-auto">
            <FileTree
              nodes={detail.files}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
              depth={0}
            />
          </div>

          {/* 右侧文件内容 */}
          <div className="min-w-0 overflow-y-auto px-5 py-3">
            <FileContent files={detail.files} selectedPath={selectedPath} />
          </div>
        </div>
      ) : (
        <div className="py-8 text-center text-[13px] text-[var(--text-3)]">
          无法加载文件结构
        </div>
      )}
    </div>
  )
}

function FileTree({
  nodes,
  selectedPath,
  onSelect,
  depth,
}: {
  nodes: SkillFileTreeNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
  depth: number
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        if (node.type === 'directory') {
          return (
            <div key={node.path}>
              <div
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-[var(--text-2)]"
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
              >
                <FolderIcon />
                {node.name}
              </div>
              {node.children && node.children.length > 0 && (
                <FileTree
                  nodes={node.children}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              )}
            </div>
          )
        }

        const selected = selectedPath === node.path
        return (
          <button
            key={node.path}
            onClick={() => onSelect(node.path)}
            className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] transition-colors ${
              selected
                ? 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)] font-medium'
                : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <FileIcon name={node.name} />
            {node.name}
          </button>
        )
      })}
    </div>
  )
}

function FileContent({
  files,
  selectedPath,
}: {
  files: SkillFileTreeNode[]
  selectedPath: string | null
}) {
  const file = selectedPath ? flattenFiles(files).find((f) => f.path === selectedPath) : null

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-3)]">
        选择文件查看内容
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-[var(--text-3)]">{file.path}</div>
      <pre className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-[13px] leading-6 text-[var(--text-1)] whitespace-pre-wrap break-words">
        {file.content ?? '(空文件)'}
      </pre>
    </div>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--text-3)]">
      <path d="M1.5 3.5A1 1 0 012.5 2.5h3.172a1 1 0 01.707.293L7.586 3.93h4.914a1 1 0 011 1V5.5H2.5a1 1 0 00-1 1V3.5z" fill="currentColor" opacity="0.4" />
      <path d="M1.5 5.5a1 1 0 011-1h11a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1v-6z" fill="currentColor" opacity="0.6" />
    </svg>
  )
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase()
  let color = 'text-[var(--text-3)]'
  if (ext === 'md') color = 'text-[var(--brand)]'
  else if (ext === 'ts' || ext === 'tsx') color = 'text-blue-500'
  else if (ext === 'js' || ext === 'jsx') color = 'text-yellow-500'
  else if (ext === 'json') color = 'text-green-500'
  else if (ext === 'yml' || ext === 'yaml') color = 'text-orange-500'

  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className={`shrink-0 ${color}`}>
      <path d="M4 1.5h4.5L12 5v8.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-12a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M8.5 1.5V5H12" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  )
}
