// 网页内设计编辑器卡片（按 Codex DesignEditorEntry/JUo）：
//   sectionGroup 渲染（dimensions/spacing/flex-spacing/declaration）
//   + DeclarationInput 输入分发
//   + hold-to-view 原视图切换（pointer/keyboard 双通道）
//   + locked relationships（Codex bWo：dimensions 比例锁 width:height + spacing 对边锁 top⇄bottom/left⇄right）
//   + scrub peer 高亮（拖 peer 锁定属性时两 cell 高亮 data-scrub-value-cell + data-peer）
//   + 提交（design-overlay-update 推送全部 declarations / design-overlay-delete）。
// 受控：activeDesignChange 进入态 + onUpdate/onDelete/onToggleOriginalView 回调。
//
// shorthand 简化决策（5a styleSnapshotDeclarations 捕获 shorthand，如 margin/padding 单字段）：
//   不匹配 spacing longhand 正则（marginTop 等）→ 落 declaration section（单行）。
//   不展开 shorthand 为 longhand 4 边（简化，后续优化）。
import { useState } from 'react'
import { deriveSectionGroups } from './sectionGroups'
import { DeclarationInput } from './DeclarationInput'
import type { AgentBrowserAnchor, AgentBrowserDesignDeclaration } from '../../../../packages/shared/src/types/agent'

export type ActiveDesignChange = {
  id: string
  anchor: AgentBrowserAnchor
  declarations: AgentBrowserDesignDeclaration[]
  text?: { previousValue: string; value: string }
  comment?: string
  // Task 74：Alt 多选（Codex §1.3）——host additionalAnchors 透传到 overlay；
  // DesignEditor 仅渲染 + 移除（onRemoveSelection），不在本地编辑。groupId === activeDesignChange.id。
  additionalAnchors?: AgentBrowserAnchor[]
}

type DesignEditorProps = {
  activeDesignChange: ActiveDesignChange
  // 提交回调：推送全部 declarations（5a manager 存全部 activeDesignChange，非 Codex yGo diff）
  onUpdate: (group: ActiveDesignChange) => void
  onDelete: () => void
  // hold-to-view 切换原视图（pointer/keyboard 双通道触发）
  onToggleOriginalView: (enabled: boolean) => void
  // Task 74：Alt 多选移除回调（→ bridge.send remove-annotation-selection{selectionIndex}）。
  // 缺省时 DesignEditor 不渲染 selection 列表（兼容无多选场景）。
  onRemoveSelection?: (selectionIndex: number) => void
}

// locked relationships 状态（Codex bWo）：
//   - dimensions: boolean（width:height 比例锁）
//   - spacing: Record<lockKey, boolean>，lockKey = `${base}:${axis}`（base=margin|padding，axis=vertical|horizontal）
//     vertical 锁 marginTop⇄marginBottom / paddingTop⇄paddingBottom
//     horizontal 锁 marginLeft⇄marginRight / paddingLeft⇄paddingRight
type LockedRelationships = {
  dimensions: boolean
  spacing: Record<string, boolean>
}

// peer 关系映射（spacing 对边 + dimensions 对边）。Codex bWo 实证：拖一个属性时高亮 peer cell。
const SPACING_LONGHAND_RE = /^(margin|padding)(Top|Right|Bottom|Left)$/
const getPeerProperty = (property: string): string | null => {
  if (property === 'width') return 'height'
  if (property === 'height') return 'width'
  const m = SPACING_LONGHAND_RE.exec(property)
  if (!m) return null
  const [, base, side] = m
  const peerSide =
    side === 'Top' ? 'Bottom' : side === 'Bottom' ? 'Top' : side === 'Left' ? 'Right' : 'Left'
  return `${base}${peerSide}`
}

