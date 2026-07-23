/** Versioned browser-runtime contract. Boundary values are serialisable and redacted. */
export const BROWSER_PROTOCOL_VERSION = 5 as const;
export const BROWSER_PROTOCOL_MIN_SUPPORTED = 5 as const;
export const BROWSER_PROTOCOL_MAX_SUPPORTED = 5 as const;

export type BrowserBackendType = "iab" | "extension";
export type BrowserActor = "user" | "agent";
export type BrowserErrorCode =
  | "incompatible_protocol" | "browser_unavailable" | "invalid_browser_request"
  | "invalid_url" | "private_origin_confirmation_required" | "stale_target"
  | "tab_not_found" | "tab_generation_changed" | "confirmation_unavailable"
  | "action_denied" | "strict_locator_violation" | "actionability_failed" | "dialog_blocking"
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
  backend: BrowserBackendType;
  generation: number;
  url: string;
  title: string;
  visible: boolean;
  surface: "main" | "right-panel" | null;
  shareable?: boolean;
  agentClaimed?: boolean;
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
  schemaVersion: 1;
  agentCursorVisible: boolean;
  linkOpenTarget: "lume" | "system";
  localUrlTarget: "lume" | "system";
  advancedCdpEnabled: boolean;
  extensionBackendEnabled: boolean;
  annotationScreenshots: "off" | "ask" | "always";
  downloadDirectory: string;
  downloadAskBeforeSave: boolean;
  downloadHistoryEnabled: boolean;
  sitePermissionDefault: "ask" | "deny";
  siteOverrides: Record<string, "ask" | "allow" | "deny">;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  schemaVersion: 1,
  agentCursorVisible: true,
  linkOpenTarget: "lume",
  localUrlTarget: "lume",
  advancedCdpEnabled: false,
  extensionBackendEnabled: false,
  annotationScreenshots: "ask",
  downloadDirectory: "",
  downloadAskBeforeSave: true,
  downloadHistoryEnabled: true,
  sitePermissionDefault: "ask",
  siteOverrides: {},
};

export const BROWSER_IPC_CHANNELS = {
  RUNTIME: "browser_runtime",
  EVENT: "browser:event",
  GET_SETTINGS: "browser_settings:get",
  UPDATE_SETTINGS: "browser_settings:update",
} as const;
