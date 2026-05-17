import {
  buildPermissionFingerprint,
  extractPermissionCommand,
  extractPermissionPath
} from "./permission-rules";
import type { LumeToolDescriptor } from "../tools/tool-types";

export interface PermissionDenialRecord {
  threadId: string;
  toolName: string;
  fingerprint: string;
  reasonCode: string;
  summary?: string;
  createdAt: number;
}

const MAX_DENIALS_PER_THREAD = 20;
const denialsByThread = new Map<string, PermissionDenialRecord[]>();

export function recordPermissionDenial(input: {
  threadId: string;
  descriptor?: LumeToolDescriptor;
  toolName?: string;
  rawInput: unknown;
  reasonCode: string;
}): void {
  const toolName = input.descriptor?.name ?? input.toolName ?? "unknown_tool";
  const record: PermissionDenialRecord = {
    threadId: input.threadId,
    toolName,
    fingerprint: input.descriptor
      ? buildPermissionFingerprint({
        descriptor: input.descriptor,
        rawInput: input.rawInput
      })
      : `${toolName}:${JSON.stringify(input.rawInput)}`,
    reasonCode: input.reasonCode,
    summary: summarizeDeniedInput(input.rawInput),
    createdAt: Date.now()
  };
  const records = denialsByThread.get(input.threadId) ?? [];
  records.push(record);
  while (records.length > MAX_DENIALS_PER_THREAD) records.shift();
  denialsByThread.set(input.threadId, records);
}

export function getPermissionDeniedSummary(threadId: string): string {
  const records = denialsByThread.get(threadId) ?? [];
  if (records.length === 0) return "";
  return [
    "[已拒绝的工具操作，请勿重复尝试]",
    ...records.map((record) => `- ${record.toolName}: ${record.reasonCode}${record.summary ? ` (${record.summary})` : ""}`)
  ].join("\n");
}

export function clearPermissionDenials(threadId: string): void {
  denialsByThread.delete(threadId);
}

function summarizeDeniedInput(input: unknown): string | undefined {
  const command = extractPermissionCommand(input);
  if (command) return truncate(command);
  const path = extractPermissionPath(input);
  if (path) return truncate(path);
  return undefined;
}

function truncate(value: string): string {
  const maxChars = 120;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
