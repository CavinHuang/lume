import { readFile, stat } from "node:fs/promises";

/**
 * 产品级"写入前须完整读取"门控（#333/#569）：partial 读不计数、mtime+hash
 * 判新鲜，在 tool-runtime-wrapper 里先于 SDK 工具执行拦截。
 * 分工：本层只管"须完整读"；mtime/size/content 新鲜度由注入各 Agent 的线程级
 * FileStateCache（thread-file-state-cache.ts）负责。记录随线程删除清理
 * （agent-thread-manager），不随单条消息的 run 结束清空——否则跨消息防护失效。
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type FileAccessLedgerRejectReason = "not_read" | "partial_read" | "stale";

export type FileAccessLedgerCheck =
  | { ok: true }
  | { ok: false; reason: FileAccessLedgerRejectReason; message: string };

export interface FileReadRecordInput {
  threadId: string;
  cwd: string;
  filePath: string;
  mtimeMs: number;
  contentHash?: string;
  fullRead: boolean;
  readRange?: { offset: number; limit: number; totalLines?: number };
}

export interface FileWriteCheckInput {
  threadId: string;
  cwd: string;
  filePath: string;
}

export interface FileAccessLedger {
  recordRead(input: FileReadRecordInput): void;
  assertCanOverwrite(input: FileWriteCheckInput): Promise<FileAccessLedgerCheck>;
  clearThread(threadId: string): void;
}

interface FileReadRecord {
  mtimeMs: number;
  contentHash?: string;
  fullRead: boolean;
  readRange?: { offset: number; limit: number; totalLines?: number };
}

export function createFileAccessLedger(): FileAccessLedger {
  const reads = new Map<string, FileReadRecord>();

  return {
    recordRead(input) {
      reads.set(fileLedgerKey(input), {
        mtimeMs: input.mtimeMs,
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
        fullRead: input.fullRead,
        ...(input.readRange ? { readRange: input.readRange } : {})
      });
    },

    async assertCanOverwrite(input) {
      const key = fileLedgerKey(input);
      const record = reads.get(key);
      if (!record) {
        return {
          ok: false,
          reason: "not_read",
          message: "写入已有文件前必须先完整读取该文件。"
        };
      }
      if (!record.fullRead) {
        return {
          ok: false,
          reason: "partial_read",
          message: "该文件只被部分读取，请完整读取后再写入。"
        };
      }
      const current = await stat(resolve(input.cwd, input.filePath));
      if (current.mtimeMs !== record.mtimeMs || (record.contentHash && await hashFile(resolve(input.cwd, input.filePath)) !== record.contentHash)) {
        return {
          ok: false,
          reason: "stale",
          message: "文件在读取后已被修改，请重新读取最新内容后再写入。"
        };
      }
      return { ok: true };
    },

    clearThread(threadId) {
      for (const key of reads.keys()) {
        if (key.startsWith(`${threadId}\0`)) {
          reads.delete(key);
        }
      }
    }
  };
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const runtimeFileAccessLedger = createFileAccessLedger();

export function getRuntimeFileAccessLedger(): FileAccessLedger {
  return runtimeFileAccessLedger;
}

export function clearRuntimeFileAccessLedger(threadId: string): void {
  runtimeFileAccessLedger.clearThread(threadId);
}

function fileLedgerKey(input: { threadId: string; cwd: string; filePath: string }): string {
  return [
    input.threadId,
    resolve(input.cwd),
    resolve(input.cwd, input.filePath)
  ].join("\0");
}
