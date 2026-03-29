/**
 * Workspace Bootstrap Service
 *
 * 复用自 OpenClaw 的 workspace bootstrap 设计
 * 参考来源: 早期工作区 bootstrap 实现
 *
 * 职责：
 * - 读取模板文件
 * - 创建 Bootstrap 文件
 * - 读取 Bootstrap 文件内容
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parseAieos, aieosToSystemPrompt } from "./aieos-identity";
import { fileURLToPath } from "node:url";
import type {
  BootstrapFileType,
  BootstrapFileMeta,
  BootstrapResult,
  SessionType,
  SystemPromptComponents,
  SystemPromptBuildOptions,
  BOOTSTRAP_FILES,
} from "@lume/shared";
import {
  getAgentWorkspacePath,
} from "../infra/config-paths";
import { stripFrontMatter } from "./workspace-template-utils";

// ===== 常量 =====

/**
 * 默认 Bootstrap 文件配置
 */
const BOOTSTRAP_FILE_CONFIGS: BootstrapFileMeta[] = [
  {
    type: 'SOUL',
    filename: 'SOUL.md',
    devFilename: 'SOUL.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'USER',
    filename: 'USER.md',
    devFilename: 'USER.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'IDENTITY',
    filename: 'IDENTITY.md',
    devFilename: 'IDENTITY.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'AGENTS',
    filename: 'AGENTS.md',
    devFilename: 'AGENTS.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'TOOLS',
    filename: 'TOOLS.md',
    devFilename: 'TOOLS.dev.md',
    loadInAllSessions: true,
  },
  {
    type: 'HEARTBEAT',
    filename: 'HEARTBEAT.md',
    loadInAllSessions: true,
  },
  {
    type: 'MEMORY',
    filename: 'MEMORY.md',
    loadInAllSessions: false,
    sessionTypes: ['main'],
  },
  {
    type: 'BOOTSTRAP',
    filename: 'BOOTSTRAP.md',
    loadInAllSessions: false,
    sessionTypes: ['main'],
    deleteAfterFirstRun: true,
  },
];

const CORE_WORKSPACE_FILE_TYPES: BootstrapFileType[] = ['AGENTS', 'SOUL', 'TOOLS', 'IDENTITY', 'USER'];

// ===== 模板路径 =====

/**
 * 获取模板目录路径
 *
 * 模板目录位于项目根目录的 templates/workspace/
 */
function getTemplatesDir(): string {
  // 在 sidecar 中，我们需要找到项目根目录
  // sidecar 位于 apps/sidecar/
  // 模板位于 templates/workspace/
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // 从 apps/sidecar/src/services/system 向上找到项目根目录
  const projectRoot = join(currentDir, '..', '..', '..', '..', '..');
  return join(projectRoot, 'templates', 'workspace');
}

/**
 * 获取模板文件路径
 */
function getTemplatePath(fileType: BootstrapFileType, devMode: boolean = false): string {
  const templatesDir = getTemplatesDir();
  const config = BOOTSTRAP_FILE_CONFIGS.find(c => c.type === fileType);
  if (!config) {
    throw new Error(`未知的 Bootstrap 文件类型: ${fileType}`);
  }

  const filename = devMode && config.devFilename ? config.devFilename : config.filename;
  return join(templatesDir, filename);
}

// ===== 文件操作 =====

/**
 * 读取模板文件内容
 */
export function readTemplateContent(fileType: BootstrapFileType, devMode: boolean = false): string {
  const templatePath = getTemplatePath(fileType, devMode);

  if (!existsSync(templatePath)) {
    console.warn(`[Bootstrap] 模板文件不存在: ${templatePath}`);
    return '';
  }

  try {
    return stripFrontMatter(readFileSync(templatePath, 'utf-8'));
  } catch (error) {
    console.error(`[Bootstrap] 读取模板失败: ${templatePath}`, error);
    return '';
  }
}

