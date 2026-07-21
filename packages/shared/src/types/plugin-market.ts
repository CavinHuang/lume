import type { AgentPluginDiagnostic, SkillCatalogItem, SkillFileTreeNode } from "./agent"

export type PluginSourceType = "local" | "github" | "subscribed-market" | "legacy"

export type PluginSourceRef =
  | { type: "local"; path: string }
  | {
      type: "github"
      owner: string
      repo: string
      ref: string
      url: string
      subdir?: string
      mirrorArchiveUrl?: string
      mirrorRawBaseUrl?: string
      mirrorReadmeUrl?: string
    }
  | { type: "subscribed-market"; sourceId: string; itemId: string; resolved: PluginSourceRef }
  | { type: "legacy"; path: string }

export type SkillMarketSourceRef =
  | { type: "skill-local"; path: string }
  | { type: "skill-github"; url: string }

export interface PluginMarketSourceRef {
  id: string
  name: string
  kind: "local-index" | "remote-index"
  enabled: boolean
  url?: string
  path?: string
  mirrorUrl?: string
}

export interface PluginMarketMirrorSnapshot {
  schema: "lume-plugin-market-mirror/v1"
  generation: string
  generatedAt: string
  source: {
    owner: string
    repo: string
    ref: string
    commit: string
    url: string
  }
  archivePath: string
  rawBasePath: string
  diagnostics: Array<{ itemId?: string; message: string }>
  plugins: Array<{
    id: string
    name: string
    description?: string
    version?: string
    subdir: string
    manifest: Record<string, unknown>
    readmePath?: string
  }>
  skills: Array<{
    id: string
    name: string
    description?: string
    version?: string
    subdir: string
  }>
}

export interface MarketplaceOwner {
  name: string
  email?: string
}

export interface MarketplacePluginEntry {
  name: string
  description?: string
  version?: string
  source: string
  author?: MarketplaceOwner
}

export interface MarketplaceSkillEntry {
  name: string
  description?: string
  version?: string
  source: string
  author?: MarketplaceOwner
}

export interface MarketplaceManifest {
  name: string
  description?: string
  owner?: MarketplaceOwner
  plugins?: MarketplacePluginEntry[]
  skills?: MarketplaceSkillEntry[]
}

export type MarketInstallState = "not-installed" | "installed" | "update-available"
export type MarketTrustLevel = "trusted" | "review-required" | "blocked-by-default"
export type PluginEnableState = "global-enabled" | "workspace-enabled" | "disabled" | "not-installed" | "needs-review"

export interface PluginCapabilitySummary {
  skillCount: number
  hookEvents: string[]
  mcpServerNames: string[]
  commandToolNames: string[]
}

export interface PluginPermissionSummary {
  filesystemRead: string[]
  filesystemWrite: string[]
  networkOutbound: string[]
  mcpRegister: boolean
  shellAllow: boolean
  toolAllow: string[]
  toolAsk: string[]
  toolDeny: string[]
  hookEvents: string[]
  riskLabels: Array<"shell" | "network" | "write" | "mcp" | "high-risk-tool">
}

export type PluginMarketplaceSetupKind =
  | "install"
  | "enable"
  | "browser-auth"
  | "pairing-code"
  | "local-service"
  | "mcp"
  | "custom"

export type PluginSetupArtifactKind =
  | "chrome-extension"
  | "obsidian-plugin"
  | "native-binary"
  | "node-bundle"
  | "file"

export type PluginSetupPlatform = "win32" | "darwin" | "linux"
export type PluginSetupArch = "x64" | "arm64"

export interface PluginSetupArtifact {
  path: string
  kind: PluginSetupArtifactKind
  platform?: PluginSetupPlatform
  arch?: PluginSetupArch
}

export interface PluginSetupInstaller {
  kind: "chrome-native-host"
  hostName: string
  extensionId: string
  appServerUrl: string
}

export interface PluginSetupDownload {
  url: string
  filename?: string
  sha256?: string
}

