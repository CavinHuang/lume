/** Versioned browser-runtime contract. Boundary values are serialisable and redacted. */
export const BROWSER_PROTOCOL_VERSION = 8 as const;
export const BROWSER_PROTOCOL_MIN_SUPPORTED = 5 as const;
export const BROWSER_PROTOCOL_MAX_SUPPORTED = 8 as const;

export type BrowserBackendType = "iab" | "extension";
export type BrowserActor = "user" | "agent";
export type BrowserErrorCode =
  | "incompatible_protocol" | "browser_unavailable" | "invalid_browser_request"
  | "invalid_url" | "private_origin_confirmation_required" | "stale_target" | "stale_snapshot_cursor"
  | "tab_not_found" | "tab_generation_changed" | "confirmation_unavailable" | "reference_grant_expired"
  | "action_denied" | "user_action_required" | "strict_locator_violation" | "actionability_failed" | "dialog_blocking" | "user_takeover_required"
  | "element_not_visible" | "element_disabled" | "element_occluded" | "element_readonly"
  | "unsupported" | "executed_unknown" | "browser_internal_error";

export interface BrowserProtocolHandshake {
  protocolVersion: number;
  minSupported: number;
  maxSupported: number;
  capabilityHash: string;
}

export interface BrowserCapabilityDescriptor { id: string; description: string; }

export interface BrowserRuntimeDescriptor extends BrowserProtocolHandshake {
  id: string;
  backend: BrowserBackendType;
  generation: number;
  capabilities: BrowserCapabilityDescriptor[];
  apiSupportOverrides?: Record<string, boolean>;
}

export interface BrowserBackendDescriptor extends BrowserProtocolHandshake {
  id: string;
  browserId: string;
  backend: BrowserBackendType;
  type: BrowserBackendType;
  clientType: BrowserBackendType;
  name: string;
  generation: number;
  metadata: Record<string, string>;
  capabilities: { browser: BrowserCapabilityDescriptor[]; tab: BrowserCapabilityDescriptor[] };
  apiSupportOverrides: Record<string, boolean>;
}

export interface BrowserTabDescriptor {
  tabId: string;
  providerTabId?: string;
  ownerThreadId?: string;
  openerTabId?: string;
  profileKind?: "user" | "agent" | "advanced-cdp";
  backend: BrowserBackendType;
  generation: number;
  url: string;
  title: string;
  faviconUrl?: string;
  isLoading?: boolean;
  loadError?: { errorCode: number; errorDescription: string; url: string };
  canGoBack?: boolean;
  canGoForward?: boolean;
  navigationEntries?: string[];
  navigationIndex?: number;
  scrollPosition?: { x: number; y: number };
  lastOpenedAt?: string;
  securityState?: "secure" | "insecure" | "local" | "unknown";
  mediaState?: {
    audible: boolean;
    camera: boolean;
    microphone: boolean;
  };
  lifecycle?: "active" | "background" | "suspended" | "crashed";
  viewport?: BrowserViewportState;
  zoomFactor?: number;
  visible: boolean;
  surface: "main" | "right-panel" | null;
  shareable?: boolean;
  agentClaimed?: boolean;
  agentControlState?: "active" | "paused_by_user";
  handoffStatus?: "handoff" | "deliverable";
  guestState?: "unmounted" | "attaching" | "ready" | "gone";
  viewportRevision?: number;
}

/** One-time renderer mount grant. Never expose this value to the Sidecar or model. */
export interface BrowserGuestMountDescriptor {
  mountToken: string;
  tabId: string;
  generation: number;
  partition: string;
  bootstrapUrl: string;
  expiresAt: string;
}

export interface BrowserReferenceCandidate {
  backend: BrowserBackendType;
  browserId: "lume-iab" | "lume-extension";
  tabId: string;
  providerTabId?: string;
  title: string;
  url: string;
  generation?: number;
  lastOpenedAt?: string;
  ownerThreadId?: string;
}

export interface BrowserReferenceGrantInput extends BrowserReferenceCandidate {
  threadId: string;
  access: "control";
}

export interface BrowserReferenceGrantResult {
  referenceGrantId: string;
  expiresAt: string;
}

/** Main-process-owned layout for one task browser workspace. */
export interface BrowserWorkspaceDescriptor {
  ownerThreadId: string;
  orderedTabIds: string[];
  activeTabId?: string;
  recentlyClosed: Array<{
    tabId: string;
    closedAt: string;
    title: string;
    url: string;
    profileKind: NonNullable<BrowserTabDescriptor["profileKind"]>;
    handoffStatus?: BrowserTabDescriptor["handoffStatus"];
  }>;
  revision: number;
}

export type BrowserAuthInputType =
  | "text" | "email" | "password" | "tel" | "number" | "url"
  | "search" | "otp";

export interface BrowserAuthFieldRequest {
  id: string;
  label: string;
  locator: BrowserLocator;
  inputType: BrowserAuthInputType;
  autocomplete?: string;
  required: boolean;
  frameLocator?: BrowserLocator;
}

export interface BrowserAuthOption {
  id: string;
  label: string;
  fields: string[];
  /** method-only 选项：用户选择登录方式后端点击该定位器，不填写任何字段（对齐 Codex BrowserAuthOption.selector） */
  locator?: BrowserLocator;
  frameLocator?: BrowserLocator;
}

export interface BrowserAuthRequest {
  tabId: string;
  generation: number;
  origin: string;
  expiresAt: string;
  title?: string;
  fields: BrowserAuthFieldRequest[];
  options?: BrowserAuthOption[];
  submit?:
    | { kind: "click"; locator: BrowserLocator; frameLocator?: BrowserLocator }
    | { kind: "press_enter"; fieldId?: string }
    | { kind: "none" };
}

