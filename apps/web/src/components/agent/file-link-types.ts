export type FileLinkSource = "thread" | "workspace" | "local"

export interface FileLinkContext {
  source: FileLinkSource
  /** thread/workspace 内相对路径；source==="local" 时为绝对路径 */
  relPath: string
  /** source==="thread" 时必填 */
  threadId?: string
  /** source==="thread" | "workspace" 时必填 */
  workspaceSlug?: string
}
