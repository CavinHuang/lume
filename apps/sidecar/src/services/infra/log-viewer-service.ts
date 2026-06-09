import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import type {
  ExportLogsResult,
  LogFileListResult,
  LogLineEntry,
  LogViewerLevel,
  ReadLogFileInput,
  ReadLogFileResult
} from "@lume/shared";
import { getLogsDir } from "./logger";

const LEVEL_BY_PINO_VALUE: Record<number, LogViewerLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal"
};

const LEVEL_LABELS: Record<LogViewerLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  fatal: "FATAL"
};

function getLogFiles(): string[] {
  const directory = getLogsDir();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => isSafeLogFileName(name))
    .sort((a, b) => {
      const aStat = statSync(join(directory, a));
      const bStat = statSync(join(directory, b));
      return bStat.mtimeMs - aStat.mtimeMs || b.localeCompare(a);
    });
}

function isSafeLogFileName(fileName: string): boolean {
  return basename(fileName) === fileName
    && (fileName.endsWith(".log") || fileName.endsWith(".ndjson"))
    && !fileName.includes("..")
    && /^[a-zA-Z0-9._-]+\.(log|ndjson)$/.test(fileName);
}

function resolveLogPath(fileName: string): string {
  if (!isSafeLogFileName(fileName)) {
    throw new Error("日志文件名非法");
  }
  const path = join(getLogsDir(), fileName);
  if (!existsSync(path)) {
    throw new Error(`日志文件不存在: ${fileName}`);
  }
  return path;
}

export function listLogFiles(): LogFileListResult {
  const directory = getLogsDir();
  const files = getLogFiles().map((name) => {
    const stats = statSync(join(directory, name));
    return {
      name,
      sizeBytes: stats.size,
      modifiedAt: new Date(stats.mtimeMs).toISOString()
    };
  });
  return {
    directory,
    files,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0)
  };
}

export function readLogFile(input: ReadLogFileInput): ReadLogFileResult {
  const text = readFileSync(resolveLogPath(input.fileName), "utf-8");
  const rawLines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const allowedLevels = input.levels && input.levels.length > 0 ? new Set(input.levels) : null;
  const query = input.query?.trim().toLowerCase();
  const maxLines = input.maxLines ?? 5000;
  const lines: LogLineEntry[] = [];

  rawLines.forEach((raw, index) => {
    const parsed = parseLogLine(raw);
    if (allowedLevels && !allowedLevels.has(parsed.level)) return;
    if (query && !parsed.text.toLowerCase().includes(query)) return;
    if (lines.length >= maxLines) return;
    lines.push({
      lineNumber: index + 1,
      level: parsed.level,
      text: parsed.text
    });
  });

  return {
    fileName: input.fileName,
    totalLines: rawLines.length,
    matchedLines: rawLines.filter((raw) => {
      const parsed = parseLogLine(raw);
      if (allowedLevels && !allowedLevels.has(parsed.level)) return false;
      return query ? parsed.text.toLowerCase().includes(query) : true;
    }).length,
    lines
  };
}

export function exportAllLogFiles(): ExportLogsResult {
  const directory = getLogsDir();
  const exportDir = join(directory, "exports");
  mkdirSync(exportDir, { recursive: true });
  const fileName = `lume-logs-${safeTimestamp(new Date())}.txt`;
  const exportPath = join(exportDir, fileName);
  const chunks: string[] = [];
  for (const name of getLogFiles().sort((a, b) => a.localeCompare(b))) {
    chunks.push(`===== ${name} =====`);
    chunks.push(readFileSync(join(directory, name), "utf-8").trimEnd());
    chunks.push("");
  }
  writeFileSync(exportPath, chunks.join("\n"), "utf-8");
  const stats = statSync(exportPath);
  return {
    path: exportPath,
    fileName,
    sizeBytes: stats.size
  };
}

function parseLogLine(raw: string): { level: LogViewerLevel; text: string } {
  // Try lume-logger NDJSON first, then pino JSON, then plain text
  const ndjson = parseNdjsonLine(raw);
  if (ndjson) return ndjson;
  const parsed = parsePinoLine(raw);
  if (parsed) return parsed;
  return {
    level: inferPlainLogLevel(raw),
    text: raw
  };
}

/**
 * Parse a lume-logger NDJSON line.
 * lume-logger has `level` as a string (not a number like pino) and uses `ts`/`source`/`context`/`message`.
 */
function parseNdjsonLine(raw: string): { level: LogViewerLevel; text: string } | null {
  if (!raw.trim().startsWith("{")) return null;
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    // lume-logger uses string level; pino uses numeric level
    if (typeof record.level !== "string") return null;
    const level = record.level as LogViewerLevel;
    const time = formatLogTime(record.ts);
    const source = typeof record.source === "string" ? record.source : "unknown";
    const context = typeof record.context === "string" ? record.context : "app";
    const message = typeof record.message === "string" ? record.message : "";

    // Collect extra fields (data + any other top-level keys)
    const skipKeys = new Set(["ts", "level", "source", "context", "message"]);
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!skipKeys.has(key)) {
        extra[key] = value;
      }
    }
    const suffix = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";

    return {
      level,
      text: `[${time}] [${LEVEL_LABELS[level]}] [${source}/${context}] ${message}${suffix}`.trim()
    };
  } catch {
    return null;
  }
}

function parsePinoLine(raw: string): { level: LogViewerLevel; text: string } | null {
  if (!raw.trim().startsWith("{")) return null;
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    const level = typeof record.level === "number" ? LEVEL_BY_PINO_VALUE[record.level] ?? "info" : "info";
    const time = formatLogTime(record.time);
    const context = typeof record.context === "string" ? record.context : "app";
    const message = typeof record.msg === "string" ? record.msg : "";
    const data = Object.fromEntries(Object.entries(record).filter(([key]) => ![
      "level",
      "time",
      "pid",
      "hostname",
      "context",
      "msg"
    ].includes(key)));
    const suffix = Object.keys(data).length > 0 ? `: ${JSON.stringify(data)}` : "";
    return {
      level,
      text: `[${time}] [${LEVEL_LABELS[level]}] [${context}] ${message}${suffix}`.trim()
    };
  } catch {
    return null;
  }
}

function inferPlainLogLevel(raw: string): LogViewerLevel {
  const normalized = raw.toLowerCase();
  if (normalized.includes("[fatal") || normalized.includes(" fatal ")) return "fatal";
  if (normalized.includes("[error") || normalized.includes(" error ")) return "error";
  if (normalized.includes("[warn") || normalized.includes(" warn ")) return "warn";
  if (normalized.includes("[debug") || normalized.includes(" debug ")) return "debug";
  if (normalized.includes("[trace") || normalized.includes(" trace ")) return "trace";
  return "info";
}

function formatLogTime(value: unknown): string {
  const date = typeof value === "number"
    ? new Date(value)
    : typeof value === "string"
      ? new Date(value)
      : new Date();
  if (Number.isNaN(date.getTime())) {
    return String(value ?? "");
  }
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
