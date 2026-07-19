export const RIGHT_PANEL_MIN_WIDTH = 360
export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 0.7
export const RIGHT_PANEL_DEFAULT_WIDTH = 520
export const FILE_WORKSPACE_WIDE_MIN_WIDTH = 680
export const FILE_TREE_MIN_WIDTH = 220
export const FILE_TREE_MAX_WIDTH = 360
export const FILE_TREE_MIN_PREVIEW_WIDTH = 320
export const FILE_TREE_DEFAULT_WIDTH = 260

export function getRightPanelMaxWidth(viewportWidth: number): number {
  return Math.round(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO)
}

export function clampRightPanelWidth(width: number, viewportWidth: number): number {
  return Math.min(getRightPanelMaxWidth(viewportWidth), Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)))
}

export function getRightPanelDragWidth(input: { clientX: number; viewportWidth: number }): number {
  return clampRightPanelWidth(input.viewportWidth - input.clientX, input.viewportWidth)
}

export function getRightPanelFileTreeMaxWidth(containerWidth: number): number {
  return Math.max(FILE_TREE_MIN_WIDTH, Math.min(FILE_TREE_MAX_WIDTH, Math.round(containerWidth - FILE_TREE_MIN_PREVIEW_WIDTH)))
}

export function isWideFileWorkspace(containerWidth: number): boolean {
  return containerWidth >= FILE_WORKSPACE_WIDE_MIN_WIDTH
}

export function clampRightPanelFileTreeWidth(width: number, containerWidth: number): number {
  return Math.min(getRightPanelFileTreeMaxWidth(containerWidth), Math.max(FILE_TREE_MIN_WIDTH, Math.round(width)))
}

export function getRightPanelFileTreeDragWidth(input: {
  clientX: number
  containerLeft?: number
  containerRight?: number
  containerWidth: number
}): number {
  const width = input.containerLeft === undefined
    ? (input.containerRight ?? input.containerWidth) - input.clientX
    : input.clientX - input.containerLeft
  return clampRightPanelFileTreeWidth(width, input.containerWidth)
}