// 计算锁联动 peer 更新值（bWo：单次 setState 批量更新两 declaration）。
// 返回 null 表示无锁联动；返回 {property, value} 表示需同步更新的 peer。
const computePeerUpdate = (
  property: string,
  value: string,
  prev: AgentBrowserDesignDeclaration[],
  locked: LockedRelationships,
  dimensionsRatio: number | null,
): { property: string; value: string } | null => {
  // dimensions 比例锁：改 width → height = width / ratio；改 height → width = height * ratio
  if (locked.dimensions && (property === 'width' || property === 'height')) {
    if (dimensionsRatio == null || dimensionsRatio === 0) return null
    const num = parseFloat(value)
    if (!Number.isFinite(num)) return null
    const peerProp = property === 'width' ? 'height' : 'width'
    const peerNum = property === 'width' ? num / dimensionsRatio : num * dimensionsRatio
    // 仅当 prev 中存在 peer declaration 时才联动（缺一边时不强加）
    if (!prev.some((d) => d.property === peerProp)) return null
    return { property: peerProp, value: formatWithUnit(value, peerNum) }
  }
  // spacing 对边锁：改 one side → 对边同值
  const m = SPACING_LONGHAND_RE.exec(property)
  if (m) {
    const [, base, side] = m
    const axis = side === 'Top' || side === 'Bottom' ? 'vertical' : 'horizontal'
    const lockKey = `${base}:${axis}`
    if (!locked.spacing[lockKey]) return null
    const peerSide =
      side === 'Top' ? 'Bottom' : side === 'Bottom' ? 'Top' : side === 'Left' ? 'Right' : 'Left'
    const peerProp = `${base}${peerSide}`
    if (!prev.some((d) => d.property === peerProp)) return null
    // 对边锁：同值（含单位）
    return { property: peerProp, value }
  }
  return null
}

// 格式化 peer 数值，保留原值的非数字后缀（单位，如 'px'）。
const formatWithUnit = (template: string, newValue: number): string => {
  const unitMatch = template.match(/[^0-9.+-]+$/)
  const unit = unitMatch ? unitMatch[0] : ''
  return `${Math.round(newValue * 100) / 100}${unit}`
}

