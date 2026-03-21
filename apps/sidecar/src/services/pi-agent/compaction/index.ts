/**
 * Compaction 模块统一导出
 */

export {
  getCompactionSettings,
  getStoredCompaction,
  saveStoredCompaction,
  clearStoredCompaction
} from "./compaction-store";

export {
  convertToSessionEntries,
  estimateContextTokensFromLumeMessages,
  runCompaction,
  shouldCompact,
  buildCompactedContextPrompt
} from "./compaction-service";

export type {
  CompactionSettings,
  RunCompactionParams,
  BuildCompactedContextParams
} from "./compaction-service";
