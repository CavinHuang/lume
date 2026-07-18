import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToolDefinition, ToolResult } from "@lume/agent-sdk";
import type { LumeToolDescriptor } from "./tool-types";

const OPAQUE_CODE_KEY = /^(?:command|code|script|expression)$/i;
const WIKI_CAPABILITIES = new Set([
  "wiki.search",
  "wiki.read",
  "wiki.follow_links",
  "wiki.propose_changes",
]);

export interface ProtectedRootDecision {
  blockedPath: string;
  message: string;
  reasonCode: "protected_root";
}

export function evaluateProtectedRootAccess(input: {
  descriptor: LumeToolDescriptor;
  rawInput: unknown;
  cwd: string;
  protectedRoots: string[];
}): ProtectedRootDecision | null {
  if (WIKI_CAPABILITIES.has(input.descriptor.name)) return null;
  const roots = input.protectedRoots.map((root) => canonicalize(root));
  const cwd = canonicalize(input.cwd);
  const cwdRoot = roots.find((root) => isWithin(cwd, root));
  if (cwdRoot) return blocked(cwdRoot);

  for (const candidate of collectPathCandidates(input.rawInput)) {
    const absolute = canonicalize(resolveCandidate(input.cwd, candidate));
    const root = roots.find((item) => isWithin(absolute, item));
    if (root) return blocked(root);
  }

  for (const opaque of collectOpaqueCode(input.rawInput)) {
    const normalized = normalizeText(opaque);
    const root = roots.find((item) => {
      const normalizedRoot = normalizeText(item);
      return normalized.includes(normalizedRoot) || normalized.includes(normalizeText(pathToFileURL(item).href));
    });
    if (root) return blocked(root);
  }
  return null;
}

export function wrapToolWithProtectedRootPolicy(input: {
  descriptor: LumeToolDescriptor;
  tool: ToolDefinition;
  cwd: string;
  protectedRoots: string[];
}): ToolDefinition {
  return {
    ...input.tool,
    runtimeMetadata: {
      ...(input.tool as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata,
      protectedRootWrapped: true,
    },
    async call(rawInput, context) {
      const decision = evaluateProtectedRootAccess({
        descriptor: input.descriptor,
        rawInput,
        cwd: input.cwd,
        protectedRoots: input.protectedRoots,
      });
      if (decision) return errorResult(context.toolUseId, decision.message);
      return input.tool.call(rawInput, context);
    },
  };
}

function collectPathCandidates(value: unknown, key = "", output: string[] = []): string[] {
  if (typeof value === "string") {
    if (isPathKey(key) || isAbsolute(value) || /^file:\/\//i.test(value)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathCandidates(item, key, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectPathCandidates(child, childKey, output);
  }
  return output;
}

function isPathKey(key: string): boolean {
  const normalized = key.replace(/[^a-z]/gi, "").toLocaleLowerCase();
  return normalized === "file" || normalized === "path" || normalized === "paths" || normalized === "root"
    || normalized === "cwd" || normalized === "directory" || normalized === "directories"
    || normalized === "source" || normalized === "destination" || normalized === "target"
    || normalized.endsWith("path") || normalized.endsWith("paths") || normalized.endsWith("directory");
}

function collectOpaqueCode(value: unknown, key = "", output: string[] = []): string[] {
  if (typeof value === "string") {
    if (OPAQUE_CODE_KEY.test(key)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOpaqueCode(item, key, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectOpaqueCode(child, childKey, output);
  }
  return output;
}

function resolveCandidate(cwd: string, value: string): string {
  if (/^file:\/\//i.test(value)) {
    try { return fileURLToPath(value); }
    catch { return value; }
  }
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function canonicalize(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync.native(cursor) : cursor;
  return resolve(base, ...missing);
}

function isWithin(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result));
}

function normalizeText(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLocaleLowerCase();
}

function blocked(root: string): ProtectedRootDecision {
  return {
    blockedPath: root,
    reasonCode: "protected_root",
    message: "Wiki 是受保护知识域，通用文件、命令、MCP 与插件工具不能直接访问；请使用 Wiki capability。",
  };
}

function errorResult(toolUseId: string | undefined, message: string): ToolResult {
  return { type: "tool_result", tool_use_id: toolUseId ?? "", content: message, is_error: true };
}
