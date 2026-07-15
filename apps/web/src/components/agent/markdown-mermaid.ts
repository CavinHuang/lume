type MarkdownDomNode = {
  type?: string
  name?: string
  data?: string
  attribs?: Record<string, string | undefined>
  children?: unknown[]
}

function asMarkdownDomNode(value: unknown): MarkdownDomNode | null {
  return value !== null && typeof value === 'object' ? value as MarkdownDomNode : null
}

function getNodeText(node: MarkdownDomNode): string {
  if (node.type === 'text') return node.data ?? ''
  return (node.children ?? [])
    .map((child) => asMarkdownDomNode(child))
    .filter((child): child is MarkdownDomNode => child !== null)
    .map(getNodeText)
    .join('')
}

function getFenceLanguage(node: MarkdownDomNode): string | null {
  const infoString = node.attribs?.['data-lang']
  if (infoString?.trim()) return infoString.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? null

  const className = node.attribs?.class
  return className?.match(/(?:^|\s)(?:language|lang)-([^\s]+)/i)?.[1]?.toLowerCase() ?? null
}

function getCodeNodeFromPre(value: unknown): MarkdownDomNode | null {
  const preNode = asMarkdownDomNode(value)
  if (preNode?.name !== 'pre') return null

  return (preNode.children ?? [])
    .map((child) => asMarkdownDomNode(child))
    .find((child) => child?.name === 'code') ?? null
}

export function getMermaidCodeFromPreNode(value: unknown): string | null {
  const codeNode = getCodeNodeFromPre(value)
  if (!codeNode || getFenceLanguage(codeNode) !== 'mermaid') return null

  return getNodeText(codeNode).replace(/\r?\n$/, '')
}

export function isMermaidPreStreaming(value: unknown): boolean {
  const codeNode = getCodeNodeFromPre(value)
  return codeNode?.attribs?.['data-state'] === 'loading'
}
