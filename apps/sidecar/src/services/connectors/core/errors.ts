/** 连接器域稳定错误码载体:跨 service/RPC/执行器层传递,code 供调用方分支处理。 */
export class ConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
