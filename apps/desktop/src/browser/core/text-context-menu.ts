/**
 * webview 文本右键菜单 —— ZCode Pve/buildTextContextMenuTemplate
 * (提取源 06-ipc-and-wiring.source.js):选中态 → 系统复制项(canCopy 门控)。
 * 纯函数;弹层(Menu.popup)由装配层注入(electron 免依赖)。
 */

export interface TextContextMenuParams {
  selectionText?: string
  editFlags?: { canCopy?: boolean }
  x: number
  y: number
}

export interface TextContextMenuItem {
  role: "copy"
  enabled: boolean
}

/** ZCode Pve:selectionText 非空 → [role:"copy", enabled:editFlags.canCopy]。 */
export function buildTextContextMenuTemplate(params: TextContextMenuParams): TextContextMenuItem[] {
  return params.selectionText && params.selectionText.trim().length > 0
    ? [{ role: "copy", enabled: params.editFlags?.canCopy === true }]
    : []
}
