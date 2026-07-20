import { createContext, useContext, type ReactNode } from "react"
import type { FileReferenceBinding, FileReferenceProtocolVersion } from '@lume/shared'

export interface ThreadFileEnv {
  threadId?: string
  workspaceSlug?: string
  fileContextId?: string
}

const ThreadFileEnvContext = createContext<ThreadFileEnv>({})
const MessageFileReferenceBindingContext = createContext<{
  binding?: FileReferenceBinding
  consumerThreadId?: string
  protocolVersion?: FileReferenceProtocolVersion | number
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
  protocolVersion,
  children,
}: {
  value?: FileReferenceBinding
  consumerThreadId?: string
  protocolVersion?: FileReferenceProtocolVersion | number
  children: ReactNode
}) {
  return (
    <MessageFileReferenceBindingContext.Provider value={{ binding: value, consumerThreadId, protocolVersion }}>
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

export function useMessageFileReferenceProtocolVersion(): number | undefined {
  return useContext(MessageFileReferenceBindingContext).protocolVersion
}
