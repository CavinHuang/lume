/**
 * IM CLI SDK 工具工厂:每渠道封装为单一透传工具 `<provider>_cli`。
 * handler:ensureBinary → execCli(command + args) → 结构化结果。未授权时返回 guidance。
 */
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import type { CliProviderConfig } from "./providers/dingtalk";
import { execCli as defaultExecCli, type CliExecOptions, type CliExecResult } from "./cli-executor";
import { ensureBinary as defaultEnsureBinary } from "./cli-binary-manager";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { createLogger } from "../../../infra/logger";

const log = createLogger("im-cli-tool");

export interface CreateImCliToolsInput {
  config: CliProviderConfig;
  userDataRoot: string;
  platform: string;
  arch: string;
  /** 测试注入点 */
  overrides?: {
    ensureBinary?: typeof defaultEnsureBinary;
    execCli?: typeof defaultExecCli;
  };
}

export function createSdkImCliTools(input: CreateImCliToolsInput): ToolDefinition[] {
  const { config, userDataRoot, platform, arch, overrides } = input;
  const ensure = overrides?.ensureBinary ?? defaultEnsureBinary;
  const exec = overrides?.execCli ?? defaultExecCli;

  return [
    createSdkJsonResultTool({
      name: `${config.provider}_cli`,
      description: `执行 ${config.provider} IM CLI(${config.binaryName})的子命令(发消息、查日历、读文档等)。先以 command="auth" args=["status"] 确认已授权;未授权时请在 Lume IM 设置中完成授权后重试。具体子命令参见 ${config.provider}-cli SKILL。`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "子命令(如 calendar / message / auth)", minLength: 1 },
          args: { type: "array", items: { type: "string" }, description: "子命令参数" },
        },
        required: ["command"],
      },
      async call(args) {
        const command = typeof args.command === "string" && args.command.trim() ? args.command.trim() : "";
        if (!command) throw new Error("command 必填");
        const cliArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        log.info(`工具调用 ${config.provider}_cli`, { command, argCount: cliArgs.length });

        const { path: binaryPath } = await ensure(config, userDataRoot, platform, arch);
        const cliEnv: Record<string, string> = {};
        for (const [envName, subdir] of Object.entries(config.envDirs)) {
          cliEnv[envName] = join(userDataRoot, `${config.provider}-cli`, subdir);
        }
        const options: CliExecOptions = {
          envDenyList: config.envDenyList,
          env: cliEnv,
        };
        const result: CliExecResult = await exec(binaryPath, [command, ...cliArgs], options);

        const out: Record<string, unknown> = {
          ok: result.ok,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        };
        if (!result.ok && /not logged in|exit 69|未授权|未登录|not authorized/i.test(result.stderr)) {
          out.guidance = `${config.provider} 未授权:请在 Lume IM 设置中完成 ${config.provider} 授权后重试。`;
        }
        return out;
      },
    }),
  ];
}
