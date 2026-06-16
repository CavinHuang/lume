export const RIGHT_PANEL_MIN_WIDTH = 360
export const RIGHT_PANEL_MAX_WIDTH = 900
export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 0.7
export const RIGHT_PANEL_DEFAULT_WIDTH = 520

export function getRightPanelMaxWidth(viewportWidth: number): number {
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.round(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO))
}

export function clampRightPanelWidth(width: number, viewportWidth: number): number {
  return Math.min(getRightPanelMaxWidth(viewportWidth), Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)))
}

export function getRightPanelDragWidth(input: { clientX: number; viewportWidth: number }): number {
  return clampRightPanelWidth(input.viewportWidth - input.clientX, input.viewportWidth)
}
