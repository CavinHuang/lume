import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { getModelMeta } from "@/lib/desktop-api/model"
import { setModelMeta, type ModelMeta } from "@lume/shared"

interface ModelMetaContextValue {
  /** registry 版本号；setModelMeta 后 bump，消费者 useMemo 依赖它触发重算 */
  version: number
  /** 重新加载：传入 generated 直接用，不传则 getModelMeta 拉取；成功后 bump version */
  reload: (generated?: ModelMeta[]) => Promise<void>
}

const ModelMetaContext = createContext<ModelMetaContextValue>({
  version: 0,
  reload: async () => {},
})

/**
 * 应用 generated 更新：非空 → setModelMeta + 返回 true（调用方 bump version）；
 * null → 返回 false（保持 seed，不 bump）。
 * 抽成纯函数便于单测（无需 DOM）。
 */
export function applyModelMetaUpdate(generated: ModelMeta[] | null): boolean {
  if (!generated) return false
  setModelMeta(generated)
  return true
}

export function ModelMetaProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0)

  const reload = useCallback(async (generated?: ModelMeta[]) => {
    const data = generated ?? (await getModelMeta())
    if (applyModelMetaUpdate(data)) {
      setVersion((v) => v + 1)
    }
  }, [])

  // 启动加载（seed 优先）：mount 时异步拉 config dir 数据覆盖 seed；失败保持 seed
  useEffect(() => {
    void reload().catch(() => {
      // sidecar 未就绪/超时/损坏 → 保持 seed，不 bump
    })
  }, [reload])

  const value = useMemo<ModelMetaContextValue>(() => ({ version, reload }), [version, reload])
  return <ModelMetaContext.Provider value={value}>{children}</ModelMetaContext.Provider>
}

/** 消费者用：放入 useMemo 依赖数组，reload 后触发重算 */
export function useModelMetaVersion(): number {
  return useContext(ModelMetaContext).version
}

/** 子项目 B 按钮用：sync 成功后传 newGenerated 触发 setModelMeta + bump */
export function useModelMetaReload(): (generated?: ModelMeta[]) => Promise<void> {
  return useContext(ModelMetaContext).reload
}
