/**
 * TS wrapper for native napi module.
 * Simulates the same API shape that @lume/native-logger would expose.
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bun 可以直接 require .node 文件
let native: any;

try {
  // 尝试加载当前平台的 native binary
  const candidates = [
    "./lume-native-logger-verify.darwin-arm64.node",
    "./lume-native-logger-verify.darwin-x64.node",
    "./lume-native-logger-verify.linux-x64-gnu.node",
    "./lume-native-logger-verify.win32-x64-msvc.node",
  ];

  // 搜索路径：__dirname（dev 模式）→ process.execPath 同目录（compile 后）
  const searchDirs = [__dirname, path.dirname(process.execPath)];

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      try {
        native = require(path.resolve(dir, candidate));
        break;
      } catch {
        // try next
      }
    }
    if (native) break;
  }

  if (!native) {
    throw new Error("No platform native binary found");
  }
} catch (err) {
  console.error("[napi-verify] Failed to load native module:", err);
  console.error("[napi-verify] Did you run `bun run build:macos` first?");
  process.exit(1);
}

export const {
  hello,
  emitLog,
  initLogger,
  asyncWriteLog,
  ping,
  emitBatch,
  setupGlobalLogger,
  getLogDir,
} = native;

export type LogInput = {
  level: string;
  source: string;
  context: string;
  message: string;
  data?: string;
};

export type LogResult = {
  written: boolean;
  bytes: number;
};