function isBrandNewWorkspace(workspaceSlug: string): boolean {
  return CORE_WORKSPACE_FILE_TYPES.every((type) => !bootstrapFileExists(workspaceSlug, type));
}

/**
 * 检查 Bootstrap 文件是否存在
 */
export function bootstrapFileExists(workspaceSlug: string, fileType: BootstrapFileType): boolean {
  const workspacePath = getAgentWorkspacePath(workspaceSlug);
  const config = BOOTSTRAP_FILE_CONFIGS.find(c => c.type === fileType);
  if (!config) return false;

  const filePath = join(workspacePath, config.filename);
  return existsSync(filePath);
}

/**
 * 读取工作区的 Bootstrap 文件内容
 */
export function readBootstrapFile(workspaceSlug: string, fileType: BootstrapFileType): string {
  const workspacePath = getAgentWorkspacePath(workspaceSlug);
  const config = BOOTSTRAP_FILE_CONFIGS.find(c => c.type === fileType);
  if (!config) return '';

  const filePath = join(workspacePath, config.filename);

  if (!existsSync(filePath)) {
    return '';
  }

  try {
    return stripFrontMatter(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.error(`[Bootstrap] 读取文件失败: ${filePath}`, error);
    return '';
  }
}

/**
 * 写入 Bootstrap 文件
 */
export function writeBootstrapFile(
  workspaceSlug: string,
  fileType: BootstrapFileType,
  content: string
): void {
  const workspacePath = getAgentWorkspacePath(workspaceSlug);
  const config = BOOTSTRAP_FILE_CONFIGS.find(c => c.type === fileType);
  if (!config) {
    throw new Error(`未知的 Bootstrap 文件类型: ${fileType}`);
  }

  const filePath = join(workspacePath, config.filename);

  // 确保目录存在
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, content, 'utf-8');
  console.log(`[Bootstrap] 已写入文件: ${filePath}`);
}

/**
 * 删除 Bootstrap 文件
 */
export function deleteBootstrapFile(workspaceSlug: string, fileType: BootstrapFileType): void {
  const workspacePath = getAgentWorkspacePath(workspaceSlug);
  const config = BOOTSTRAP_FILE_CONFIGS.find(c => c.type === fileType);
  if (!config) return;

  const filePath = join(workspacePath, config.filename);

  if (existsSync(filePath)) {
    unlinkSync(filePath);
    console.log(`[Bootstrap] 已删除文件: ${filePath}`);
  }
}

// ===== Bootstrap 创建 =====

/**
 * 确保工作区有 Bootstrap 文件
 *
 * @param workspaceSlug 工作区 slug
 * @param fileTypes 要创建的文件类型列表
 * @param devMode 是否使用开发模式模板
 * @returns 创建结果
 */
export function ensureBootstrapFiles(
  workspaceSlug: string,
  fileTypes: BootstrapFileType[] = ['SOUL', 'USER', 'IDENTITY', 'AGENTS', 'TOOLS', 'BOOTSTRAP'],
  devMode: boolean = false
): BootstrapResult {
  const result: BootstrapResult = {
    created: [],
    skipped: [],
    failed: [],
  };

  const shouldCreateBootstrap = isBrandNewWorkspace(workspaceSlug);

  for (const fileType of fileTypes) {
    const config = BOOTSTRAP_FILE_CONFIGS.find(c => c.type === fileType);
    if (!config) {
      result.failed.push({ file: fileType, error: '未知的文件类型' });
      continue;
    }

    if (fileType === 'BOOTSTRAP' && !shouldCreateBootstrap) {
      result.skipped.push(config.filename);
      continue;
    }

    // 检查文件是否已存在
    if (bootstrapFileExists(workspaceSlug, fileType)) {
      result.skipped.push(config.filename);
      continue;
    }

    // 读取模板内容
    const templateContent = readTemplateContent(fileType, devMode);
    if (!templateContent) {
      result.failed.push({ file: config.filename, error: '模板内容为空或不存在' });
      continue;
    }

    // 写入文件
    try {
      writeBootstrapFile(workspaceSlug, fileType, templateContent);
      result.created.push(config.filename);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.failed.push({ file: config.filename, error: errorMessage });
    }
  }

  console.log(
    `[Bootstrap] 工作区 ${workspaceSlug} Bootstrap 完成: ` +
    `创建 ${result.created.length}, 跳过 ${result.skipped.length}, 失败 ${result.failed.length}`
  );

  return result;
}

