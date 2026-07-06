export type FileLinkSource = "thread" | "workspace" | "local"

export interface FileLinkContext {
  source: FileLinkSource
  /** thread/workspace 内路径（通常为相对路径；文件树场景会传入绝对路径 entry.path）；source==="local" 时为绝对路径 */
  relPath: string
  /** source==="thread" 时必填 */
  threadId?: string
  /** source==="thread" | "workspace" 时必填 */
  workspaceSlug?: string
}
