
/** GitHub Release 资源（简化版） */
export interface GitHubRelease {
  /** Release ID */
  id: number;
  /** 标签名（版本号） */
  tag_name: string;
  /** Release 名称 */
  name: string;
  /** 发布说明（Markdown 格式） */
  body: string;
  /** 是否为草稿 */
  draft: boolean;
  /** 是否为预发布版本 */
  prerelease: boolean;
  /** 创建时间 */
  created_at: string;
  /** 发布时间 */
  published_at: string;
  /** Release HTML URL */
  html_url: string;
  /** Release 资源 */
  assets?: GitHubReleaseAsset[];
}

/** GitHub Release 资源 */
export interface GitHubReleaseAsset {
  /** 资源名称 */
  name: string;
  /** 浏览器下载 URL */
  browser_download_url: string;
  /** 资源类型 */
  content_type?: string;
  /** 资源大小 */
  size?: number;
}

/** GitHub Release IPC 通道常量 */
export const GITHUB_RELEASE_IPC_CHANNELS = {
  /** 获取最新 Release */
  GET_LATEST_RELEASE: "github-release:get-latest",
} as const;
