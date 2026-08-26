import { isAbsolute, relative, resolve } from "node:path";
import { analyzeBashCommand, isReadOnlyShellInput } from "@lume/agent-sdk";
import type { LumeToolDescriptor } from "../tools/tool-types";
import { matchesRuntimeToolPolicyEntry } from "../tools/tool-policy-matcher";
import type { PermissionRule } from "./permission-types";

export function extractPermissionCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.prompt ?? record.query;
  return typeof value === "string" && value.trim() ? normalizeWhitespace(value) : undefined;
}

export function extractPermissionPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.path ?? record.notebook_path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractPermissionUrl(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.url ?? record.baseUrl;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildPermissionFingerprint(input: {
  descriptor: LumeToolDescriptor;
  rawInput: unknown;
}): string {
  const command = extractPermissionCommand(input.rawInput);
  const path = extractPermissionPath(input.rawInput);
  const url = extractPermissionUrl(input.rawInput);
  const base = command ?? path ?? stableStringify(input.rawInput);
  // 二轮 review(安全 F2):url 不入指纹会让 prompt 键控工具(web_fetch 类)
  // 按相同文本放行任意主机(SSRF/外带)。url 与主键不同时并入;不同 URL 的
  // 指纹互不为前缀,command 档词边界天然收紧。
  const key = url && url !== base ? `${base}|${url}` : base;
  return `${input.descriptor.canonicalName}:${key}`;
}

export function matchPermissionRule(input: {
  rule: PermissionRule;
  descriptor: LumeToolDescriptor;
  rawInput: unknown;
  cwd?: string;
}): boolean {
  const descriptorTool = input.descriptor.canonicalName;
  if (input.rule.tool !== "*" && !matchesRuntimeToolPolicyEntry(descriptorTool, input.rule.tool)) {
    return false;
  }

  const command = extractPermissionCommand(input.rawInput);
  if (input.rule.commandPattern) {
    if (!command) return false;
    const candidates = permissionCommandCandidates(input.descriptor.canonicalName, command, input.rule.action);
    const matches = candidates.map((candidate) => matchPattern(input.rule.commandPattern!, candidate));
    return input.rule.action === "allow" ? matches.length > 0 && matches.every(Boolean) : matches.some(Boolean);
  }

  const path = extractPermissionPath(input.rawInput);
  if (input.rule.pathPattern) {
    if (!path) return false;
    const absolute = toAbsolutePath(path, input.cwd);
    const relativePath = input.cwd ? relative(toAbsolutePath(input.cwd), absolute) : path;
    return [path, absolute, relativePath]
      .map(normalizePathSeparators)
      .some((candidate) => matchGlobLikePattern(input.rule.pathPattern!, candidate));
  }

  return true;
}

/**
 * shell 连接符/管道/重定向/命令替换字符——command 档的写入侧与匹配侧共用
 * 同一否决口径（#558 二轮 review P1）。
 */
export const COMMAND_CONNECTOR_PATTERN = /[;&|<>`]|\$\(/;

/**
 * #558 review P1:command 档宽指纹的「前缀+词边界」校验可被 shell 连接符后缀
 * 绕过（`git status && curl … | sh` 的 rest 以空白开头照样命中）。与规则表
 * 「unparseable 命令永不获得持久 allow」同一口径：bash 类指纹必须能解析为
 * simple 单命令或经保守只读子集证明，才允许写 command 前缀档；否则降级 exact。
 */
export function allowsCommandScopeGrant(canonicalName: string, key: string): boolean {
  if (canonicalName !== "bash") return true;
  const analysis = analyzeBashCommand(key);
  if (analysis.status === "simple") return true;
  if (isReadOnlyShellInput({ command: key })) return true;
  // 解析器不可用的平台（如部分 Windows 构建 analyzeBashCommand 恒
  // parse-unavailable）退守字符串级检查：含连接符/管道/重定向/命令替换的
  // 一律不给前缀档，纯「命令+参数」形态按前缀授予——不把 #558 弄成全灭。
  if (analysis.status === "parse-unavailable") {
    return !COMMAND_CONNECTOR_PATTERN.test(key);
  }
  return false;
}

function permissionCommandCandidates(toolName: string, command: string, action: PermissionRule["action"]): string[] {
  if (toolName !== "bash") return [command];
  const analysis = analyzeBashCommand(command);
  if (analysis.status === "simple") return analysis.commands.map((segment) => segment.argv.join(" "));
  // An unparseable command must never acquire a persistent automatic allow.
  // Retaining raw matching for deny rules prevents syntax from bypassing a
  // user-configured prohibition while the normal permission flow asks once.
  // Exception（#571 第 3 项连带）: PowerShell 方言命令无法被 bash 语法树解析，
  // 但经保守只读子集证明的命令与 simple 同等可信——allow/ask 规则均可按精确
  // 指纹匹配，否则 Windows 回退 PowerShell 后规则形同虚设。守卫层危险动词表仍兜底。
  if (isReadOnlyShellInput({ command })) return [command];
  return action === "deny" ? [command] : [];
}

export function isPathWithinRoot(path: string, root: string, cwd?: string): boolean {
  const absolutePath = toAbsolutePath(path, cwd);
  const absoluteRoot = toAbsolutePath(root, cwd);
  const rel = relative(absoluteRoot, absolutePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function toAbsolutePath(path: string, cwd?: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd ?? process.cwd(), path);
}

function matchPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return value.startsWith(pattern);
  }
}

function matchGlobLikePattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePathSeparators(pattern);
  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeWhitespace(value: string): string {
  // 三轮 review P1:\n 在 bash 中是命令分隔符,此前折叠成普通空格会让
  // 「npm test\nrm -rf x」与合法参数形态同指纹,写入/匹配双层连接符否诀
  // 全部落空(仅剩守卫层单点兜底)。换行规范为分号保持分隔语义,使
  // COMMAND_CONNECTOR_PATTERN 在写/匹两侧自然命中。
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("; ");
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    ordered[key] = record[key];
  }
  return JSON.stringify(ordered);
}