export interface PluginSetupBuild {
  command: string
  cwd?: string
  env?: Record<string, string>
  prerequisites?: string
}

export interface PluginSetupTargetApp {
  kind: "chrome" | "obsidian" | "system-path"
  installHint?: string
}

export interface PluginSetupVerify {
  method: "tcp-port" | "chrome-extension" | "http-get" | "none"
  detail?: string
}

export interface PluginMarketplaceAsset {
  path: string
  url?: string
}

export interface PluginMarketplaceSetupStep {
  id: string
  title: string
  description: string
  kind?: PluginMarketplaceSetupKind
  artifact?: PluginSetupArtifact
  artifacts?: PluginSetupArtifact[]
  download?: PluginSetupDownload
  build?: PluginSetupBuild
  installer?: PluginSetupInstaller
  targetApp?: PluginSetupTargetApp
  verify?: PluginSetupVerify
}

export interface PluginMarketplaceMetadata {
  icon?: PluginMarketplaceAsset
  thumbnail?: PluginMarketplaceAsset
  hero?: PluginMarketplaceAsset
  website?: string
  docs?: string
  setup?: PluginMarketplaceSetupStep[]
}

export interface PluginMarketItem {
  id: string
  pluginId: string
  name: string
  displayName?: string
  description?: string
  version: string
  sourceType: PluginSourceType
  trustLevel: MarketTrustLevel
  installState: MarketInstallState
  enableState: PluginEnableState
  installedVersion?: string
  rollbackVersion?: string
  installedPermissionsHash?: string
  capabilities: PluginCapabilitySummary
  permissions: PluginPermissionSummary
  marketplace?: PluginMarketplaceMetadata
  diagnostics?: AgentPluginDiagnostic[]
  /** Opaque identity for this source/catalog snapshot; never use pluginId alone. */
  catalogItemKey?: string
}

export type MarketCatalogItem =
  | { kind: "skill"; skill: SkillCatalogItem }
  | { kind: "plugin"; plugin: PluginMarketItem }

export interface GetMarketCatalogInput {
  workspaceSlug: string
  includeBlockedSources?: boolean
  cacheMode?: "cache-first" | "force-refresh"
}

export interface GetMarketCatalogResult {
  plugins: PluginMarketItem[]
  skills: SkillCatalogItem[]
  diagnostics: AgentPluginDiagnostic[]
  status?: "fresh" | "stale" | "partial" | "failed-with-stale" | "failed"
  syncedAt?: string
  expiresAt?: string
  refreshRecommended?: boolean
  fromStaleCache?: boolean
  sourceDiagnostics?: Array<{ sourceId: string; status: "fresh" | "stale" | "failed"; message?: string }>
}

export interface GetMarketDetailInput {
  workspaceSlug: string
  kind: "plugin" | "skill"
  itemId: string
}

export type InspectMarketSourceRef = PluginSourceRef | SkillMarketSourceRef | { type: "market-item"; sourceId: string; itemId: string }

export interface InspectMarketSourceInput {
  workspaceSlug: string
  source: InspectMarketSourceRef
}

export interface InspectPluginResult {
  kind: "plugin"
  normalized: {
    pluginId: string
    name: string
    version: string
    manifestFormat?: "lume" | "codex" | "legacy"
    displayName?: string
    description?: string
  }
  permissionSummary: PluginPermissionSummary
  permissionsHash: string
  installState: MarketInstallState
  enableState: PluginEnableState
  diagnostics: AgentPluginDiagnostic[]
}

export interface InspectSkillResult {
  kind: "skill"
  item: SkillCatalogItem
  fileTree?: SkillFileTreeNode[]
}

export type InspectMarketSourceResult = InspectPluginResult | InspectSkillResult

export interface InstallMarketItemInput {
  workspaceSlug: string
  kind: "plugin" | "skill"
  itemId?: string
  source?: InspectMarketSourceRef
  overwrite?: boolean
  enableScope?: "none" | "workspace" | "global"
  acceptedPermissionsHash?: string
  catalogItemKey?: string
}

