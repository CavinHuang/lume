export interface BrowserSemanticRef {
  backendNodeId: number
  frameId?: string
  name: string
  nth?: number
  ref: string
  role: string
}

export interface BrowserSemanticLine {
  ref?: string
  text: string
}

export interface BrowserSemanticTree {
  lines: BrowserSemanticLine[]
  refs: BrowserSemanticRef[]
}

type AxValue = { value?: unknown }
type AxProperty = { name?: unknown; value?: AxValue }
type AxNode = {
  __frameId?: unknown
  backendDOMNodeId?: unknown
  childIds?: unknown
  ignored?: unknown
  name?: AxValue
  nodeId?: unknown
  properties?: unknown
  role?: AxValue
}

const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "gridcell", "link", "listbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "radio", "scrollbar", "searchbox",
  "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
])

const CONTENT_ROLES = new Set([
  "article", "banner", "cell", "columnheader", "complementary", "contentinfo", "dialog",
  "document", "form", "heading", "img", "list", "listitem", "main", "navigation", "note",
  "paragraph", "region", "row", "rowgroup", "rowheader", "search", "status", "table", "text",
  "toolbar", "tooltip",
])

const STATE_PROPERTIES = new Set(["checked", "disabled", "expanded", "level", "readonly", "required", "selected"])

export function buildBrowserSemanticTree(
  rawNodes: unknown,
  options: {
    interactiveOnly?: boolean
    allocateRef: (input: Omit<BrowserSemanticRef, "ref">) => string
  },
): BrowserSemanticTree {
  const nodes = Array.isArray(rawNodes) ? rawNodes.filter(isAxNode) : []
  const byId = new Map(nodes.flatMap((node) => typeof node.nodeId === "string" ? [[node.nodeId, node] as const] : []))
  const childIds = new Set(nodes.flatMap((node) => axChildIds(node)))
  const roots = nodes.filter((node) => typeof node.nodeId === "string" && !childIds.has(node.nodeId))
  const candidates = nodes.filter((node) => isInteractive(node) && backendNodeId(node) !== undefined)
  const duplicateCounts = countRoleNames(candidates)
  const seenRoleNames = new Map<string, number>()
  const refsByNodeId = new Map<string, BrowserSemanticRef>()

  for (const node of candidates) {
    const nodeId = String(node.nodeId)
    const role = axRole(node)
    const name = axName(node)
    const key = roleNameKey(role, name)
    const nth = seenRoleNames.get(key) ?? 0
    seenRoleNames.set(key, nth + 1)
    const input = {
      backendNodeId: backendNodeId(node)!,
      ...(typeof node.__frameId === "string" ? { frameId: node.__frameId } : {}),
      name,
      ...(duplicateCounts.get(key)! > 1 ? { nth } : {}),
      role,
    }
    refsByNodeId.set(nodeId, { ...input, ref: options.allocateRef(input) })
  }

  const lines: BrowserSemanticLine[] = []
  const visited = new Set<string>()
  const hasInteractiveDescendant = descendantPredicate(byId, refsByNodeId)
  const render = (node: AxNode, depth: number, parentName = "") => {
    const nodeId = typeof node.nodeId === "string" ? node.nodeId : ""
    if (nodeId && visited.has(nodeId)) return
    if (nodeId) visited.add(nodeId)
    const children = axChildIds(node).flatMap((id) => byId.get(id) ?? [])
    const ignored = node.ignored === true
    const role = axRole(node)
    const name = axName(node)
    const ref = nodeId ? refsByNodeId.get(nodeId) : undefined
    const flatten = ignored || role === "none" || role === "presentation" || role === "inlineTextBox" || (role === "generic" && !name)
    const duplicateText = role === "text" && Boolean(name) && name === parentName
    const meaningful = Boolean(ref) || CONTENT_ROLES.has(role) || Boolean(name && role !== "generic")
    const keepForInteractiveTree = !options.interactiveOnly || Boolean(ref) || (nodeId ? hasInteractiveDescendant(nodeId) : false)
    const shouldRender = !flatten && !duplicateText && meaningful && keepForInteractiveTree

    if (shouldRender) {
      lines.push({
        ...(ref ? { ref: ref.ref } : {}),
        text: `${"  ".repeat(depth)}- ${renderNode(node, ref)}`,
      })
    }
    const childDepth = shouldRender ? depth + 1 : depth
    for (const child of children) render(child, childDepth, name || parentName)
  }

  for (const root of roots.length ? roots : nodes.slice(0, 1)) render(root, 0)
  return { lines, refs: [...refsByNodeId.values()] }
}

function renderNode(node: AxNode, ref: BrowserSemanticRef | undefined): string {
  const role = axRole(node)
  const name = axName(node)
  const label = name ? `${role} ${JSON.stringify(name)}` : role
  const states = axProperties(node)
    .flatMap((property) => {
      if (typeof property.name !== "string" || !STATE_PROPERTIES.has(property.name)) return []
      const value = property.value?.value
      if (value === false || value === undefined || value === null || value === "") return []
      return [value === true ? property.name : `${property.name}=${String(value)}`]
    })
  return `${label}${ref ? ` [ref=${ref.ref}]` : ""}${states.map((state) => ` [${state}]`).join("")}`
}

function descendantPredicate(nodes: Map<string, AxNode>, refs: Map<string, BrowserSemanticRef>): (nodeId: string) => boolean {
  const memo = new Map<string, boolean>()
  const visiting = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (memo.has(nodeId)) return memo.get(nodeId)!
    if (visiting.has(nodeId)) return false
    visiting.add(nodeId)
    const result = axChildIds(nodes.get(nodeId)).some((childId) => refs.has(childId) || visit(childId))
    visiting.delete(nodeId)
    memo.set(nodeId, result)
    return result
  }
  return visit
}

function countRoleNames(nodes: AxNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const key = roleNameKey(axRole(node), axName(node))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function roleNameKey(role: string, name: string): string { return `${role}\u0000${name}` }
function isInteractive(node: AxNode): boolean { return INTERACTIVE_ROLES.has(axRole(node)) }
function backendNodeId(node: AxNode): number | undefined { return Number.isInteger(node.backendDOMNodeId) ? Number(node.backendDOMNodeId) : undefined }
function axName(node: AxNode): string { return axString(node.name?.value) }
function axRole(node: AxNode): string {
  const role = axString(node.role?.value)
  if (role === "RootWebArea" || role === "WebArea") return "document"
  if (role === "StaticText") return "text"
  if (role === "InlineTextBox") return "inlineTextBox"
  return role || "generic"
}
function axString(value: unknown): string { return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 500) : "" }
function axChildIds(node: AxNode | undefined): string[] { return Array.isArray(node?.childIds) ? node.childIds.filter((value): value is string => typeof value === "string") : [] }
function axProperties(node: AxNode): AxProperty[] { return Array.isArray(node.properties) ? node.properties.filter((value): value is AxProperty => Boolean(value) && typeof value === "object") : [] }
function isAxNode(value: unknown): value is AxNode { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
