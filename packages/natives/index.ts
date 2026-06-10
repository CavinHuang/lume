/**
 * @lume/natives — High-performance Rust primitives for Lume.
 *
 * Loads the platform-specific .node binary and exposes typed APIs.
 * Falls back gracefully when native binary is unavailable.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────

export interface TokenCountInput {
  text: string | string[];
  model?: string;
}

export interface TokenCountResult {
  count: number;
}

// ── Native loader ──────────────────────────────────────

type NativeModule = {
  countTokens(input: TokenCountInput): TokenCountResult;
};

let _native: NativeModule | null = null;
let _loadError: string | null = null;

function loadNative(): NativeModule | null {
  if (_native !== null || _loadError !== null) return _native;

  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const platform = process.platform;
    const arch = process.arch;

    let binaryName: string;
    if (platform === "darwin" && arch === "arm64") {
      binaryName = "lume-natives.darwin-arm64.node";
    } else if (platform === "darwin" && arch === "x64") {
      binaryName = "lume-natives.darwin-x64.node";
    } else if (platform === "linux" && arch === "x64") {
      binaryName = "lume-natives.linux-x64-gnu.node";
    } else if (platform === "win32" && arch === "x64") {
      binaryName = "lume-natives.win32-x64-msvc.node";
    } else {
      _loadError = `unsupported platform: ${platform}-${arch}`;
      return null;
    }

    const binaryPath = path.join(__dirname, "dist", binaryName);
    _native = require(binaryPath) as unknown as NativeModule;
    return _native;
  } catch (err) {
    _loadError = `failed to load native module: ${err}`;
    return null;
  }
}

export function isNativeAvailable(): boolean {
  return loadNative() !== null;
}

// ── Tokens ─────────────────────────────────────────────

/**
 * Count BPE tokens. Uses O200kBase (GPT-4o) by default.
 * Returns null if native module unavailable.
 */
export function countTokens(input: TokenCountInput): TokenCountResult | null {
  const native = loadNative();
  if (!native) return null;
  return native.countTokens(input);
}

/**
 * Count tokens for a single string. Convenience wrapper.
 * Returns 0 if native module unavailable.
 */
export function countStringTokens(text: string, model?: string): number {
  const result = countTokens({ text, model });
  return result?.count ?? 0;
}
