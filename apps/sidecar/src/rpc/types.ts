export interface JsonRpcRequest {
  id?: string | number;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id?: string | number;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    /** 与 @lume/shared LumeRpcErrorShape 对齐(toLumeRpcErrorShape 出站实际携带) */
    details?: unknown;
  };
}

export type RpcHandler = (params: unknown) => Promise<unknown>;

export type NotificationWriter = (method: string, params: unknown) => void;
