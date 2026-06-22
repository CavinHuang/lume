import { expect, test } from "bun:test";
import { dotProduct, toFloat32Array } from "./vector-math";

// 旧 cosineSimilarity 实现（从 semantic-index.ts / smart-add.ts 原样拷贝），作等价性 oracle。
function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function l2normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vec : vec.map((value) => value / norm);
}

const SAMPLES = [
  [1, 0, 0],
  [0.6, 0.8, 0],
  [0.1, 0.2, 0.3, 0.9],
  [3, 4, 0],
  [-0.5, 0.5, 0.7],
  [1, 2, 3, 4] // 不等长样本，用于 min-length 对齐
];

test("dotProduct 对归一化向量 ≡ 旧 cosineSimilarity（等长，容差 1e-6）", () => {
  for (const a of SAMPLES) {
    for (const b of SAMPLES) {
      if (a.length !== b.length) continue;
      const an = l2normalize(a);
      const bn = l2normalize(b);
      expect(dotProduct(toFloat32Array(an), toFloat32Array(bn))).toBeCloseTo(
        cosineSimilarity(an, bn),
        6
      );
    }
  }
});

test("dotProduct 不等长输入取 min length（前 min 维点积，不重新归一化）", () => {
  // 注：不等长时 dotProduct 与旧 cosineSimilarity 不等价——后者用前 min 维的局部范数
  // 重新归一化。生产中所有 embedding 等长（embedDim 固定），不等长仅作防御性 quirk。
  // 这里验证 dotProduct 自身行为：取前 2 维点积 1*5 + 2*6 = 17，忽略 a 的后 2 维。
  expect(dotProduct(toFloat32Array([1, 2, 3, 4]), toFloat32Array([5, 6]))).toBeCloseTo(17, 6);
});

test("dotProduct 正交向量 = 0", () => {
  expect(dotProduct(toFloat32Array([1, 0]), toFloat32Array([0, 1]))).toBeCloseTo(0, 6);
});

test("dotProduct 归一化向量自比 = 1", () => {
  const v = l2normalize([3, 4, 5]);
  expect(dotProduct(toFloat32Array(v), toFloat32Array(v))).toBeCloseTo(1, 6);
});

test("dotProduct 全零向量 = 0（不抛错）", () => {
  expect(dotProduct(toFloat32Array([0, 0, 0]), toFloat32Array([1, 0, 0]))).toBe(0);
});

test("dotProduct 空向量 = 0", () => {
  expect(dotProduct(toFloat32Array([]), toFloat32Array([1, 2]))).toBe(0);
});

test("toFloat32Array 透传 Float32Array、拷贝 number[]", () => {
  const f32 = new Float32Array([1, 2, 3]);
  expect(toFloat32Array(f32)).toBe(f32);
  expect(toFloat32Array([1, 2, 3])).toEqual(new Float32Array([1, 2, 3]));
});
