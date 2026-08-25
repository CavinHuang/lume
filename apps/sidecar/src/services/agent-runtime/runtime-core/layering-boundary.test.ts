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
// 锚定本文件位置而非 process.cwd():手动直跑(cwd=apps/sidecar 等)与
// run-unit-tests.mjs(cwd=仓库根)均可用(#502 同款直跑健壮性)。
const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
const runtimeRoot = join(
  repositoryRoot,
  "apps/sidecar/src/services/agent-runtime",
);
/** harness 禁止值依赖的平级服务目录(逐域扩展,#297 跟进)。 */
const forbiddenServiceRoots = [
  join(repositoryRoot, "apps/sidecar/src/services/agent"),
  join(repositoryRoot, "apps/sidecar/src/services/channel"),
];
const runnerRoot = join(runtimeRoot, "runner");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
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

// 覆盖:import/export-import、动态 import()、export *(可带 as 别名)与
// export {...}/export type {...} from(#503:此前 export-from 形式不可见)。
const IMPORT_RE =
  /(?:^|\n)\s*(?:export\s+)?import\s+(type\s+)?(?:([\w*${}\s,]+?)\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;

/** 全部 specifier 均为 inline type 时视为纯类型导入/再导出。 */
function hasNonTypeSpecifier(clauseText: string): boolean {
  const specs = clauseText.replace(/[{}]/g, ",").split(",");
  return specs
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((s) => !s.startsWith("type "));
}

function parseImports(source: string): ImportClause[] {
  const clauses: ImportClause[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    if (m[4]) {
      clauses.push({ spec: m[4], isTypeOnly: false, hasValueSpecifiers: true, isDynamic: true });
      continue;
    }
    if (m[7] && m[6]) {
      // export ... from 再导出:`export type {...}` 或全 inline type 花括号 = 纯类型;
      // `*` 必然值依赖。(m[5]=type 前缀 / m[6]=子句 / m[7]=源)
      const isStar = m[6].startsWith("*");
      const typeOnly = Boolean(m[5]) || (!isStar && !hasNonTypeSpecifier(m[6]));
      clauses.push({ spec: m[7], isTypeOnly: typeOnly, hasValueSpecifiers: !typeOnly, isDynamic: false });
      continue;
    }
    if (!m[3]) continue;
    const typeOnly = Boolean(m[1]);
    let hasValue = !typeOnly;
    if (!typeOnly && m[2]) {
      hasValue = hasNonTypeSpecifier(m[2]);
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
  test("agent-runtime 非测试文件不得对禁域服务做值导入(仅放行 import type)", () => {
    const violations: string[] = [];
    for (const file of listTsFiles(runtimeRoot)) {
      const rel = relative(runtimeRoot, file);
      if (/\.test\.ts$|\.bench\.ts$/.test(rel)) continue;
      for (const clause of parseImports(readFileSync(file, "utf-8"))) {
        const target = resolveImportFromFile(file, clause.spec);
        if (!target) continue;
        const intoForbidden = forbiddenServiceRoots.some(
          (root) =>
            target === root ||
            target.startsWith(root + "\\") ||
            target.startsWith(root + "/"),
        );
        if (intoForbidden && clause.hasValueSpecifiers) {
          violations.push(`${rel}: "${clause.spec}"${clause.isDynamic ? " (dynamic)" : ""}`);
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

  // 正控(#503):守卫只断言空违规时,解析器回归会静默瘫痪而 CI 保持绿。
  // 此处钉死 parseImports 对各导入形态的识别——解析器失效即红。
  test("正控:parseImports 能识别全部导入形态", () => {
    const source = [
      'import { valueFn } from "../channel/channel-manager";',
      'import type { ChannelType } from "../channel/types";',
      'import { type MixedType, mixedValue } from "./mixed";',
      'export * from "../../channel/channel-manager";',
      'export * as channelNs from "../../channel/channel-manager";',
      'export { reexported } from "../../channel/channel-manager";',
      'export type { ReexportedType } from "../channel/channel-types";',
      'export { type InlineOnly } from "../channel/channel-types";',
      'const mod = await import("../agent/some-service");',
      'import { x } from "@lume/shared";',
    ].join("\n");
    const clauses = parseImports(source);

    expect(clauses).toHaveLength(10);
    const bySpec = new Map(clauses.map((c) => [c.spec, c]));

    // 静态值导入 → 违规
    expect(bySpec.get("../channel/channel-manager")?.hasValueSpecifiers).toBe(true);
    // 纯类型导入 → 放行
    expect(bySpec.get("../channel/types")).toMatchObject({ isTypeOnly: true, hasValueSpecifiers: false });
    // 混合形式按含值处理
    expect(bySpec.get("./mixed")?.hasValueSpecifiers).toBe(true);
    // export * / export * as / export {} 均被解析且按值再导出(#503 盲区修复;
    // 三条同 spec,Map 保留末条,数量钉死三条均被捕获)
    const exportStarSpecs = clauses.filter((c) => c.spec === "../../channel/channel-manager");
    expect(exportStarSpecs).toHaveLength(3);
    expect(exportStarSpecs.every((c) => c.hasValueSpecifiers && !c.isDynamic)).toBe(true);
    // export type {...} 与全 inline type 花括号 = 纯类型
    expect(bySpec.get("../channel/channel-types")).toMatchObject({ isTypeOnly: true, hasValueSpecifiers: false });
    // 动态 import 被识别(不再豁免)
    expect(bySpec.get("../agent/some-service")).toMatchObject({ isDynamic: true, hasValueSpecifiers: true });
    // 包名导入不参与相对路径判定
    expect(bySpec.get("@lume/shared")).toBeDefined();
  });
});
