import { createContext, useContext, type ReactNode } from "react"
import type { FileReferenceBinding } from '@lume/shared'

export interface ThreadFileEnv {
  threadId?: string
  workspaceSlug?: string
  fileContextId?: string
}

const ThreadFileEnvContext = createContext<ThreadFileEnv>({})
const MessageFileReferenceBindingContext = createContext<{
  binding?: FileReferenceBinding
  consumerThreadId?: string
}>({})

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

export function MessageFileReferenceBindingProvider({
  value,
  consumerThreadId,
  children,
}: {
  value?: FileReferenceBinding
  consumerThreadId?: string
  children: ReactNode
}) {
  return (
    <MessageFileReferenceBindingContext.Provider value={{ binding: value, consumerThreadId }}>
      {children}
    </MessageFileReferenceBindingContext.Provider>
  )
}

export function useMessageFileReferenceBinding(): FileReferenceBinding | undefined {
  return useContext(MessageFileReferenceBindingContext).binding
}

export function useMessageFileReferenceConsumerThreadId(): string | undefined {
  return useContext(MessageFileReferenceBindingContext).consumerThreadId
}
