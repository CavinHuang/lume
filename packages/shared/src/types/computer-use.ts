export const DESKTOP_ACTION_STATUSES = [
  "ok",
  "dispatched",
  "unavailable",
  "vision_unavailable",
  "permission_denied",
  "stale_target",
  "blocked",
  "cancelled",
  "timeout",
  "failed",
] as const;

export type DesktopActionStatus = (typeof DESKTOP_ACTION_STATUSES)[number];

export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Canonical Computer Use window. Native platform handles never cross this boundary. */
export interface Window {
  id: number;
  app: string;
  title?: string;
}

export interface AccessibilityState {
  tree: string;
  focused_element?: string;
  selected_text?: string;
  selected_elements?: string[];
  document_text?: string;
}

export interface WindowState {
  window: Window;
  accessibility: AccessibilityState | null;
  screenshots: Screenshot[];
}

export interface Screenshot {
  id: string;
  url: string;
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
  zIndex: number;
}

export interface ListAppsApp {
  id: string;
  displayName?: string;
  isRunning?: boolean;
  lastUsedDate?: string;
  useCount?: number;
  windows: Window[];
}

export const DESKTOP_ACTION_PHASES = [
  "planned",
  "confirmed",
  "dispatched",
  "observed",
  "verified",
  "failed",
] as const;

export type DesktopActionPhase = (typeof DESKTOP_ACTION_PHASES)[number];

export interface DesktopActionLedgerEntry {
  actionId: string;
  threadId: string;
  action: DesktopActionKind;
  window: Window;
  phase: DesktopActionPhase;
  createdAt: number;
  updatedAt: number;
  screenshotId?: string;
  point?: { x: number; y: number };
  textLength?: number;
  sensitive?: boolean;
  failureReason?: string;
}

export interface DesktopAppRef {
  id: string;
  name: string;
  processId?: number;
  platformId?: string;
}

export interface DesktopWindowRef {
  id: string;
  appId: string;
  title: string;
  bounds: DesktopBounds;
  focused: boolean;
  minimized?: boolean;
}

export interface DesktopElementRef {
  id: string;
  role: string;
  name?: string;
  value?: string;
  bounds?: DesktopBounds;
  enabled?: boolean;
  focused?: boolean;
  sensitive?: boolean;
  actions?: string[];
  children?: DesktopElementRef[];
}

export interface DesktopScreenshotRef {
  id: string;
  width: number;
  height: number;
  origin: { x: number; y: number };
  mimeType: string;
  zIndex?: number;
  dataUrl?: string;
  captureMode?: "screen_capture_kit" | "windows_graphics_capture" | "print_window" | "screen_bitblt";
  captureFallbackReason?: string;
}

export type DesktopContextTextSource =
  | "accessibility_selection"
  | "accessibility_document"
  | "accessibility_visible"
  | "accessibility_tree"
  | "window_title";

export type DesktopContextCompleteness = "complete" | "partial" | "minimal";

export interface DesktopWindowState {
  window: DesktopWindowRef;
  revision: string;
  capturedAt: number;
  screenshots: DesktopScreenshotRef[];
  accessibility?: {
    tree?: DesktopElementRef[];
    focusedElement?: DesktopElementRef;
    selectedText?: string;
    documentText?: string;
    visibleText?: string;
    truncated?: boolean;
  };
  textSource?: DesktopContextTextSource;
  completeness?: DesktopContextCompleteness;
  fallbackReason?: string;
}

export type DesktopContextEventType =
  | "foreground_changed"
  | "pointer_idle"
  | "scroll_idle"
  | "selection_changed"
  | "typing_idle";

export interface DesktopContextSnapshot {
  id: string;
  app: DesktopAppRef;
  window: DesktopWindowRef;
  capturedAt: number;
  eventType: DesktopContextEventType;
  selectedText?: string;
  visibleText?: string;
  textSource?: DesktopContextTextSource;
  completeness?: DesktopContextCompleteness;
  fallbackReason?: string;
  screenshotId?: string;
  screenshots?: DesktopScreenshotRef[];
  untrusted: true;
}

export interface DesktopContextTarget {
  snapshotId: string;
  app: Pick<DesktopAppRef, "id" | "name">;
  window: Pick<DesktopWindowRef, "id" | "title">;
  capturedAt?: number;
}

export interface DesktopContextEvent {
  id: string;
  type: DesktopContextEventType;
  snapshotId: string;
  appId: string;
  windowId: string;
  occurredAt: number;
}

