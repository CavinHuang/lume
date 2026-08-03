import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chunkTexts, sliceFlatVectors } from "./local-embedding";
import {
  getLocalOnnxModelFilePath,
  hasLocalOnnxModelFile,
  isCorruptLocalOnnxModelError,
  removeCorruptLocalOnnxModel
} from "./local-embedding-cache";

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

test("本地模型缓存只认实际 ONNX 文件，不把配置文件误判为已缓存", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "lume-local-onnx-cache-"));
  try {
    const modelFile = getLocalOnnxModelFilePath(cacheDir);
    mkdirSync(dirname(modelFile), { recursive: true });
    writeFileSync(join(dirname(dirname(modelFile)), "config.json"), "{}");
    expect(hasLocalOnnxModelFile(cacheDir)).toBe(false);

    writeFileSync(modelFile, "onnx");
    expect(hasLocalOnnxModelFile(cacheDir)).toBe(true);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("Protobuf 解析失败会被识别为损坏缓存并只删除模型文件", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "lume-corrupt-onnx-cache-"));
  try {
    const modelFile = getLocalOnnxModelFilePath(cacheDir);
    const configFile = join(dirname(dirname(modelFile)), "config.json");
    mkdirSync(dirname(modelFile), { recursive: true });
    writeFileSync(modelFile, "broken");
    writeFileSync(configFile, "{}");

    expect(isCorruptLocalOnnxModelError(new Error("Load model failed: Protobuf parsing failed."))).toBe(true);
    expect(isCorruptLocalOnnxModelError(new Error("ONNX Runtime native library is unavailable."))).toBe(false);
    removeCorruptLocalOnnxModel(cacheDir);

    expect(existsSync(modelFile)).toBe(false);
    expect(existsSync(configFile)).toBe(true);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
