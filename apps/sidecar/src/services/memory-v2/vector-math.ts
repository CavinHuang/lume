// 共享向量相似度工具。
//
// memory-v2 所有 embedding 路径的向量均已 L2 归一化：
//   - 本地 ONNX worker 输出 normalize:true
//   - OpenAI / Google embedding API 默认返回归一化向量
// 因此余弦相似度退化为点积——省去两次范数计算，且 Float32Array 索引优于 number[]。
// 对【未归一化】的向量，dotProduct 不等于余弦（由 vector-math.test 守护该假设）。

/**
 * 类型归一化：把任意数值数组视图转为 Float32Array（已是 Float32Array 则透传同引用）。
 * 不做数学归一化——调用方需保证向量已 L2 归一化。
 */
export function toFloat32Array(values: ArrayLike<number>): Float32Array {
  return values instanceof Float32Array ? values : new Float32Array(values);
}

/**
 * 归一化向量的相似度（对归一化向量 = 余弦相似度）。
 * 维度不匹配时按较短长度对齐（与旧 cosineSimilarity 实现一致）。
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
  }
  return dot;
}
