import { expect, test, describe } from "bun:test";
import { createLocalOnnxMemoryEmbeddingProvider } from "./local-embedding";

// 需要本地已缓存 Xenova/bge-small-zh-v1.5 模型。默认 skip，手动验证时设置：
//   LUME_EMBEDDING_EQUIV_TEST=1 bun test apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts
describe.skipIf(!process.env.LUME_EMBEDDING_EQUIV_TEST)("batch embedding 等价性（需模型）", () => {
  test("一次 batch N 条 ≡ N 次单条 batch 的向量（容差 1e-4）", async () => {
    const embed = createLocalOnnxMemoryEmbeddingProvider();
    const texts = ["用户偏好深色模式", "项目用 TypeScript", "向量检索测试", "周末搬家到上海"];
    const batched = await embed(texts);
    expect(batched.length).toBe(texts.length);
    for (let i = 0; i < texts.length; i += 1) {
      const oneByOne = await embed([texts[i]!]);
      const a = batched[i]!;
      const b = oneByOne[0]!;
      expect(a.length).toBe(b.length);
      for (let d = 0; d < a.length; d += 1) {
        expect(a[d]).toBeCloseTo(b[d]!, 4);
      }
    }
  });
});
