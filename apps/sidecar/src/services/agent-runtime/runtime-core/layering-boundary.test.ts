import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

/**
 * 分层方向守卫(#289):
 * 1. agent-runtime(harness)不得静态引用应用层 services/agent 的"值"
 *    ——仅允许 `import type`(运行时零依赖);宿主能力一律经 host-ports 注入。
 * 2. runtime-core 不得引用上层 runner(attempt→runner→runtime-core 单向)。
 * 3. model-runtime 不得引用 agent-runtime(#669):thinking-budgets 下沉后
 *    model-runtime 是被 harness 消费的唯一出口,反向值导入会瓦解该分层。
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
// 已知盲区(round1 review 披露):require() 形态(index.ts 自身在用)与
// specifier 为变量的动态 import 不可见——本守卫本质是存量快照冻结器,
// 新增越界须走这两形态才能绕过,code review 时人工留意。
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

  // #578 登记:应用层↔功能域双向禁入边(import type 放行,与上测同规则)。
  // 四组环的存量越界记录在 legacyEdgeExemptions 台账——新增越界即红,逐 PR
  // 消环时同步删豁免;某域对清零后将其升级为硬禁入对。
  const forbiddenBidirectionalPairs: Array<[string, string]> = [
    ["agent", "automation"],
    ["agent", "mcp"],
    ["agent", "im"],
    ["agent", "memory-v2"],
    // review fix(#578 follow-up):im↔agent-runtime 是第五组真实环,此前因
    // 台账的 "agent" 仅指应用层而不可见;存量两条借道边登记进豁免。
    ["agent-runtime", "im"],
  ];

  // review fix(#581/#578 follow-up):本 PR 剪除的单向边当场登记禁入,
  // 防止"宣称的核心成果"处于无绊线状态;两者现值均为零,登记零成本。
  const forbiddenDirectedEdges: Array<[string, string]> = [
    ["channel", "agent-runtime"], // #581:model-refs 下沉后 channel 不再上行 harness
    ["infra", "system"], // #578:proxy 配置经 holder 注入后 infra 不再上行 system
  ];

  /** 存量豁免台账 `<相对 services 的文件路径> => <目标域>`;仅限登记时已知违规。 */
  const legacyEdgeExemptions = new Set<string>([
    "agent/agent-file-ref.ts => memory-v2",
    "agent/agent-files-service.ts => memory-v2",
    "agent/agent-project-lifecycle-service.ts => automation",
    "agent/agent-project-lifecycle-service.ts => im",
    "agent/agent-project-lifecycle-service.ts => mcp",
    "automation/automation-runner-service.ts => agent",
    "im/im-chat-commands.ts => agent",
    "im/im-message-router.ts => agent",
    "im/im-run-card-session.ts => agent", // 上游 #709 批次引入,待后续消环
    "im/im-message-router.ts => agent-runtime", // 会话活性/目录/回滚查询,待端口化
    "agent-runtime/tools/im/create-im-tools.ts => im", // IM 工具天然绑定 im 域
    "mcp/workspace-mcp-manager.ts => agent",
    // memory-v2 两文件的通知借道边(agent-notification-service)已在 #580
    // follow-up 直连 infra 剪除;豁免仍覆盖其深层数据访问边(agent-thread-
    // manager/agent-service 等),待仓储端口化后整条删除。
    "memory-v2/background-extractor.ts => agent",
    "memory-v2/consolidation.ts => agent",
    "memory-v2/dream-evidence.ts => agent",
    "memory-v2/dream-organizer.ts => agent",
    "memory-v2/history-organizer.ts => agent",
    "memory-v2/ingestion.ts => agent",
    "memory-v2/job-recovery.ts => agent",
  ]);

  test("#578 登记:域间值导入不得超出存量豁免台账", () => {
    const servicesRoot = join(repositoryRoot, "apps/sidecar/src/services");
    const violations: string[] = [];
    // 本轮实际命中的边全集:台账活性正控的对照面。
    const observedEdges = new Set<string>();
    for (const file of listTsFiles(servicesRoot)) {
      if (/\.test\.ts$|\.bench\.ts$/.test(file)) continue;
      const relPath = relative(servicesRoot, file).split("\\").join("/");
      const srcDomain = relPath.split("/")[0];
      for (const clause of parseImports(readFileSync(file, "utf-8"))) {
        if (!clause.hasValueSpecifiers) continue;
        const target = resolveImportFromFile(file, clause.spec);
        if (!target || !target.startsWith(servicesRoot)) continue;
        const dstDomain = relative(servicesRoot, dirname(target)).split("\\")[0]?.split("/")[0] ?? "";
        if (dstDomain === srcDomain) continue;
        const paired = forbiddenBidirectionalPairs.some(
          ([a, b]) => (srcDomain === a && dstDomain === b) || (srcDomain === b && dstDomain === a),
        );
        const directed = forbiddenDirectedEdges.some(
          ([src, dst]) => srcDomain === src && dstDomain === dst,
        );
        if (!paired && !directed) continue;
        const edge = `${relPath} => ${dstDomain}`;
        observedEdges.add(edge);
        // 单向绊线不可被台账中和:命中禁入向即违规,豁免只服务双向对存量。
        if (directed) {
          violations.push(`${edge} (单向禁入边,不受豁免保护)`);
        } else if (!legacyEdgeExemptions.has(edge)) {
          violations.push(edge);
        }
      }
    }
    expect(violations).toEqual([]);
    // 台账活性正控:每条豁免必须仍对应一条现存活边——判定逻辑回归(恒空
    // violations)或消环后忘删豁免都会在此变红。
    const stale = [...legacyEdgeExemptions].filter((entry) => !observedEdges.has(entry));
    expect(stale).toEqual([]);
  });

  test("model-runtime 不得引用 agent-runtime(含动态 import,#669)", () => {
    const modelRuntimeRoot = join(repositoryRoot, "apps/sidecar/src/services/model-runtime");
    const violations: string[] = [];
    for (const file of listTsFiles(modelRuntimeRoot)) {
      const rel = relative(modelRuntimeRoot, file);
      if (/\.test\.ts$|\.bench\.ts$/.test(rel)) continue;
      for (const clause of parseImports(readFileSync(file, "utf-8"))) {
        const target = resolveImportFromFile(file, clause.spec);
        if (!target) continue;
        const intoAgentRuntime =
          target === runtimeRoot || target.startsWith(runtimeRoot);
        if (intoAgentRuntime) {
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
