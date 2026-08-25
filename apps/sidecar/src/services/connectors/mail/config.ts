export const mailImapPort: number = 993;
export const mailSmtpPort: number = 465;
export const mailMessageFetchByteLimit: number = 5 * 1024 * 1024;
export const mailAttachmentDownloadByteLimit: number = 25 * 1024 * 1024;
export const mailConnectionTimeoutMs: number = 30_000;
/**
 * 凭证验证(IMAP+SMTP 两阶段顺序)的总预算。desktop 对所有 sidecar RPC 统一
 * 45s 超时:两阶段各自 30s 最坏 60s 会造成「UI 已报超时、sidecar 却验证成功
 * 落盘」的状态分裂,故整体收敛到 40s 留出 IPC 余量。
 */
export const mailValidationTotalBudgetMs = 40_000;
