// 手动基准脚本：bun apps/sidecar/src/services/memory-v2/markdown-store.bench.ts
//
// 复用 markdown-store.test.ts 的 setup 机制：mkdtempSync + process.env.LUME_CONFIG_DIR 指向临时目录，
// 这样 getMemoryV2ScopePaths（经 getStructuredMemoryDir/getWorkspaceMemoryDir）会落在 tmp 目录中。
//
// 测量 N 个 entry 下 M 次 updateEntryStatus（每次 findEntryById(listEntries 读+解析全部文件) + write）的耗时。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryV2Store } from "./markdown-store";

const root = mkdtempSync(join(tmpdir(), "lume-md-store-bench-"));
process.env.LUME_CONFIG_DIR = root;

try {
  const store = createMemoryV2Store();
  const N = 200;
  const entries = [];
  for (let i = 0; i < N; i++) {
    entries.push(store.writeEntry({
      kind: "fact",
      targetScope: "global",
      statement: `基准条目 #${i}`,
      confidence: "medium"
    }));
  }
  const target = entries[N - 1]!;

  const M = 50;
  const start = performance.now();
  for (let i = 0; i < M; i++) {
    store.updateEntryStatus({
      scope: target.frontmatter.scope,
      workspaceSlug: undefined,
      id: target.frontmatter.id,
      status: i % 2 === 0 ? "archived" : "active"
    });
  }
  const elapsed = performance.now() - start;
  console.log(`updateEntryStatus (find+write) x${M} with N=${N} entries: ${elapsed.toFixed(1)}ms`);
  console.log(`avg per call: ${(elapsed / M).toFixed(2)}ms`);
} finally {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
}
