import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * #563:项目级指令文件（CLAUDE.md/AGENTS.md）此前从不加载——在陌生仓库编码时,
 * 构建/测试命令、目录约定等知识为零。会话组装 system prompt 时从 agentCwd
 * 向上探测并注入，体积设上限防止巨型文档挤占上下文。
 */
const PROJECT_INSTRUCTION_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"];
const MAX_PER_FILE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 24_000;
/** 原始读取窗口:截断输出上限 16k 字符(CJK 3B/char≈48KB)已覆盖,超大文件不整读 */
const MAX_RAW_READ_BYTES = 64 * 1024;

export interface ProjectInstructionFile {
  path: string;
  content: string;
}

export function discoverProjectInstructionFiles(agentCwd: string): ProjectInstructionFile[] {
  const found: ProjectInstructionFile[] = [];
  let totalChars = 0;
  let dir = resolve(agentCwd);
  for (;;) {
    for (const fileName of PROJECT_INSTRUCTION_FILE_NAMES) {
      if (totalChars >= MAX_TOTAL_CHARS) break;
      const candidate = join(dir, fileName);
      let raw: string;
      try {
        // #563 review:拒绝符号链接/junction——仓库内链接文件可把任意本地文件读进 prompt
        if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
        raw = readRawHead(candidate);
      } catch {
        // TOCTOU/ACL/EBUSY 等单文件故障只跳过该候选,不终止发现
        continue;
      }
      // 不复用工作区模板清洗(其标题噪声正则会误删真实文档行),仅去 front matter
      const content = stripFrontMatter(raw).trim();
      // 清洗后为空视同不存在,试同目录下一候选
      if (!content) continue;
      const allowed = Math.min(MAX_PER_FILE_CHARS, MAX_TOTAL_CHARS - totalChars);
      const truncated = content.length > allowed;
      const body = `${clipToCharBoundary(content, allowed)}${truncated ? `\n\n[已截断：原文件 ${content.length} 字符]` : ""}`;
      found.push({ path: candidate, content: body });
      totalChars += body.length;
      // 每个目录只取一个指令文件（CLAUDE.md 优先于 AGENTS.md）
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 根级约定在前、就近覆盖在后,符合「越近越具体」的阅读顺序
  return found.reverse();
}

function readRawHead(filePath: string): string {
  const size = lstatSync(filePath).size;
  if (size <= MAX_RAW_READ_BYTES) return readFileSync(filePath, "utf8");
  const buffer = Buffer.alloc(MAX_RAW_READ_BYTES);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, MAX_RAW_READ_BYTES, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function stripFrontMatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** 截断点避开 UTF-16 代理对中缝 */
function clipToCharBoundary(text: string, maxChars: number): string {
  const cut = text.slice(0, maxChars);
  const tail = cut.charCodeAt(cut.length - 1);
  return tail >= 0xd800 && tail <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function buildProjectInstructionsSection(agentCwd?: string): string {
  if (!agentCwd) return "";
  const files = discoverProjectInstructionFiles(agentCwd);
  if (files.length === 0) return "";
  const blocks = files.map((file) => `来源：${file.path}\n\n${file.content}`);
  return [
    "## 项目指令",
    "",
    "以下内容来自当前项目仓库的约定文件，描述该仓库的构建/测试/架构约定。与其余默认习惯冲突时以这里为准（安全与权限规则除外）。",
    "",
    blocks.join("\n\n")
  ].join("\n");
}
