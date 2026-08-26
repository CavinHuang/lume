export type MailProtocolErrorKind =
  | "auth"
  | "folder_not_found"
  | "uid_not_found"
  | "trash_missing"
  | "uid_validity_changed"
  | "timeout"
  | "network"
  | "blocked_host"
  | "provider";

export class MailProtocolError extends Error {
  readonly kind: MailProtocolErrorKind;

  constructor(kind: MailProtocolErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}