export type DesktopProactiveProposalKind =
  | "reply"
  | "conflict"
  | "prompt_rescue"
  | "daily_wrap"
  | "follow_up";

export type DesktopProactiveProposalStatus =
  | "pending"
  | "opened"
  | "accepted"
  | "dismissed"
  | "expired";

export type DesktopProactiveProposalResultStatus =
  | "generating"
  | "ready"
  | "unavailable"
  | "failed";

export type DesktopProactiveProposalSuggestedAction =
  | "reply_draft"
  | "review_conflict"
  | "apply_fix"
  | "review_summary"
  | "create_follow_up";

export interface DesktopProactiveProposalResult {
  title: string;
  body: string;
  suggestedAction: DesktopProactiveProposalSuggestedAction;
}

export interface DesktopProactiveProposal {
  id: string;
  kind: DesktopProactiveProposalKind;
  status: DesktopProactiveProposalStatus;
  snapshotId: string;
  app: Pick<DesktopAppRef, "id" | "name">;
  window: Pick<DesktopWindowRef, "id" | "title">;
  summary: string;
  resultStatus?: DesktopProactiveProposalResultStatus;
  result?: DesktopProactiveProposalResult;
  createdAt: number;
  expiresAt: number;
}

export interface DesktopProactiveProposalCreatedNotification {
  proposal: Pick<DesktopProactiveProposal, "id" | "kind" | "status" | "snapshotId" | "app" | "createdAt" | "expiresAt">;
}

export interface DesktopProactiveProposalUpdatedNotification {
  proposal: Pick<DesktopProactiveProposal, "id" | "status" | "resultStatus">;
}

export interface DesktopActionResult {
  status: DesktopActionStatus;
  message?: string;
  windowRevision?: string;
}

export type AgentDesktopActionRisk = "high" | "critical";

export interface AgentDesktopActionRequest {
  threadId: string;
  requestId: string;
  toolUseId: string;
  app: Pick<DesktopAppRef, "id" | "name">;
  action: DesktopActionKind;
  secondaryAction?: string;
  targetLabel?: string;
  targetPoint?: { x: number; y: number };
  confirmationCategories?: DesktopConfirmationCategory[];
  recipient?: string;
  dataTypes?: string[];
  risk: AgentDesktopActionRisk;
  expiresAt: string;
  window: Window;
  securityWarning?: "suspected_prompt_injection";
  summary: string;
}

export interface AgentDesktopActionResponseInput {
  threadId: string;
  requestId: string;
  decision: "allow_once" | "deny";
}

export interface DesktopAssistantSettings {
  enabled: boolean;
  allowedApps: string[];
  retentionHours: number;
  maxStorageBytes: number;
  proactiveEnabled?: boolean;
  notificationsEnabled?: boolean;
  dailyWrapEnabled?: boolean;
}

export interface DesktopAssistantStatus {
  host: {
    status: DesktopActionStatus;
    message?: string;
    permissionTarget?: {
      appName?: string;
      appBundleName?: string;
      bundleId?: string;
      authorizationSubject?: string;
    };
    permissions?: Array<{
      id?: string;
      title?: string;
      status?: string;
      settingsUrl?: string;
      instruction?: string;
    }>;
  };
  store: { unlocked: boolean; items: number; bytes: number };
  collector: { running: boolean; suspensionReasons: DesktopContextSuspensionReason[] };
}

export interface DesktopAppDiscoveryResult {
  status: DesktopActionStatus;
  apps: Array<Pick<DesktopAppRef, "id" | "name"> & { isRunning: boolean }>;
  message?: string;
}

export type DesktopContextSuspensionReason = "screen_locked" | "system_suspended";

export const DESKTOP_CONTEXT_IPC_CHANNELS = {
  UNLOCK: "desktop-context:unlock",
  SET_SUSPENDED: "desktop-context:set-suspended",
  CAPTURE_CURRENT: "desktop-context:capture-current",
  GET_FOREGROUND_TARGET: "desktop-context:get-foreground-target",
  CAPTURE_WINDOW: "desktop-context:capture-window",
  REQUEST_PERMISSIONS: "desktop-context:request-permissions",
  LIST_APPS: "desktop-context:list-apps",
  GET_SETTINGS: "desktop-context:get-settings",
  UPDATE_SETTINGS: "desktop-context:update-settings",
  GET_STATUS: "desktop-context:get-status",
  CLEAR: "desktop-context:clear",
  LIST_ACTIVITY: "desktop-context:list-activity",
  LIST_PROPOSALS: "desktop-context:list-proposals",
  UPDATE_PROPOSAL: "desktop-context:update-proposal",
  PROPOSAL_CREATED: "desktop-context:proposal-created",
  PROPOSAL_UPDATED: "desktop-context:proposal-updated",
  PROPOSAL_OPEN_REQUEST: "desktop-context:proposal-open-request",
  ACTION_REQUEST: "agent:desktop-action-request",
  SUBMIT_ACTION: "agent:submit-desktop-action",
} as const;

