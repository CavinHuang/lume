import { MODEL_META_IPC_CHANNELS, buildGeneratedFromCatalog, setModelMeta, type Catalog, type ModelMeta } from "@lume/shared"
import { getConfigDir } from "../services/infra/config-paths"
import { fetchWithProxy } from "../services/infra/proxy-fetch"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RpcHandler } from "./types"

/** 运行时 generated.json 文件名（与源码目录同名，语义一致） */
const GENERATED_FILE = "model-meta.generated.json"

/** models.dev catalog 端点 */
const CATALOG_URL = "https://models.dev/catalog.json"

/** 原子写：先写 .tmp 再 rename 覆盖，避免中途失败污染现有文件 */
async function atomicWriteGenerated(targetPath: string, generated: ModelMeta[]): Promise<void> {
  const tmpPath = `${targetPath}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8")
  await rename(tmpPath, targetPath)
}

/**
 * 无状态 model-meta 数据提供者：只读写 config dir 文件，不持有 registry。
 * GET 返回未 merge 的原始 generated（web 侧 setModelMeta 内统一 merge）；
 * 文件不存在返回 null（首次启动，web 保持 seed）；损坏/权限抛错。
 * SYNC 从 models.dev 拉取 catalog → 生成 generated → 原子写 → 返回未 merge generated。
 */
export function createModelMetaHandlers(): Record<string, RpcHandler> {
  return {
    [MODEL_META_IPC_CHANNELS.GET]: async () => {
      const filePath = join(getConfigDir(), GENERATED_FILE)
      try {
        const generated = JSON.parse(await readFile(filePath, "utf8")) as ModelMeta[]
        setModelMeta(generated)
        return generated
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
    [MODEL_META_IPC_CHANNELS.SYNC]: async () => {
      const res = await fetchWithProxy(CATALOG_URL)
      if (!res.ok) throw new Error(`fetch models.dev: HTTP ${res.status}`)
      const catalog = (await res.json()) as Catalog
      const generated = buildGeneratedFromCatalog(catalog)
      // 空结果说明 catalog 形状非预期（CDN 错误体/API 变更），拒绝落盘——
      // 原子覆盖完好的 generated 层会让用户更新操作静默摧毁数据层（#406）
      if (!Array.isArray(generated) || generated.length === 0) {
        throw new Error("models.dev catalog 解析结果为空，已保留现有 model-meta 数据")
      }
      await atomicWriteGenerated(join(getConfigDir(), GENERATED_FILE), generated)
      setModelMeta(generated)
      return generated
    },
  }
}
