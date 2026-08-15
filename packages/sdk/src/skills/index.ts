/**
 * Skills Module - Public API
 */

// Types
export type {
  SkillDefinition,
  SkillContentBlock,
  SkillInvocationDescriptor,
  SkillResult,
} from './types.js'
export type {
  ApplySkillImprovementResult,
  SkillImprovementMessage,
  SkillImprovementUpdate,
  SkillModelCallInput,
  SkillUsageInput,
  SkillVersionInfo,
} from './evolution.js'

// Registry
export {
  SkillRegistry,
  registerSkill,
  getSkill,
  getAllSkills,
  getUserInvocableSkills,
  getModelInvocableSkills,
  hasSkill,
  unregisterSkill,
  clearSkills,
  formatSkillsForPrompt,
  renderSkillCatalog,
} from './registry.js'
export {
  analyzeSkillImprovement,
  applySkillImprovement,
  listSkillVersions,
  recordSkillUsage,
  restoreSkillVersion,
} from './evolution.js'

// Bundled skills
export { initBundledSkills } from './bundled/index.js'

export { loadFilesystemSkills } from './fs-loader.js'
