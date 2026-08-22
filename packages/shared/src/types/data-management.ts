// packages/shared/src/types/data-management.ts

/** 数据类别 key（与概览 4 大类对应） */
export type DataCategoryKey = "core" | "derived" | "business" | "config";

/** 清理键：复用现有 frontendTemp/previewRender/logs，新增 vectorIndex/pluginsCache */
export type DataCleanupKey =
  | "frontendTemp"
  | "previewRender"
  | "logs"
  | "vectorIndex"
  | "pluginsCache";

/** 单个数据类别的展示元信息 */
export interface DataCategoryMeta {
  key: DataCategoryKey;
  label: string;
  subtitle: string;
  /** 是否可重建（决定清理是否需要强确认） */
  rebuildable: boolean;
  /** 是否含敏感凭证（影响导出提示） */
  sensitive: boolean;
}

/** 单个类别的扫描规范：相对 ~/.lume 的路径，可含 `*` 通配（workspace 展开） */
export interface DataCategoryScanSpec {
  key: DataCategoryKey;
  /** 要扫描的相对路径（目录或文件），支持 agent-workspaces 通配（`*` 展开子目录） */
  scanPaths: string[];
  /** 扫描时要排除的相对路径（避免核心/派生重复计数，如核心 memory 排除 memory/index） */
  skipSubdirs: string[];
}

/** 单个类别的体积统计结果 */
export interface DataCategoryStat {
  key: DataCategoryKey;
  bytes: number;
}

/** 存储统计命令返回 */
export interface StorageStats {
  total: number;
  /** 数据根目录绝对路径（~/.lume），供 UI 展示与「打开目录」使用 */
  configDir: string;
  categories: DataCategoryStat[];
}

/** 导出 zip 命令入参 */
export interface ExportZipInput {
  /** 用户通过桌面保存框选择的目标绝对路径 */
  destPath: string;
  /** 是否包含凭证；false 时对所有 .json 做脱敏 */
  includeCredentials: boolean;
}

/** 导出 zip 命令返回 */
export interface ExportZipResult {
  path: string;
  bytes: number;
  fileCount: number;
  credentialsStripped: boolean;
}

/** 清空回收站返回 */
export interface EmptyTrashResult {
  cleanedCount: number;
}

export const DATA_CATEGORY_META: DataCategoryMeta[] = [
  {
    key: "core",
    label: "核心数据",
    subtitle: "记忆 · 会话 · 工作区（不可重建）",
    rebuildable: false,
    sensitive: false,
  },
  {
    key: "derived",
    label: "派生数据",
    subtitle: "向量索引 · 缓存 · 日志（可重建）",
    rebuildable: true,
    sensitive: false,
  },
  {
    key: "business",
    label: "业务数据",
    subtitle: "读书 · 自动化 · 日程",
    rebuildable: false,
    sensitive: false,
  },
  {
    key: "config",
    label: "配置",
    subtitle: "settings · channels · im 等（含凭证）",
    rebuildable: false,
    sensitive: true,
  },
];

/**
 * 扫描规范：顺序即展示顺序。路径相对 ~/.lume。
 * 核心与派生在 memory 上有重叠，故核心 memory 扫描时 skip 掉 memory/index；
 * workspace 同理。`*` 由桌面统计实现展开为 agent-workspaces 下的每个子目录。
 */
export const DATA_CATEGORY_SCAN_SPEC: DataCategoryScanSpec[] = [
  {
    key: "core",
    scanPaths: [
      "memory",
      "MEMORY.md",
      ".meta/memory.sqlite",
      "agent-submissions.sqlite",
      "agent-submissions.sqlite-wal",
      "agent-submissions.sqlite-shm",
      "planning/planning.sqlite",
      "planning/planning.sqlite-wal",
      "planning/planning.sqlite-shm",
      "agent/sessions",
      "agent/runtime-core",
      "agent-workspaces/*/threads",
      "agent-workspaces/*/resources",
      "agent-workspaces/*/memory",
      "agent-workspaces/*/MEMORY.md",
      "agent-workspaces/*/.meta/memory.sqlite",
    ],
    skipSubdirs: ["memory/index", "agent-workspaces/*/memory/index"],
  },
  {
    key: "derived",
    scanPaths: [
      "memory/index",
      "agent-workspaces/*/memory/index",
      "plugins/cache",
      "plugins/data",
      "logs",
      "cache",
    ],
    skipSubdirs: [],
  },
  {
    key: "business",
    scanPaths: ["reading", "routine", "automation"],
    skipSubdirs: [],
  },
  {
    key: "config",
    scanPaths: [
      "settings.json",
      "channels.json",
      "im.json",
      "im-thread-bindings.json",
      "lume.yaml",
      "lume.json",
      "user-profile.json",
      "agent-sessions.json",
      "agent-workspaces.json",
      "session-states.json",
      "skills",
      "default-skills",
    ],
    skipSubdirs: [],
  },
];

/** data_migrate_to_dir 命令返回 */
export interface MigrationResult {
  destPath: string;
  fileCount: number;
  bytesCopied: number;
  verified: boolean;
}

/** data_apply_migration 命令入参 */
export interface MigrationApplyInput {
  /** 迁移目标绝对路径（由 migrate 步骤返回） */
  destPath: string;
  /** true=重启后删除旧目录；false=保留旧目录作备份 */
  deleteOld: boolean;
}
