declare module "undici" {
  export class Agent {
    constructor();
  }

  export class EnvHttpProxyAgent {
    constructor();
  }

  export class ProxyAgent {
    constructor(proxyUri: string);
  }

  export function setGlobalDispatcher(dispatcher: unknown): void;
}
