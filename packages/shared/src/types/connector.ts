// 连接器(open-connector 迁移)对外契约:IPC 通道与状态类型。

export const CONNECTOR_IPC_CHANNELS = {
  GET_STATUS: "connector:get-status",
  GET_SETUP: "connector:get-setup",
  SAVE_CLIENT_CONFIG: "connector:save-client-config",
  SAVE_CREDENTIAL: "connector:save-credential",
  START_AUTH: "connector:start-auth",
  DISCONNECT: "connector:disconnect"
} as const;

/** 连接器的配置向导描述(由 provider definition 单源下发,web 按此渲染表单与指引)。 */
export interface ConnectorSetupField {
  key: string;
  label: string;
  inputType: "text" | "password";
  placeholder?: string;
  description?: string;
}

export interface ConnectorSetup {
  service: string;
  displayName: string;
  /** oauth2 = 先填 client 凭据再浏览器授权;custom = 直接填字段保存即验证连接。 */
  authKind: "oauth2" | "custom";
  /** custom 型的字段表(oauth2 型为空,表单固定为 clientId/clientSecret)。 */
  fields: ConnectorSetupField[];
  /** OAuth app 注册指引(仅 oauth2 型),在粘贴 client_id/secret 的位置展示。 */
  clientSetup?: {
    docsUrl?: string;
    steps: string[];
  };
}

/** 向导描述 + 当前完整连接态(get-setup 单次返回全部 provider)。 */
export type ConnectorSetupWithStatus = ConnectorSetup & Omit<ConnectorStatus, "service">;

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
