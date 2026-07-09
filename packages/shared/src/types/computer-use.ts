export const DESKTOP_ACTION_STATUSES = [
  "ok",
  "unavailable",
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
  children?: DesktopElementRef[];
}

export interface DesktopScreenshotRef {
  id: string;
  width: number;
  height: number;
  origin: { x: number; y: number };
  mimeType: string;
  dataUrl?: string;
}

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
  };
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

export interface DesktopProactiveProposal {
  id: string;
  kind: DesktopProactiveProposalKind;
  status: DesktopProactiveProposalStatus;
  snapshotId: string;
  app: Pick<DesktopAppRef, "id" | "name">;
  window: Pick<DesktopWindowRef, "id" | "title">;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

export interface DesktopProactiveProposalCreatedNotification {
  proposal: Pick<DesktopProactiveProposal, "id" | "kind" | "status" | "snapshotId" | "app" | "createdAt" | "expiresAt">;
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
  targetLabel?: string;
  targetPoint?: { x: number; y: number };
  risk: AgentDesktopActionRisk;
  expiresAt: string;
  expectedWindowId?: string;
  expectedRevision?: string;
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
    }>;
  };
  store: { unlocked: boolean; items: number; bytes: number };
}

export const DESKTOP_CONTEXT_IPC_CHANNELS = {
  UNLOCK: "desktop-context:unlock",
  CAPTURE_CURRENT: "desktop-context:capture-current",
  GET_FOREGROUND_TARGET: "desktop-context:get-foreground-target",
  CAPTURE_WINDOW: "desktop-context:capture-window",
  REQUEST_PERMISSIONS: "desktop-context:request-permissions",
  GET_CURRENT: "desktop-context:get-current",
  SEARCH: "desktop-context:search",
  GET_SETTINGS: "desktop-context:get-settings",
  UPDATE_SETTINGS: "desktop-context:update-settings",
  GET_STATUS: "desktop-context:get-status",
  CLEAR: "desktop-context:clear",
  LIST_ACTIVITY: "desktop-context:list-activity",
  LIST_PROPOSALS: "desktop-context:list-proposals",
  UPDATE_PROPOSAL: "desktop-context:update-proposal",
  PROPOSAL_CREATED: "desktop-context:proposal-created",
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
}

const CONSEQUENTIAL_TARGET_RE = /(?:发送|删除|付款|支付|购买|提交|授权|确认订单|send|delete|pay|purchase|submit|authorize)/i;

export function isDesktopActionStatus(value: unknown): value is DesktopActionStatus {
  return typeof value === "string" && (DESKTOP_ACTION_STATUSES as readonly string[]).includes(value);
}

export function requiresDesktopActionConfirmation(intent: DesktopActionIntent): boolean {
  return CONSEQUENTIAL_TARGET_RE.test(intent.targetLabel?.trim() ?? "");
}
