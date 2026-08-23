// 连接器(open-connector 迁移)对外契约:IPC 通道与状态类型。

export const CONNECTOR_IPC_CHANNELS = {
  GET_STATUS: "connector:get-status",
  SAVE_CLIENT_CONFIG: "connector:save-client-config",
  SAVE_CREDENTIAL: "connector:save-credential",
  START_AUTH: "connector:start-auth",
  DISCONNECT: "connector:disconnect"
} as const;

export interface ConnectorStatus {
  service: string;
  /** vault 中是否已配置 OAuth client_id/secret。 */
  clientConfigured: boolean;
  /** 是否已完成授权且凭证可用。 */
  connected: boolean;
  /** 已连接账号的展示标识(Gmail 为邮箱地址)。 */
  accountLabel?: string;
  /** 授权进行中时为 true(UI 轮询判定)。 */
  authorizing?: boolean;
  /** 最近一次授权失败的稳定错误码/文案。 */
  lastError?: string;
}
