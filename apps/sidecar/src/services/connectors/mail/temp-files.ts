import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 本层所有临时目录的前缀(protocol/runtime 的 mkdtemp 均以此开头)。 */
export const tempDirPrefix = "oomol-connect-";

const maxFileNameLength = 200;
const maxPreservedExtensionLength = 20;

/**
 * 清扫 crash/SIGKILL 遗留的孤儿临时目录(try/finally 无法覆盖的场景)。
 * 只删 mtime 超过 maxAgeMs 的目录,避开并发进程正在使用的;单条失败静默跳过。
 */
export function sweepOrphanTempDirectories(maxAgeMs = 24 * 60 * 60 * 1000): number {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let swept = 0;
  for (const entry of entries) {
    if (!entry.startsWith(tempDirPrefix)) continue;
    const fullPath = join(tmpdir(), entry);
    try {
      if (statSync(fullPath).mtimeMs < cutoff) {
        rmSync(fullPath, { recursive: true, force: true });
        swept += 1;
      }
    } catch {
      // 并发进程已移除或正在使用:跳过
    }
  }
  return swept;
}

export function sanitizeTempFileName(name: string): string {
  const allowed = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-");
  const sanitized = name
    .trim()
    .split("")
    .map((char) => (allowed.has(char) ? char : "-"))
    .join("");
  const collapsed = collapseRepeatedDash(sanitized);
  const trimmed = trimUnsafeEdges(collapsed);
  return truncateFileName(trimmed || "file");
}

function truncateFileName(name: string): string {
  if (name.length <= maxFileNameLength) {
    return name;
  }

  const extensionStart = name.lastIndexOf(".");
  const extension =
    extensionStart > 0 && name.length - extensionStart <= maxPreservedExtensionLength ? name.slice(extensionStart) : "";
  return `${name.slice(0, maxFileNameLength - extension.length)}${extension}`;
}

function collapseRepeatedDash(value: string): string {
  let result = "";
  let previousWasDash = false;
  for (const char of value) {
    if (char === "-") {
      if (!previousWasDash) {
        result += char;
      }
      previousWasDash = true;
    } else {
      result += char;
      previousWasDash = false;
    }
  }
  return result;
}

function trimUnsafeEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === "-" || value[start] === ".")) {
    start += 1;
  }
  while (end > start && (value[end - 1] === "-" || value[end - 1] === ".")) {
    end -= 1;
  }
  return value.slice(start, end);
}
