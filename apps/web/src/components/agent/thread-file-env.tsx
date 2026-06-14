import { createContext, useContext, type ReactNode } from "react"

export interface ThreadFileEnv {
  threadId?: string
  workspaceSlug?: string
}

const ThreadFileEnvContext = createContext<ThreadFileEnv>({})

export function ThreadFileEnvProvider({
  value,
  children,
}: {
  value: ThreadFileEnv
  children: ReactNode
}) {
  return <ThreadFileEnvContext.Provider value={value}>{children}</ThreadFileEnvContext.Provider>
}

export function useThreadFileEnv(): ThreadFileEnv {
  return useContext(ThreadFileEnvContext)
}
