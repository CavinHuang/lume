/**
 * node-pty 最小环境声明 —— sidecar 运行时经 bun build --external 动态加载
 * （打包脚本把 mxc-sdk 依赖树中的 node-pty 复制到 resources/sidecar/node_modules），
 * 包本体不在 sidecar 依赖图内，TS 无法解析其自带 typings，故按 qrcode.d.ts 先例
 * 声明本服务实际使用的最小结构面（完整类型见 node-pty 包 typings/）。
 */
declare module "node-pty" {
  export interface IPtySpawnOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    encoding?: string;
    useConpty?: boolean;
    useConptyDll?: boolean;
  }

  export interface IPtyExitEvent {
    exitCode: number;
    signal?: number;
  }

  export interface IPty {
    readonly pid: number;
    write(data: string): void;
    resize(columns: number, rows: number): void;
    kill(signal?: string | number): void;
    onData(listener: (chunk: string) => void): void;
    onExit(listener: (event: IPtyExitEvent) => void): void;
  }

  export function spawn(file: string, args: readonly string[], options: IPtySpawnOptions): IPty;
}