export type BrowserAuthStatus =
  | "submitted" | "declined" | "cancelled" | "expired" | "page_changed" | "origin_changed"
  | "locator_invalid" | "submission_failed";

export interface BrowserAuthResult {
  status: BrowserAuthStatus;
  selected_option?: string;
}

export interface BrowserViewportState {
  enabled: boolean;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  preset?: BrowserViewportPreset;
  displayScale?: "fit" | number;
}

export type BrowserViewportPreset =
  | "desktop"
  | "responsive"
  | "4k"
  | "laptop-l"
  | "laptop"
  | "surface-pro-7"
  | "ipad-air"
  | "ipad-mini"
  | "surface-duo"
  | "iphone-15-pro-max"
  | "pixel-8"
  | "iphone-15-pro"
  | "samsung-galaxy-s24-ultra"
  | "iphone-se"
  | "phone"
  | "tablet"
  | "phone-landscape"
  | "tablet-landscape";

export interface BrowserHistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
}

export interface BrowserExtensionDescriptor {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  permissions: string[];
}

export type BrowserSitePermission =
  | "browse"
  | "download"
  | "upload"
  | "cdp"
  | "camera"
  | "microphone";

export type BrowserPermissionDecision = "ask" | "allow" | "deny";

export interface BrowserSitePermissionOverride {
  browse?: BrowserPermissionDecision;
  download?: BrowserPermissionDecision;
  upload?: BrowserPermissionDecision;
  cdp?: BrowserPermissionDecision;
  camera?: BrowserPermissionDecision;
  microphone?: BrowserPermissionDecision;
}

export interface BrowserRequestContext {
  threadId?: string;
  browserSessionId: string;
  browserTurnId: string;
  tabId?: string;
  actor: BrowserActor;
  capability?: string;
}

export interface BrowserActionRequest {
  requestId: string;
  context: BrowserRequestContext;
  method: string;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

export type BrowserTextMatcher = string | { value: string; mode?: "exact" | "contains" | "regex" }
export type BrowserLocatorStep =
  | { kind: "role"; role: string; name?: BrowserTextMatcher; exact?: boolean }
  | { kind: "text"; text: BrowserTextMatcher; exact?: boolean }
  | { kind: "label"; text: BrowserTextMatcher; exact?: boolean }
  | { kind: "placeholder"; text: BrowserTextMatcher; exact?: boolean }
  | { kind: "testId"; testId: string }
  | { kind: "css" | "locator"; selector: string }
  | { kind: "frame"; selector: string }
  | { kind: "nth"; index: number }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "filter"; hasText?: BrowserTextMatcher; hasNotText?: BrowserTextMatcher }
  | { kind: "and" | "or"; locator: BrowserLocator }

export interface BrowserLocator { version?: 1; steps: BrowserLocatorStep[] }

export interface BrowserActionResponse<T = unknown> {
  requestId: string;
  ok: boolean;
  result?: T;
  error?: { code: BrowserErrorCode; recoverable: boolean };
}

export interface BrowserAuditEvent {
  eventVersion: 1;
  eventId: string;
  correlationId: string;
  timestamp: string;
  actor: BrowserActor;
  threadId?: string;
  browserSessionId: string;
  tabId?: string;
  backend: BrowserBackendType;
  generation: number;
  origin?: string;
  action: string;
  decision: "allow" | "deny" | "confirm" | "error";
  status: "started" | "committed" | "acknowledged" | "executed_unknown" | "failed";
  errorCode?: BrowserErrorCode;
  durationMs?: number;
}

export interface BrowserSettings {
  schemaVersion: 1 | 2 | 3;
  browserEnabled?: boolean;
  browserUseEnabled?: boolean;
  browserApprovalMode: "alwaysAsk" | "neverAsk";
  iabHistoryApprovalMode: "alwaysAsk" | "neverAsk" | "disabled";
  chromeHistoryApprovalMode: "alwaysAsk" | "neverAsk" | "disabled";
  agentCursorVisible: boolean;
  linkOpenTarget: "lume" | "system";
  localUrlTarget: "lume" | "system";
  advancedCdpEnabled: boolean;
  extensionBackendEnabled: boolean;
  annotationScreenshots: "off" | "ask" | "necessary" | "always";
  downloadDirectory: string;
  downloadAskBeforeSave: boolean;
  downloadHistoryEnabled: boolean;
  sitePermissionDefault: "ask" | "deny";
  siteOverrides: Record<string, "ask" | "allow" | "deny">;
  sitePermissionOverrides?: Record<string, BrowserSitePermissionOverride>;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  schemaVersion: 3,
  browserEnabled: true,
  browserUseEnabled: true,
  browserApprovalMode: "alwaysAsk",
  iabHistoryApprovalMode: "alwaysAsk",
  chromeHistoryApprovalMode: "alwaysAsk",
  agentCursorVisible: true,
  linkOpenTarget: "lume",
  localUrlTarget: "lume",
  advancedCdpEnabled: false,
  extensionBackendEnabled: false,
  annotationScreenshots: "necessary",
  downloadDirectory: "",
  downloadAskBeforeSave: true,
  downloadHistoryEnabled: true,
  sitePermissionDefault: "ask",
  siteOverrides: {},
  sitePermissionOverrides: {},
};

export const BROWSER_IPC_CHANNELS = {
  RUNTIME: "browser_runtime",
  EVENT: "browser:event",
  GET_SETTINGS: "browser_settings:get",
  UPDATE_SETTINGS: "browser_settings:update",
} as const;
