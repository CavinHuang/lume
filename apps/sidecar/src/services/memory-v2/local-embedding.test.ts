import { expect, test } from "bun:test";
import { chunkTexts, sliceFlatVectors } from "./local-embedding";

test("chunkTexts 按大小分批（不足一批、刚好、多批）", () => {
  expect(chunkTexts([], 3)).toEqual([]);
  expect(chunkTexts([1, 2], 3)).toEqual([[1, 2]]);
  expect(chunkTexts([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  expect(chunkTexts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});

test("chunkTexts size <= 0 退化保护为 1", () => {
  expect(chunkTexts([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  expect(chunkTexts([1, 2], -1)).toEqual([[1], [2]]);
});

test("sliceFlatVectors 将扁平 batch×embedDim 切回 number[][]", () => {
  // 2 条 × 3 维：[1,2,3 | 4,5,6]
  const flat = new Float32Array([1, 2, 3, 4, 5, 6]);
  expect(sliceFlatVectors(flat, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
});

test("sliceFlatVectors embedDim 非整除时丢弃尾部不足部分", () => {
  // 7 个元素 / 3 维 = 2 条余 1（尾部 1 丢弃）
  const flat = new Float32Array([1, 2, 3, 4, 5, 6, 99]);
  expect(sliceFlatVectors(flat, 3)).toEqual([[1, 2, 3], [4, 5, 6]]);
});

test("sliceFlatVectors embedDim <= 0 返回空", () => {
  expect(sliceFlatVectors(new Float32Array([1, 2, 3]), 0)).toEqual([]);
});

test("sliceFlatVectors 空输入返回空", () => {
  expect(sliceFlatVectors(new Float32Array([]), 3)).toEqual([]);
});
