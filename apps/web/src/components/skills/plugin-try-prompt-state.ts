export function buildPluginTryPrompt(pluginId: string): string {
  if (pluginId === 'obsidian-bridge') return '$obsidian-bridge 帮我检查 Obsidian 连接状态。'
  if (pluginId === 'lume-chrome') return '$lume-chrome 说明当前 Chrome 连接状态，并告诉我你能控制什么。'
  return `$${pluginId} 说明这个插件现在可以做什么。`
}
