import { stat } from "node:fs/promises";
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
  fullRead: boolean;
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
  fullRead: boolean;
}

export function createFileAccessLedger(): FileAccessLedger {
  const reads = new Map<string, FileReadRecord>();

  return {
    recordRead(input) {
      reads.set(fileLedgerKey(input), {
        mtimeMs: input.mtimeMs,
        fullRead: input.fullRead
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
      if (current.mtimeMs !== record.mtimeMs) {
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
