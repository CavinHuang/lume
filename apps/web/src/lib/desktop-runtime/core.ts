import {
  createDesktopUnavailableError,
  filePathToFileUrl,
  getDesktopBridge,
} from './bridge'
import { isLumeRpcErrorEnvelope } from '@lume/shared'

export function isDesktopRuntime(): boolean {
  return getDesktopBridge() !== null
}

export async function invoke<T>(command: string, payload?: unknown): Promise<T> {
  const bridge = getDesktopBridge()
  if (!bridge) {
    throw createDesktopUnavailableError(`invoke(${command})`)
  }
  const result = await bridge.invoke<T>(command, payload)
  if (isLumeRpcErrorEnvelope(result)) {
    // #782：main 侧错误经 envelope 保真抵达此处，在 renderer 进程内重建
    // Error——此处 throw 不再跨序列化边界，code 属性对消费方可见。
    const error = new Error(result.message)
    ;(error as Error & { code?: string }).code = result.code
    throw error
  }
  return result
}

export function convertFileSrc(path: string): string {
  const bridge = getDesktopBridge()
  return bridge?.convertFileSrc?.(path) ?? filePathToFileUrl(path)
}
