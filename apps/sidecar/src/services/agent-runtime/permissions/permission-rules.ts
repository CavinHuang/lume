import { isAbsolute, relative, resolve } from "node:path";
import { analyzeBashCommand } from "@lume/agent-sdk";
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

export function buildPermissionFingerprint(input: {
  descriptor: LumeToolDescriptor;
  rawInput: unknown;
}): string {
  const command = extractPermissionCommand(input.rawInput);
  const path = extractPermissionPath(input.rawInput);
  const key = command ?? path ?? stableStringify(input.rawInput);
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

function permissionCommandCandidates(toolName: string, command: string, action: PermissionRule["action"]): string[] {
  if (toolName !== "bash") return [command];
  const analysis = analyzeBashCommand(command);
  if (analysis.status === "simple") return analysis.commands.map((segment) => segment.argv.join(" "));
  // An unparseable command must never acquire a persistent automatic allow.
  // Retaining raw matching for deny rules prevents syntax from bypassing a
  // user-configured prohibition while the normal permission flow asks once.
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
  return value.trim().replace(/\s+/g, " ");
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
