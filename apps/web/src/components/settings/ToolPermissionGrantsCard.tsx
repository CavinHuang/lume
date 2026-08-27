import { Trash2, Wand2 } from 'lucide-react'
import type { AgentToolPermissionAllowScope, AgentToolPermissionGrantRecord } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * 「始终允许」workspace 级持久授权的查看/撤销区块（#775(d)）。
 * 纯展示组件：数据与动作由 PermissionSettings 注入，便于静态渲染测试。
 */
export function ToolPermissionGrantsCard({
  grants,
  workspaceSlug,
  onRevokeGrant,
  onClearWorkspace,
}: {
  grants: AgentToolPermissionGrantRecord[]
  /** 当前设置页选中的工作区；存在时才提供「清空当前工作区」入口 */
  workspaceSlug?: string
  onRevokeGrant?: (id: string) => void
  onClearWorkspace?: () => void
}) {
  return (
    <section className="lume-panel-padded">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-body font-semibold text-[var(--text-1)]">已授予的工具权限</h3>
          <p className="mt-1 text-caption leading-5 text-[var(--text-3)]">
            Agent 工具审批中点击「始终允许」产生的持久授权，跨线程与重启生效。可逐条撤销。
          </p>
        </div>
        {workspaceSlug && onClearWorkspace && grants.length > 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-[8px]"
            aria-label="清空当前工作区授权"
            onClick={onClearWorkspace}
          >
            <Wand2 size={13} />
            清空当前工作区
          </Button>
        )}
      </div>

      {grants.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-3 py-6 text-center text-body text-[var(--text-3)]">
          暂无已授予的工具权限
        </div>
      ) : (
        <ul className="space-y-2">
          {grants.map((grant) => {
            const scopeMeta = GRANT_SCOPE_META[grant.scope]
            return (
              <li
                key={grant.id}
                className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-ui font-medium text-[var(--text-1)]">{grant.toolName}</span>
                    <span
                      className={cn(
                        'rounded-full border px-1.5 py-0.5 text-micro font-medium',
                        scopeMeta.tone,
                      )}
                    >
                      {describeToolGrantScope(grant.scope)}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-caption text-[var(--text-3)]" title={formatToolGrantSummary(grant)}>
                    {formatToolGrantSummary(grant)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <time className="text-micro text-[var(--text-3)]">{formatGrantTime(grant.createdAt)}</time>
                  {onRevokeGrant && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-[8px] text-[var(--text-3)] hover:text-red-600"
                      aria-label="撤销此授权"
                      onClick={() => onRevokeGrant(grant.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const GRANT_SCOPE_META: Record<AgentToolPermissionAllowScope, { label: string; tone: string }> = {
  exact: { label: '仅此形态', tone: 'border-[var(--border-strong)] text-[var(--text-2)]' },
  command: { label: '命令前缀', tone: 'border-[color:color-mix(in_oklab,var(--brand)_34%,var(--border-strong))] text-[var(--brand)]' },
  tool: { label: '该工具全部调用', tone: 'border-red-500/40 bg-red-500/10 text-red-600' },
}

export function describeToolGrantScope(scope: AgentToolPermissionAllowScope): string {
  return GRANT_SCOPE_META[scope].label
}

/** 撤销面板摘要：宽指纹 [0] 恒为基础指纹，剥掉 `tool:` 前缀后展示 */
export function formatToolGrantSummary(grant: AgentToolPermissionGrantRecord): string {
  const base = grant.fingerprints[0] ?? ''
  const withoutTool = base.startsWith(`${grant.toolName.toLowerCase()}:`)
    ? base.slice(grant.toolName.length + 1)
    : base.replace(/^[^:]+:/, '')
  const scopeSuffix = grant.scope === 'tool' ? '（含后续任意参数）' : ''
  return `${withoutTool}${scopeSuffix}` || '(未记录输入)'
}

function formatGrantTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