// ===== 系统提示词构建 =====

/**
 * 判断文件是否应在指定会话类型中加载
 */
function shouldLoadForSessionType(config: BootstrapFileMeta, sessionType: SessionType): boolean {
  if (config.loadInAllSessions) return true;
  if (!config.sessionTypes || config.sessionTypes.length === 0) return true;
  return config.sessionTypes.includes(sessionType);
}

/**
 * 读取系统提示词组件
 *
 * 根据会话类型决定加载哪些文件
 */
export function readSystemPromptComponents(
  workspaceSlug: string,
  options: SystemPromptBuildOptions
): SystemPromptComponents {
  const { sessionType, includeMemory = true, includeDailyMemory = false } = options;

  const components: SystemPromptComponents = {};

  for (const config of BOOTSTRAP_FILE_CONFIGS) {
    // 检查是否应在当前会话类型中加载
    if (!shouldLoadForSessionType(config, sessionType)) {
      continue;
    }

    // MEMORY 文件特殊处理
    if (config.type === 'MEMORY' && !includeMemory) {
      continue;
    }

    const content = readBootstrapFile(workspaceSlug, config.type);
    if (content) {
      switch (config.type) {
        case 'SOUL':
          components.soul = content;
          break;
        case 'USER':
          components.user = content;
          break;
        case 'IDENTITY':
          components.identity = content;
          break;

        case 'AGENTS':
          components.agents = content;
          break;
        case 'TOOLS':
          components.tools = content;
          break;
        case 'HEARTBEAT':
          components.heartbeat = content;
          break;
        case 'MEMORY':
          components.memory = content;
          break;
      }
    }
  }

  // AIEOS JSON 身份格式支持：检测 IDENTITY.json 或 aieos.json
  if (!components.identity) {
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    for (const jsonFile of ['IDENTITY.json', 'aieos.json']) {
      const jsonPath = resolve(workspacePath, jsonFile);
      if (existsSync(jsonPath)) {
        try {
          const parsed = parseAieos(readFileSync(jsonPath, 'utf-8'));
          const prompt = aieosToSystemPrompt(parsed);
          if (prompt.trim()) {
            components.identity = prompt;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  }

  if (!components.memory && includeMemory) {
    const altMemoryPath = join(getAgentWorkspacePath(workspaceSlug), 'memory.md');
    if (existsSync(altMemoryPath)) {
      try {
        const altMemory = stripFrontMatter(readFileSync(altMemoryPath, 'utf-8'));
        if (altMemory.trim()) {
          components.memory = altMemory;
        }
      } catch (error) {
        console.warn(`[Bootstrap] 读取备用记忆文件失败: ${altMemoryPath}`, error);
      }
    }
  }

  // 读取每日记忆文件（如果需要）
  if (includeDailyMemory) {
    components.dailyMemory = readDailyMemoryFiles(workspaceSlug, options.dailyMemoryDays ?? 2);
  }

  return filterComponentsForSessionType(components, sessionType);
}

export function resolveLoadedLongTermMemoryPath(
  workspaceSlug: string
): "MEMORY.md" | "memory.md" | null {
  const workspacePath = getAgentWorkspacePath(workspaceSlug);
  let entries: Set<string> = new Set();
  try {
    entries = new Set(readdirSync(workspacePath));
  } catch {
    entries = new Set();
  }

  const hasPrimaryExact = entries.has("MEMORY.md");
  const hasAltExact = entries.has("memory.md");

  // 在大小写不敏感文件系统上（如默认 macOS），existsSync("MEMORY.md") 可能命中 memory.md。
  // 这里优先依据目录中的真实文件名，保证提示词显示的文件名与磁盘实际一致。
  if (!hasPrimaryExact && hasAltExact) {
    const altPath = join(workspacePath, "memory.md");
    try {
      if (stripFrontMatter(readFileSync(altPath, "utf-8")).trim()) {
        return "memory.md";
      }
    } catch {
      // ignore read failure
    }
  }

  const primaryPath = join(workspacePath, "MEMORY.md");
  if (existsSync(primaryPath)) {
    try {
      if (stripFrontMatter(readFileSync(primaryPath, "utf-8")).trim()) {
        return "MEMORY.md";
      }
    } catch {
      // ignore read failure
    }
  }

  const altPath = join(workspacePath, "memory.md");
  if (existsSync(altPath)) {
    try {
      if (stripFrontMatter(readFileSync(altPath, "utf-8")).trim()) {
        return "memory.md";
      }
    } catch {
      // ignore read failure
    }
  }

  return null;
}

export function filterComponentsForSessionType(
  components: SystemPromptComponents,
  sessionType: SessionType
): SystemPromptComponents {
  if (sessionType !== "subagent") {
    return components;
  }
  return {
    agents: components.agents,
    tools: components.tools
  };
}

/**
 * 读取每日记忆文件
 *
 * @param workspaceSlug 工作区 slug
 * @param days 读取最近几天的文件（默认 2 天：今天和昨天）
 */
export function readDailyMemoryFiles(workspaceSlug: string, days: number = 2): string {
  const workspacePath = getAgentWorkspacePath(workspaceSlug);
  const memoryDir = join(workspacePath, 'memory');

  if (!existsSync(memoryDir)) {
    return '';
  }

  const contents: string[] = [];
  const today = new Date();
  const formatLocalDate = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = formatLocalDate(date);
    const filePath = join(memoryDir, `${dateStr}.md`);

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim()) {
          contents.push(`## ${dateStr}\n\n${content}`);
        }
      } catch (error) {
        console.warn(`[Bootstrap] 读取每日记忆失败: ${filePath}`, error);
      }
    }
  }

  return contents.join('\n\n---\n\n');
}

