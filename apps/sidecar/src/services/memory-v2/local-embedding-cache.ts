import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_ONNX_MODEL_ID = "Xenova/bge-small-zh-v1.5";
export const LOCAL_ONNX_MODEL_FILENAME = "model_quantized.onnx";

export function getLocalOnnxModelFilePath(cacheDir: string): string {
  return join(cacheDir, ...LOCAL_ONNX_MODEL_ID.split("/"), "onnx", LOCAL_ONNX_MODEL_FILENAME);
}

export function hasLocalOnnxModelFile(cacheDir: string): boolean {
  try {
    const stat = statSync(getLocalOnnxModelFilePath(cacheDir));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function isCorruptLocalOnnxModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /protobuf parsing failed|failed to parse protobuf|invalid protobuf/iu.test(message);
}

export function removeCorruptLocalOnnxModel(cacheDir: string): void {
  rmSync(getLocalOnnxModelFilePath(cacheDir), { force: true });
}