// 网页内设计编辑器卡片。受控组件：editor 打开时以 activeDesignChange 初始化本地编辑态，
// 提交时通过 onUpdate 把全部 declarations 回传 host（→ bridge.send design-overlay-update）。
export function DesignEditor({ activeDesignChange, onUpdate, onDelete, onToggleOriginalView, onRemoveSelection }: DesignEditorProps) {
  // 本地编辑态：declarations 按 property 单字段更新；comment 空串在提交时归一为 undefined。
  const [declarations, setDeclarations] = useState(activeDesignChange.declarations)
  const [comment, setComment] = useState(activeDesignChange.comment ?? '')
  const groups = deriveSectionGroups(declarations)

  // locked relationships（Codex bWo）：dimensions 比例锁 + spacing 对边锁。
  const [locked, setLocked] = useState<LockedRelationships>({ dimensions: false, spacing: {} })
  // dimensions 比例锁开启时捕获的 width/height 比例（w/h）；null 表示比例不可用（缺一边或非数字）。
  const [dimensionsRatio, setDimensionsRatio] = useState<number | null>(null)
  // peer 高亮：当前 scrub 的 property（null 表示无激活 scrub）。DeclarationInput onScrubActive 透传。
  const [scrubbingProperty, setScrubbingProperty] = useState<string | null>(null)

  // 按属性名更新单条 declaration；若 locked relationships 涉及该属性，单次 setState 批量更新 peer（bWo）。
  const changeValue = (property: string, value: string): void => {
    setDeclarations((prev) => {
      const next = prev.map((d) => (d.property === property ? { ...d, value } : d))
      const peer = computePeerUpdate(property, value, prev, locked, dimensionsRatio)
      if (!peer) return next
      return next.map((d) => (d.property === peer.property ? { ...d, value: peer.value } : d))
    })
  }

  // dimensions 锁切换：开启时捕获当前 width/height ratio（w/h）；关闭时清空 ratio。
  const toggleDimensionsLock = (): void => {
    if (locked.dimensions) {
      setLocked((s) => ({ ...s, dimensions: false }))
      setDimensionsRatio(null)
      return
    }
    const w = parseFloat(declarations.find((d) => d.property === 'width')?.value ?? '')
    const h = parseFloat(declarations.find((d) => d.property === 'height')?.value ?? '')
    const ratio = Number.isFinite(w) && Number.isFinite(h) && h !== 0 ? w / h : null
    setDimensionsRatio(ratio)
    setLocked((s) => ({ ...s, dimensions: ratio != null }))
  }

  // spacing 对边锁切换：lockKey = `${base}:${axis}`（vertical=top⇄bottom, horizontal=left⇄right）。
  const toggleSpacingLock = (lockKey: string): void => {
    setLocked((s) => ({ ...s, spacing: { ...s.spacing, [lockKey]: !s.spacing[lockKey] } }))
  }

  // 提交：回传完整 group（id/anchor/text 透传，declarations 为本地编辑态，comment 空串归一）。
  // Task 74：显式剥离 additionalAnchors —— host 见 group.additionalAnchors 数组时按"追加"语义
  // 处理（design-overlay-update），而 DesignEditor submit 不应追加；剥离后 host 保留现有列表。
  const submit = (): void => {
    const { additionalAnchors: _drop, ...rest } = activeDesignChange
    void _drop
    onUpdate({ ...rest, declarations, comment: comment || undefined })
  }

  // hold-to-view：按下显示原视图，松开恢复设计预览。
  const holdDown = (): void => onToggleOriginalView(true)
  const holdUp = (): void => onToggleOriginalView(false)

  // hold-to-view 键盘通道：Space/Enter 触发（!e.repeat 防止按住连发），其他键忽略。
  const onHoldKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault()
      holdDown()
    }
  }
  const onHoldKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === ' ' || e.key === 'Enter') holdUp()
  }

  // peer 高亮：当前 scrub property 的 peer property（如有）。
  const scrubbingPeer = scrubbingProperty != null ? getPeerProperty(scrubbingProperty) : null
  // cell 是否需要 data-scrub-value-cell / data-peer attr。
  const cellScrubAttr = (property: string): boolean => scrubbingProperty === property
  const cellPeerAttr = (property: string): boolean =>
    scrubbingPeer === property && scrubbingProperty !== property

  // dimensions 锁按钮可用性：需 width 和 height 都存在（缺一边则 ratio 无意义）。
  const hasDimensionsPair =
    declarations.some((d) => d.property === 'width') && declarations.some((d) => d.property === 'height')

  return (
    <div className="design-editor" data-browser-comment-design-editor-stack>
      <div className="design-editor-header">
        <span className="design-editor-title">设计</span>
        <button
          type="button"
          className="design-editor-hold"
          onPointerDown={holdDown}
          onPointerUp={holdUp}
          onPointerCancel={holdUp}
          onKeyDown={onHoldKeyDown}
          onKeyUp={onHoldKeyUp}
        >
          按住看原视图
        </button>
        <button type="button" className="design-editor-delete" onClick={onDelete}>删除</button>
      </div>
      <div className="design-editor-body" data-browser-sidebar-design-scroll-container>
        {groups.map((group, i) => {
          // dimensions：宽 + 高（width/height 任一可能缺失）+ 比例锁按钮（Codex bWo）
          if (group.kind === 'dimensions') {
            return (
              <div key={i} className="design-section">
                <label>尺寸</label>
                <span className="design-section-fields">
                  {group.width && (
                    <span
                      data-property="width"
                      data-scrub-value-cell={cellScrubAttr('width') ? 'true' : undefined}
                      data-peer={cellPeerAttr('width') ? 'true' : undefined}
                    >
                      <span className="design-label">宽</span>
                      <DeclarationInput
                        declaration={group.width}
                        onChange={(v) => changeValue(group.width!.property, v)}
                        onScrubActive={(a) => setScrubbingProperty(a ? group.width!.property : null)}
                      />
                    </span>
                  )}
                  {group.height && (
                    <span
                      data-property="height"
                      data-scrub-value-cell={cellScrubAttr('height') ? 'true' : undefined}
                      data-peer={cellPeerAttr('height') ? 'true' : undefined}
                    >
                      <span className="design-label">高</span>
                      <DeclarationInput
                        declaration={group.height}
                        onChange={(v) => changeValue(group.height!.property, v)}
                        onScrubActive={(a) => setScrubbingProperty(a ? group.height!.property : null)}
                      />
                    </span>
                  )}
                  {hasDimensionsPair && (
                    <button
                      type="button"
                      className="design-lock-btn"
                      data-lock="dimensions"
                      data-locked={locked.dimensions ? 'true' : 'false'}
                      onClick={toggleDimensionsLock}
                      title="锁定宽高比例"
                    >
                      {locked.dimensions ? '🔒 比例' : '🔓 比例'}
                    </button>
                  )}
                </span>
              </div>
            )
          }
          // spacing：margin/padding 4 边 longhand（marginTop 等）；shorthand（margin 单字段）不匹配 → declaration
          // + 对边锁按钮（vertical=top⇄bottom / horizontal=left⇄right，Codex bWo）
          if (group.kind === 'spacing') {
            const base = group.property
            const hasVertical = !!(group.top && group.bottom)
            const hasHorizontal = !!(group.left && group.right)
            const vKey = `${base}:vertical`
            const hKey = `${base}:horizontal`
            return (
              <div key={i} className="design-section">
                <label>{base === 'margin' ? '外边距' : '内边距'}</label>
                <span className="design-section-fields">
                  {(['top', 'right', 'bottom', 'left'] as const).map((side) => {
                    const s = group[side]
                    if (!s) return null
                    const prop = s.property
                    return (
                      <span
                        key={side}
                        data-property={prop}
                        data-scrub-value-cell={cellScrubAttr(prop) ? 'true' : undefined}
                        data-peer={cellPeerAttr(prop) ? 'true' : undefined}
                      >
                        <span className="design-label">{side}</span>
                        <DeclarationInput
                          declaration={s}
                          onChange={(v) => changeValue(prop, v)}
                          onScrubActive={(a) => setScrubbingProperty(a ? prop : null)}
                        />
                      </span>
                    )
                  })}
                  {hasVertical && (
                    <button
                      type="button"
                      className="design-lock-btn"
                      data-lock={vKey}
                      data-locked={locked.spacing[vKey] ? 'true' : 'false'}
                      onClick={() => toggleSpacingLock(vKey)}
                      title="锁定上下边距"
                    >
                      {locked.spacing[vKey] ? '🔒 上下' : '🔓 上下'}
                    </button>
                  )}
                  {hasHorizontal && (
                    <button
                      type="button"
                      className="design-lock-btn"
                      data-lock={hKey}
                      data-locked={locked.spacing[hKey] ? 'true' : 'false'}
                      onClick={() => toggleSpacingLock(hKey)}
                      title="锁定左右边距"
                    >
                      {locked.spacing[hKey] ? '🔒 左右' : '🔓 左右'}
                    </button>
                  )}
                </span>
              </div>
            )
          }
          // flex-spacing：gap / rowGap / columnGap（任一组合）
          if (group.kind === 'flex-spacing') {
            return (
              <div key={i} className="design-section">
                <label>间距</label>
                <span className="design-section-fields">
                  {group.rowGap && (
                    <span>
                      <span className="design-label">行</span>
                      <DeclarationInput declaration={group.rowGap} onChange={(v) => changeValue(group.rowGap!.property, v)} />
                    </span>
                  )}
                  {group.columnGap && (
                    <span>
                      <span className="design-label">列</span>
                      <DeclarationInput declaration={group.columnGap} onChange={(v) => changeValue(group.columnGap!.property, v)} />
                    </span>
                  )}
                  {group.gap && (
                    <span>
                      <span className="design-label">gap</span>
                      <DeclarationInput declaration={group.gap} onChange={(v) => changeValue(group.gap!.property, v)} />
                    </span>
                  )}
                </span>
              </div>
            )
          }
          // declaration：单行属性（color/fontSize/shorthand margin 等）
          return (
            <div key={i} className="design-section">
              <span className="design-label">{group.declaration.property}</span>
              <DeclarationInput declaration={group.declaration} onChange={(v) => changeValue(group.declaration.property, v)} />
            </div>
          )
        })}
        {/* Task 74：Alt 多选渲染（Codex §1.3）——activeDesignChange.additionalAnchors 列表。
            host 是单一来源；DesignEditor 仅渲染 + 移除（onRemoveSelection）。
            渲染条件：onRemoveSelection 存在（5c 已接线）且列表非空。 */}
        {onRemoveSelection && activeDesignChange.additionalAnchors && activeDesignChange.additionalAnchors.length > 0 && (
          <div className="design-section design-selections">
            <label>选区</label>
            <ul className="design-selections-list">
              {activeDesignChange.additionalAnchors.map((additional, index) => (
                <li
                  key={`selection-${index}`}
                  className="design-selection"
                  data-selection-index={index}
                >
                  <span className="design-selection-label">选区 {index + 1}</span>
                  <button
                    type="button"
                    className="design-selection-remove"
                    onClick={() => onRemoveSelection(index)}
                  >
                    ×
                  </button>
                  {/* selector/domPath 仅为调试；不显示给用户 */}
                  <span className="design-selection-target">{additional.selector ?? additional.domPath ?? additional.kind}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <input
        className="design-editor-comment"
        type="text"
        value={comment}
        placeholder="评论（可选）"
        onChange={(e) => setComment(e.target.value.slice(0, 20_000))}
      />
      <button type="button" className="design-editor-submit" onClick={submit}>提交</button>
    </div>
  )
}
