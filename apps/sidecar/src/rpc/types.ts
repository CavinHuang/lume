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
  };
}

export type RpcHandler = (params: unknown) => Promise<unknown>;

export type NotificationWriter = (method: string, params: unknown) => void;
