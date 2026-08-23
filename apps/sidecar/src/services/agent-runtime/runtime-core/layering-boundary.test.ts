import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

/**
 * 分层方向守卫(#289):
 * 1. agent-runtime(harness)不得静态引用应用层 services/agent 的"值"
 *    ——仅允许 `import type`(运行时零依赖);宿主能力一律经 host-ports 注入。
 * 2. runtime-core 不得引用上层 runner(attempt→runner→runtime-core 单向)。
 * 测试从仓库根运行(run-unit-tests.mjs 已保证 cwd=repositoryRoot)。
 */
const repositoryRoot = process.cwd();
const runtimeRoot = join(
  repositoryRoot,
  "apps/sidecar/src/services/agent-runtime",
);
const appLayerRoot = join(repositoryRoot, "apps/sidecar/src/services/agent");
const runnerRoot = join(runtimeRoot, "runner");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

interface ImportClause {
  spec: string;
  isTypeOnly: boolean;
  /** import { type X, Y }:混合形式按含值导入处理 */
  hasValueSpecifiers: boolean;
  isDynamic: boolean;
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:export\s+)?import\s+(type\s+)?(?:([\w*${}\s,]+?)\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function parseImports(source: string): ImportClause[] {
  const clauses: ImportClause[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    if (m[4]) {
      clauses.push({ spec: m[4], isTypeOnly: false, hasValueSpecifiers: true, isDynamic: true });
      continue;
    }
    if (!m[3]) continue;
    const typeOnly = Boolean(m[1]);
    let hasValue = !typeOnly;
    if (!typeOnly && m[2]) {
      // 全部 specifier 均为 inline type 时视为纯类型导入
      const specs = m[2].replace(/[{}]/g, ",").split(",");
      const real = specs.map((s) => s.trim()).filter((s) => s.length > 0);
      hasValue = real.some((s) => !s.startsWith("type "));
    }
    clauses.push({ spec: m[3], isTypeOnly: typeOnly, hasValueSpecifiers: hasValue, isDynamic: false });
  }
  return clauses;
}

function resolveImportFromFile(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return resolve(dirname(fromFile), spec);
}

describe("分层方向守卫(#289)", () => {
  test("agent-runtime 非测试文件不得对 services/agent 做值导入(仅放行 import type)", () => {
    const violations: string[] = [];
    for (const file of listTsFiles(runtimeRoot)) {
      const rel = relative(runtimeRoot, file);
      if (/\.test\.ts$|\.bench\.ts$/.test(rel)) continue;
      for (const clause of parseImports(readFileSync(file, "utf-8"))) {
        const target = resolveImportFromFile(file, clause.spec);
        if (!target) continue;
        const intoAppLayer =
          target === appLayerRoot ||
          target.startsWith(appLayerRoot + "\\") ||
          target.startsWith(appLayerRoot + "/");
        if (intoAppLayer && clause.hasValueSpecifiers && !clause.isDynamic) {
          violations.push(`${rel}: "${clause.spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("runtime-core 不得引用上层 runner(含动态 import)", () => {
    const coreRoot = join(runtimeRoot, "runtime-core");
    const violations: string[] = [];
    for (const file of listTsFiles(coreRoot)) {
      const rel = relative(runtimeRoot, file);
      if (/\.test\.ts$|\.bench\.ts$/.test(rel)) continue;
      for (const clause of parseImports(readFileSync(file, "utf-8"))) {
        const target = resolveImportFromFile(file, clause.spec);
        if (!target) continue;
        const intoRunner =
          target === runnerRoot || target.startsWith(runnerRoot);
        if (intoRunner) {
          violations.push(`${rel}: "${clause.spec}"${clause.isDynamic ? " (dynamic)" : ""}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