export type DesktopActionKind =
  | "launch_app"
  | "activate_window"
  | "move_pointer"
  | "click"
  | "press_key"
  | "type_text"
  | "scroll"
  | "set_value"
  | "drag"
  | "perform_secondary_action";

export interface DesktopActionIntent {
  kind: DesktopActionKind;
  targetLabel?: string;
  keys?: string[];
  secondaryAction?: string;
}

export type DesktopConfirmationCategory =
  | "send_message"
  | "submit_form"
  | "delete"
  | "upload"
  | "permission"
  | "account"
  | "financial"
  | "sensitive_data"
  | "medical"
  | "install";

export interface DesktopActionConfirmationClassification {
  required: boolean;
  categories: DesktopConfirmationCategory[];
}

const CONSEQUENTIAL_TARGET_RE = /(?:发送|删除|付款|支付|购买|提交|授权|确认订单|send|delete|pay|purchase|submit|authorize)/i;
const CONSEQUENTIAL_KEY_RE = /^(?:enter|return)$/i;
const CONSEQUENTIAL_SECONDARY_ACTION_RE = /(?:send|delete|remove|pay|purchase|submit|confirm|authorize)/i;
const CONFIRMATION_PATTERNS: Array<[DesktopConfirmationCategory, RegExp]> = [
  ["send_message", /(?:发送|回复|发消息|send|reply|message)/i],
  ["submit_form", /(?:提交|确认订单|submit|confirm\s*(?:form|order)?)/i],
  ["delete", /(?:删除|移除|清空|delete|remove|erase)/i],
  ["upload", /(?:上传|附件|upload|attach)/i],
  ["permission", /(?:允许|授权|权限|permission|authorize|grant\s+access)/i],
  ["account", /(?:账户|账号|登录|注销|注册|account|sign\s*(?:in|up|out)|log\s*out)/i],
  ["financial", /(?:付款|支付|购买|转账|退款|银行卡|pay|purchase|transfer|refund|bank)/i],
  ["sensitive_data", /(?:密码|验证码|身份证|通讯录|地址|电话|邮箱|password|otp|identity|contacts?|address|phone|email)/i],
  ["medical", /(?:医疗|病历|处方|诊断|用药|预约|medical|health|prescription|diagnosis|medication)/i],
  ["install", /(?:安装|卸载|install|uninstall)/i],
];

export function isDesktopActionStatus(value: unknown): value is DesktopActionStatus {
  return typeof value === "string" && (DESKTOP_ACTION_STATUSES as readonly string[]).includes(value);
}

export function desktopProposalSuggestedAction(
  kind: DesktopProactiveProposalKind,
): DesktopProactiveProposalSuggestedAction {
  switch (kind) {
    case "reply": return "reply_draft";
    case "conflict": return "review_conflict";
    case "prompt_rescue": return "apply_fix";
    case "daily_wrap": return "review_summary";
    case "follow_up": return "create_follow_up";
  }
}

export function requiresDesktopActionConfirmation(intent: DesktopActionIntent): boolean {
  if (classifyDesktopActionConfirmation(intent).required) return true;
  if (CONSEQUENTIAL_TARGET_RE.test(intent.targetLabel?.trim() ?? "")) return true;
  if (CONSEQUENTIAL_SECONDARY_ACTION_RE.test(intent.secondaryAction?.trim() ?? "")) return true;
  if (intent.kind !== "press_key") return false;
  return intent.keys?.some((key) => CONSEQUENTIAL_KEY_RE.test(key.trim())) ?? false;
}

export function classifyDesktopActionConfirmation(
  intent: DesktopActionIntent,
): DesktopActionConfirmationClassification {
  const text = `${intent.targetLabel ?? ""} ${intent.secondaryAction ?? ""}`.trim();
  const categories = CONFIRMATION_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([category]) => category);
  if (
    intent.kind === "press_key"
    && intent.keys?.some((key) => CONSEQUENTIAL_KEY_RE.test(key.trim()))
    && !categories.includes("submit_form")
  ) {
    categories.push("submit_form");
  }
  return { required: categories.length > 0, categories };
}