/**
 * 构建系统提示词
 *
 * 将各个组件组装成最终的系统提示词
 */
export function buildSystemPrompt(components: SystemPromptComponents): string {
  const sections: string[] = [];

  // 1. 人格定义（最高优先级）
  if (components.soul) {
    sections.push(`## Soul\n\n${components.soul}`);
  }

  // 2. 身份标识
  if (components.identity) {
    sections.push(`## Identity\n\n${components.identity}`);
  }

  // 3. 用户信息
  if (components.user) {
    sections.push(`## User\n\n${components.user}`);
  }

  // 4. 操作指令
  if (components.agents) {
    sections.push(`## Workspace Instructions\n\n${components.agents}`);
  }

  // 5. 工具说明
  if (components.tools) {
    sections.push(`## Tools\n\n${components.tools}`);
  }

  // 6. 长期记忆
  if (components.memory) {
    sections.push(`## Long-Term Memory\n\n${components.memory}`);
  }

  // 7. 每日记忆
  if (components.dailyMemory) {
    sections.push(`## Recent Activity\n\n${components.dailyMemory}`);
  }

  // 8. 心跳任务（如果有）
  if (components.heartbeat) {
    sections.push(`## Heartbeat Tasks\n\n${components.heartbeat}`);
  }

  return sections.join('\n\n---\n\n');
}

// ===== 导出配置 =====

export { BOOTSTRAP_FILE_CONFIGS };
