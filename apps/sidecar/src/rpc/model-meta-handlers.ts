import { MODEL_META_IPC_CHANNELS } from "@lume/shared"
import { getConfigDir } from "../services/infra/config-paths"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { RpcHandler } from "./types"

/** 运行时 generated.json 文件名（与源码目录同名，语义一致） */
const GENERATED_FILE = "model-meta.generated.json"

/**
 * 无状态 model-meta 数据提供者：只读写 config dir 文件，不持有 registry。
 * GET 返回未 merge 的原始 generated（web 侧 setModelMeta 内统一 merge）；
 * 文件不存在返回 null（首次启动，web 保持 seed）；损坏/权限抛错。
 */
export function createModelMetaHandlers(): Record<string, RpcHandler> {
  return {
    [MODEL_META_IPC_CHANNELS.GET]: async () => {
      const filePath = join(getConfigDir(), GENERATED_FILE)
      try {
        return JSON.parse(await readFile(filePath, "utf8"))
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
  }
}
