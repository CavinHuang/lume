import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { TaskContractRecord } from "./task-contract-record-types";

function isWithin(basePath: string, targetPath: string): boolean {
  const base = resolve(basePath);
  const target = resolve(targetPath);
  if (process.platform === "win32") {
    const b = base.toLowerCase();
    const t = target.toLowerCase();
    return t === b || t.startsWith(`${b}${sep}`);
  }
  return target === base || target.startsWith(`${base}${sep}`);
}

export function normalizeThreadPlanFilePath(value: unknown, fallback?: string): string | undefined {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!raw) return undefined;
  const normalized = raw.replace(/\\/g, "/");
  if (
    normalized.startsWith("/")
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error("planFilePath 必须是线程工作区内的相对路径");
  }
  const cleaned = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  if (!cleaned) {
    throw new Error("planFilePath 必须是线程工作区内的相对路径");
  }
  return cleaned;
}

export function writeThreadPlanMarkdownFile(input: {
  threadWorkspaceDir: string;
  contractId: string;
  markdown: string;
  planFilePath?: unknown;
}): string {
  const relativePath = normalizeThreadPlanFilePath(input.planFilePath, `plans/${input.contractId}.md`);
  if (!relativePath) {
    throw new Error("planFilePath 必须是线程工作区内的相对路径");
  }
  const root = resolve(input.threadWorkspaceDir);
  const targetPath = resolve(join(root, relativePath));
  if (!isWithin(root, targetPath)) {
    throw new Error("planFilePath 必须是线程工作区内的相对路径");
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, input.markdown, "utf-8");
  return relativePath;
}

export function verifyThreadPlanMarkdownFile(input: {
  threadWorkspaceDir: string;
  planFilePath: string;
  now?: () => string;
}): NonNullable<TaskContractRecord["planVerification"]> {
  const relativePath = normalizeThreadPlanFilePath(input.planFilePath);
  if (!relativePath) {
    throw new Error("提交审批前必须生成并验证 Markdown 计划文件");
  }
  const root = resolve(input.threadWorkspaceDir);
  const targetPath = resolve(join(root, relativePath));
  if (!isWithin(root, targetPath)) {
    throw new Error("planFilePath 必须是线程工作区内的相对路径");
  }
  const content = readFileSync(targetPath, "utf-8");
  if (!content.trim()) {
    throw new Error("提交审批前必须生成并验证 Markdown 计划文件");
  }
  return {
    verified: true,
    planFilePath: relativePath,
    bytes: Buffer.byteLength(content, "utf-8"),
    checkedAt: input.now?.() ?? new Date().toISOString()
  };
}
