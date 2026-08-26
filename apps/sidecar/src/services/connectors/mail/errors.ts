export type MailProtocolErrorKind =
  | "auth"
  | "folder_not_found"
  | "uid_not_found"
  | "trash_missing"
  | "uid_validity_changed"
  | "timeout"
  | "network"
  | "blocked_host"
  | "provider"
  /** 本地闸门主动快败(排队超限):请求未发往上游,模型应退避重试。 */
  | "busy";

export class MailProtocolError extends Error {
  readonly kind: MailProtocolErrorKind;

  constructor(kind: MailProtocolErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}
