// 单属性行输入分发（color/opacity/px/combobox），number input 集成 useScrub（5c）。
// 属性命名 camelCase（对齐 5a styleSnapshotDeclarations 与 Task 61 sectionGroups）：
//   color / backgroundColor 等（endsWith Color）→ color picker + 文本输入
//   opacity → number（step 0.01，min 0 max 1，scrub）
//   px 数值属性 → number（step 1，px 后缀，scrub）：
//     - fontSize / borderRadius / borderWidth / column*
//     - width / height（5c Task 73：dimensions 比例锁需要 scrub）
//     - margin/padding longhand（marginTop 等；shorthand margin 仍走 text 分支）
//   fontFamily / fontWeight / 其他（含 shorthand margin/padding） → combobox（text + datalist）
import type { AgentBrowserDesignDeclaration } from '@lume/shared'
import { useScrub } from './useScrub'

const isColor = (p: string): boolean => p === 'color' || p.endsWith('Color')
const isOpacity = (p: string): boolean => p === 'opacity'
// px 数值属性：dimensions（width/height）+ spacing longhand（marginTop 等）+ 其他 px。
// 5c Task 73：扩展自 fontSize/borderRadius/borderWidth/column* —— 加 width/height 与 spacing longhand，
// 使 Codex bWo locked relationships 联动可经 scrub 触发，且 peer 高亮可覆盖 width:height / marginTop:marginBottom。
// shorthand（margin/padding 单字段）不匹配 → 仍走 text combobox 分支（保留既有行为）。
const isPxNumeric = (p: string): boolean =>
  p === 'fontSize' ||
  p === 'borderRadius' ||
  p === 'borderWidth' ||
  p === 'width' ||
  p === 'height' ||
  p.startsWith('column') ||
  /^(margin|padding)(Top|Right|Bottom|Left)$/.test(p)

export type DeclarationInputProps = {
  declaration: AgentBrowserDesignDeclaration
  onChange: (value: string) => void
  // scrub 激活/结束回调（5c Task 73：DesignEditor 用于 peer 高亮 data-scrub-value-cell/data-peer）。
  onScrubActive?: (active: boolean) => void
}

// 解析 number declaration 的 value/min/max/step（opacity/px 分支共用）。
const parseNumberConfig = (property: string, raw: string): { value: number; min?: number; max?: number; step: number } => {
  const parsed = parseFloat(raw)
  const value = Number.isFinite(parsed) ? parsed : 0
  if (isOpacity(property)) return { value, min: 0, max: 1, step: 0.01 }
  return { value, step: 1 }
}

export function DeclarationInput({ declaration, onChange, onScrubActive }: DeclarationInputProps) {
  const { property, value, previousValue } = declaration

  // number input 共用 scrub hook（opacity + px）。hooks 必须无条件调用，先于任何 return。
  const isNumberInput = isOpacity(property) || isPxNumeric(property)
  const numConfig = isNumberInput ? parseNumberConfig(property, value) : null
  const scrub = useScrub({
    value: numConfig?.value ?? 0,
    min: numConfig?.min,
    max: numConfig?.max,
    step: numConfig?.step ?? 1,
    onChange: (n) => onChange(isPxNumeric(property) ? `${n}px` : `${n}`),
    onScrubActive,
  })

  if (isColor(property)) {
    return (
      <span className="decl-row">
        <input className="decl-color" type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <input className="decl-color-text" type="text" value={value} placeholder={previousValue} onChange={(e) => onChange(e.target.value)} />
      </span>
    )
  }
  if (isOpacity(property)) {
    return <input className="decl-number" type="number" min={0} max={1} step={0.01} value={value} placeholder={previousValue} onChange={(e) => onChange(e.target.value)} onPointerDown={scrub.onPointerDown} />
  }
  if (isPxNumeric(property)) {
    return (
      <span className="decl-row">
        <input className="decl-number" type="number" step={1} value={value.replace(/px$/, '')} placeholder={previousValue.replace(/px$/, '')} onChange={(e) => onChange(`${e.target.value}px`)} onPointerDown={scrub.onPointerDown} />
        <span className="decl-unit">px</span>
      </span>
    )
  }
  return <input className="decl-text" type="text" list="decl-suggestions" value={value} placeholder={previousValue} onChange={(e) => onChange(e.target.value)} />
}
