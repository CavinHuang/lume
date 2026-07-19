export function buildPluginTryPrompt(pluginId: string): string {
  const uri = `lume-plugin://${encodeCapabilityComponent(pluginId)}`
  if (pluginId === 'obsidian-bridge') return `${uri} 帮我检查 Obsidian 连接状态。`
  if (pluginId === 'lume-chrome') return `${uri} 说明当前 Chrome 连接状态，并告诉我你能控制什么。`
  return `${uri} 说明这个插件现在可以做什么。`
}

function encodeCapabilityComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}
