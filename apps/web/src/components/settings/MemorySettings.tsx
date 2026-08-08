import { MemoryAdvancedSettings } from './MemoryAdvancedSettings'

export { PersonaCard, ActivationToggleGroup } from '@/components/memory/MemoryLibraryView'

/** 设置页仅保留记忆运行策略与诊断；日常管理统一进入“记忆与洞察”。 */
export function MemorySettings() {
  return <MemoryAdvancedSettings />
}
