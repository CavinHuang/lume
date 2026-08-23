/**
 * 记忆召回离线评测基线（#298）
 *
 * searchMemoryV2 的排序是多层启发式栈（claim 压制 / kind×意图 boost /
 * 词面重叠 / scope / pinned / stale 罚分），此前没有任何一层有独立评估，
 * 每次调参都是盲调。本文件把「当前排序语义」钉成可执行基线：
 *
 * - 语料固定（writeEntry 直写，绕开提取启发式）
 * - 逐条评测用例 = { 查询, 期望 top-1 }，每行注明钉住评分公式的哪一项
 * - semantic:"off" + 显式 queryPlan 注入 → 完全离线确定性，不依赖 ONNX/LLM
 *
 * 调参流程：改 scoring 前先跑本文件——失败用例即本次调参的语义变化清单，
 * 逐条确认是有意变更后更新期望值。真实查询评测集（30-50 条）在此骨架上扩充。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryV2Store, type MemoryV2Store } from "./markdown-store";
import { searchMemoryV2, type MemoryV2SearchIntent } from "./retrieval";
import type { MemoryV2QueryPlan } from "./claim";

let store: MemoryV2Store;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-eval-"));
  process.env.LUME_CONFIG_DIR = root;
  store = createMemoryV2Store();
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

const NO_HISTORY_PLAN: MemoryV2QueryPlan = {
  querySubject: undefined,
  desiredPredicates: [],
  includeConversationHistory: false,
};

interface EvalCase {
  /** 钉住评分公式的哪一项 */
  layer: string
  query: string
  intent?: MemoryV2SearchIntent
  queryPlan?: MemoryV2QueryPlan
  workspaceSlug?: string
  expectTop: string
}

async function seedCorpus(s: MemoryV2Store): Promise<void> {
  s.writeEntry({
    kind: "decision",
    targetScope: "workspace",
    appliesWhen: { workspaceSlug: "demo" },
    statement: "Memory V2 keeps Markdown files as the source of truth for recall.",
    confidence: "high",
    tags: ["architecture"],
  });
  s.writeEntry({
    kind: "preference",
    targetScope: "global",
    statement: "User prefers short final summaries in chat replies.",
    confidence: "high",
  });
  s.writeEntry({
    kind: "fact",
    targetScope: "global",
    statement: "Production workloads deploy to Frankfurt eu-central-1 region.",
    confidence: "high",
    claim: { subject: "deploy target", predicate: "is", object: "Frankfurt eu-central-1" },
  });
  s.writeEntry({
    kind: "lesson",
    targetScope: "global",
    statement: "Interrupted bun install leaves partial node_modules that must be reinstalled.",
    confidence: "high",
  });
  s.writeEntry({
    kind: "fact",
    targetScope: "global",
    statement: "Production workloads deploy to Paris cdg region after the migration.",
    confidence: "high",
  }, { status: "suspected_stale" });
  s.writeEntry({
    kind: "fact",
    targetScope: "global",
    statement: "Team incident retrospectives are archived in the ops handbook wiki.",
    confidence: "high",
  }, { pinned: true });
  s.writeEntry({
    kind: "state",
    targetScope: "workspace",
    appliesWhen: { workspaceSlug: "demo" },
    statement: "Schema migration batch three is currently in progress on staging.",
    confidence: "high",
  });
}

const EVAL_CASES: EvalCase[] = [
  {
    layer: "kind×intent boost：architecture 查询 decision(+3) 压过无 boost 的 fact/lesson",
    query: "memory architecture source of truth design",
    intent: "architecture",
    workspaceSlug: "demo",
    expectTop: "Memory V2 keeps Markdown files as the source of truth for recall.",
  },
  {
    layer: "kind×intent boost：debug 查询 lesson(+3) 压过同词面的 fact(+1)",
    query: "bun install interrupted broken node_modules recovery",
    intent: "debug",
    expectTop: "Interrupted bun install leaves partial node_modules that must be reinstalled.",
  },
  {
    layer: "stale 过滤阈值：suspected_stale 需 score≥7 才存活，词面平局的 active 孪生胜出",
    query: "production workloads deploy region",
    intent: "general",
    expectTop: "Production workloads deploy to Frankfurt eu-central-1 region.",
  },
  {
    layer: "pinned 兜底：零词面重叠查询仍能召回 pinned 条目",
    query: "where are incident writeups archived afterwards",
    intent: "general",
    expectTop: "Team incident retrospectives are archived in the ops handbook wiki.",
  },
  {
    layer: "workspace scope 加分(+1 vs +0.5)：同分面时 workspace 条目压过 global",
    query: "schema migration batch progress staging",
    intent: "continue_task",
    workspaceSlug: "demo",
    expectTop: "Schema migration batch three is currently in progress on staging.",
  },
  {
    layer: "claim=100 压制：queryPlan 主语命中 claim 的条目无视词面劣势登顶",
    query: "what did we decide about the deploy target",
    queryPlan: {
      querySubject: "deploy target",
      desiredPredicates: ["is"],
      includeConversationHistory: false,
    },
    expectTop: "Production workloads deploy to Frankfurt eu-central-1 region.",
  },
  {
    layer: "中文查询：preference 意图给 preference kind +3",
    query: "用户喜欢什么样的回复总结风格",
    intent: "preference",
    expectTop: "User prefers short final summaries in chat replies.",
  },
  {
    layer: "history boost(+3)：includeConversationHistory 时 state 条目为连续任务供上下文",
    query: "migration batch staging status",
    queryPlan: {
      querySubject: undefined,
      desiredPredicates: [],
      includeConversationHistory: true,
    },
    workspaceSlug: "demo",
    expectTop: "Schema migration batch three is currently in progress on staging.",
  },
];

describe("retrieval eval baseline (#298)", () => {
  test("seed corpus 排序 top-1 全部命中", async () => {
    await seedCorpus(store);
    const failures: string[] = [];
    for (const testCase of EVAL_CASES) {
      const results = await searchMemoryV2({
        workspaceSlug: testCase.workspaceSlug,
        query: testCase.query,
        ...(testCase.intent ? { intent: testCase.intent } : {}),
        ...(testCase.queryPlan ? { queryPlan: testCase.queryPlan } : {}),
        maxResults: 3,
        semantic: "off",
      });
      if (results[0]?.statement !== testCase.expectTop) {
        failures.push(
          `[${testCase.layer}]\n  query: ${testCase.query}\n  want: ${testCase.expectTop}\n  got:  ${results.slice(0, 3).map((item) => `${item.statement} (${item.score})`).join("\n        ")}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test("stale 孪生条目在词面平局下被过滤出召回集", async () => {
    await seedCorpus(store);
    const results = await searchMemoryV2({
      query: "production workloads deploy region",
      maxResults: 5,
      semantic: "off",
    });
    expect(results.some((item) => item.status === "suspected_stale")).toBeFalse();
  });
});
