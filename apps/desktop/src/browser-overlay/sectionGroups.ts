// 扁平 declarations → 分组 section（移植 Codex AWo @8918022，适配 Lume camelCase）。
// 派生规则：
//   - width/height → dimensions
//   - margin{Top,Right,Bottom,Left} / padding{Top,Right,Bottom,Left} → spacing（property=margin|padding，4 边）
//   - rowGap / columnGap / gap → flex-spacing
//   - 其他 → declaration
// 保持输入顺序，已处理 property 不重复（首次出现决定归属）。
import type { AgentBrowserDesignDeclaration } from '../../../../packages/shared/src/types/agent'

export type SectionGroup =
  | { kind: 'dimensions'; width?: AgentBrowserDesignDeclaration; height?: AgentBrowserDesignDeclaration }
  | { kind: 'spacing'; property: 'margin' | 'padding'; top?: AgentBrowserDesignDeclaration; right?: AgentBrowserDesignDeclaration; bottom?: AgentBrowserDesignDeclaration; left?: AgentBrowserDesignDeclaration }
  | { kind: 'flex-spacing'; rowGap?: AgentBrowserDesignDeclaration; columnGap?: AgentBrowserDesignDeclaration; gap?: AgentBrowserDesignDeclaration }
  | { kind: 'declaration'; declaration: AgentBrowserDesignDeclaration }

// camelCase 长手属性：marginTop / paddingRight / paddingBottom / marginLeft 等
const SPACING_LONGHAND = /^(margin|padding)(Top|Right|Bottom|Left)$/

export function deriveSectionGroups(declarations: AgentBrowserDesignDeclaration[]): SectionGroup[] {
  const map = new Map(declarations.map((decl) => [decl.property, decl]))
  const processed = new Set<string>()
  const groups: SectionGroup[] = []
  for (const decl of declarations) {
    if (processed.has(decl.property)) continue
    if (decl.property === 'width' || decl.property === 'height') {
      const width = map.get('width')
      const height = map.get('height')
      if (width) processed.add('width')
      if (height) processed.add('height')
      groups.push({ kind: 'dimensions', width, height })
      continue
    }
    const spacing = SPACING_LONGHAND.exec(decl.property)
    if (spacing) {
      const [, base] = spacing
      const top = map.get(`${base}Top`)
      const right = map.get(`${base}Right`)
      const bottom = map.get(`${base}Bottom`)
      const left = map.get(`${base}Left`)
      for (const side of [top, right, bottom, left]) {
        if (side) processed.add(side.property)
      }
      groups.push({ kind: 'spacing', property: base as 'margin' | 'padding', top, right, bottom, left })
      continue
    }
    if (decl.property === 'rowGap' || decl.property === 'columnGap' || decl.property === 'gap') {
      const rowGap = map.get('rowGap')
      const columnGap = map.get('columnGap')
      const gap = map.get('gap')
      if (rowGap) processed.add('rowGap')
      if (columnGap) processed.add('columnGap')
      if (gap) processed.add('gap')
      groups.push({ kind: 'flex-spacing', rowGap, columnGap, gap })
      continue
    }
    processed.add(decl.property)
    groups.push({ kind: 'declaration', declaration: decl })
  }
  return groups
}
