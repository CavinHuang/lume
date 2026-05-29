import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportAllLogFiles,
  listLogFiles,
  readLogFile
} from "./log-viewer-service";

describe("log-viewer-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";
  let logsDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-log-viewer-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    logsDir = join(tempConfigDir, "logs");
    mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("lists local log files with newest first and ignores non-log files", () => {
    writeFileSync(join(logsDir, "2026-05-28.log"), "old", "utf-8");
    writeFileSync(join(logsDir, "2026-05-29.log"), "new log", "utf-8");
    writeFileSync(join(logsDir, "notes.txt"), "ignore", "utf-8");

    const result = listLogFiles();

    expect(result.files.map((file) => file.name)).toEqual([
      "2026-05-29.log",
      "2026-05-28.log"
    ]);
    expect(result.totalFiles).toBe(2);
    expect(result.totalBytes).toBe(Buffer.byteLength("old") + Buffer.byteLength("new log"));
    expect(result.files[0]).toMatchObject({
      name: "2026-05-29.log",
      sizeBytes: Buffer.byteLength("new log")
    });
  });

  test("reads pino and plain log lines with level and text filters", () => {
    writeFileSync(join(logsDir, "2026-05-29.log"), [
      JSON.stringify({
        level: 30,
        time: "2026-05-29T12:48:09.031Z",
        context: "agent-service",
        msg: "agent started",
        threadId: "thread-1"
      }),
      JSON.stringify({
        level: 40,
        time: "2026-05-29T12:48:10.000Z",
        context: "workspace-mcp-manager",
        msg: "MCP server connection failed",
        serverId: "search"
      }),
      "[sidecar] [app] plain info line"
    ].join("\n"), "utf-8");

    const result = readLogFile({
      fileName: "2026-05-29.log",
      levels: ["warn"],
      query: "mcp"
    });

    expect(result.totalLines).toBe(3);
    expect(result.matchedLines).toBe(1);
    expect(result.lines).toEqual([{
      lineNumber: 2,
      level: "warn",
      text: "[2026-05-29 12:48:10.000] [WARN ] [workspace-mcp-manager] MCP server connection failed: {\"serverId\":\"search\"}"
    }]);
  });

  test("rejects unsafe file names when reading logs", () => {
    expect(() => readLogFile({ fileName: "../settings.json" })).toThrow("日志文件名非法");
  });

  test("exports all log files into one diagnostic text file", () => {
    writeFileSync(join(logsDir, "2026-05-28.log"), "old", "utf-8");
    writeFileSync(join(logsDir, "2026-05-29.log"), "new", "utf-8");

    const result = exportAllLogFiles();

    expect(result.fileName).toEndWith(".txt");
    expect(existsSync(result.path)).toBeTrue();
    const exported = readFileSync(result.path, "utf-8");
    expect(exported).toContain("===== 2026-05-28.log =====");
    expect(exported).toContain("old");
    expect(exported).toContain("===== 2026-05-29.log =====");
    expect(exported).toContain("new");
  });
});