export interface PreparePluginPackageInput {
  workspaceSlug: string
  catalogItemKey: string
  setupStepId: string
}

export interface PreparePluginPackageResult {
  token: string
  kind: "file" | "directory"
  suggestedFilename: string
  version?: string
  size: number
  source: string
  verification: "verified" | "unverified"
  sha256: string
  finalOrigin?: string
  originChanged?: boolean
  installer?: PluginSetupInstaller
}

export interface FinalizePluginPackageInput {
  token: string
  ownerWebContentsId: number
  ownerGeneration: number
  targetPath: string
  overwrite?: boolean
}

export interface RevokePluginPackageInput {
  token: string
  ownerWebContentsId: number
  ownerGeneration: number
}

export interface SavePluginPackageResult {
  status: "saved" | "cancelled"
  savedPath?: string
  verification?: "verified" | "unverified"
}

export interface InstallPluginPackageResult {
  status: "installed"
  hostName: string
  hostPath: string
  manifestPath: string
}

export interface PluginPackageProgress {
  operationId: string
  phase: "preparing" | "downloading" | "extracting" | "ready" | "saving" | "complete" | "failed"
  downloaded?: number
  total?: number
}

export interface InstallMarketItemResult {
  kind: "plugin" | "skill"
  id: string
  version?: string
  installed: boolean
  enableState?: PluginEnableState
  diagnostics?: AgentPluginDiagnostic[]
}

export interface UpdatePluginInput {
  workspaceSlug: string
  pluginId: string
  source?: PluginSourceRef
  targetVersion?: string
  acceptedPermissionsHash?: string
  force?: boolean
}

export interface UpdatePluginResult {
  pluginId: string
  installedVersion: string
  activeVersion: string
  previousActiveVersion?: string
  retainedVersions: string[]
  activated: boolean
  needsReview: boolean
  diagnostics?: AgentPluginDiagnostic[]
}

export interface SetPluginEnablementInput {
  workspaceSlug?: string
  pluginId: string
  version?: string
  force?: boolean
  scope: "global" | "workspace"
  enabled: boolean
}

export interface SetPluginEnablementResult {
  pluginId: string
  version?: string
  scope: "global" | "workspace"
  enabled: boolean
  enableState: PluginEnableState
  needsReview: boolean
  diagnostics?: AgentPluginDiagnostic[]
}

export interface SetPluginActiveVersionInput {
  pluginId: string
  version: string
  acceptedPermissionsHash?: string
  force?: boolean
}

export interface SetPluginActiveVersionResult {
  pluginId: string
  previousActiveVersion?: string
  activeVersion: string
  needsReview: boolean
  diagnostics?: AgentPluginDiagnostic[]
}

export interface UninstallPluginInput {
  pluginId: string
  version?: string
  force?: boolean
}

export interface UninstallPluginResult {
  pluginId: string
  removedVersions: string[]
  disabledScopes: Array<{ scope: "global" | "workspace"; workspaceSlug?: string }>
  blockedScopes?: Array<{ scope: "global" | "workspace"; workspaceSlug?: string }>
  diagnostics?: AgentPluginDiagnostic[]
}

export interface PluginReadmePreview {
  markdown: string
  path?: string
  truncated?: boolean
}

export interface GetMarketDetailResult {
  item: MarketCatalogItem
  inspect?: InspectMarketSourceResult
  diagnostics: AgentPluginDiagnostic[]
  readme?: PluginReadmePreview
}

export interface ExportPluginArtifactInput {
  pluginId: string
  version: string
  artifactPath: string
  destDir?: string
}

export interface ExportPluginArtifactResult {
  savedPath: string
}

export interface DownloadBridgeAssetInput {
  url: string
  filename?: string
  sha256?: string
  destDir?: string
}

export interface DownloadBridgeAssetResult {
  savedPath: string
  verified: boolean
}

export interface CheckBridgeStatusInput {
  pluginId: string
  version: string
  verify: PluginSetupVerify
}

export interface CheckBridgeStatusResult {
  ok: boolean
  detail: string
}
