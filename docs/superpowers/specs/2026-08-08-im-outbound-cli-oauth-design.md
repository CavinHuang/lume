# IM 出站 CLI 接通与下载校验 — 设计文档

**日期**: 2026-08-08
**分支**: `feature/im-enterprise-channels`（worktree `lume-im`）
**范围**: 任务 2 — 补全出站 CLI 到可用（钉钉/飞书/企微三渠道全打通）
**状态**: 设计定稿，自主推进实现

---

## 1. 背景与问题

P1-P6 已完成入站双向 IM（三渠道收消息 → 触发 agent → 文本回复闭环），并旁挂了出站 CLI 工具框架（`<provider>_cli` 工具 + SKILL.md + `cli-binary-manager`/`cli-executor`/`cli-auth-flow`）。但出站 CLI 是**半成品**，三个阻断点致 agent 实际调不通：

1. **OAuth 断链**: `cli-auth-flow.ts` 的 `runCliAuth` 是孤儿函数——已实现但仅被自己测试引用，无 IPC handler、无 UI 入口，且 URL/status 解析硬编码钉钉。
2. **下载未完成**: `cli-binary-manager` 的 `EXPECTED_SHA256` 空 + `tarballUrl` TODO，且当前 `ensureBinary` 假设裸 binary 落盘，不支持压缩包解压。
3. **解析未泛化**: 飞书/企微无 `parseAuthStatus`。

对照 wanta（`D:\workspace\projects\ai-projects\wanta`）:wanta 三渠道是纯 outbound,OAuth+下载+PATH 透传完整,但**无入站**。Lume 入站已领先,本任务把出站 CLI 这层补到 wanta 同等可用度。

## 2. 目标与非目标

**目标**
- 接通 OAuth 授权链路:三渠道 `runCliAuth` 不再是孤儿,有 IPC + UI 入口,agent 调 `<provider>_cli` 能完成授权。
- 补全二进制下载校验:三渠道从 wanta 移植下载策略 + checksum,`ensureBinary` 支持下载→解压→取 binary→校验→落盘。
- 泛化解析器:`CliProviderConfig` 携带 `parseAuthStatus`,三渠道 config 驱动。

**非目标**（任务 3 或 follow-up）
- 入站多媒体解析（图片/文件/语音进 `contents`）。
- 三企业渠道 `sendMedia` 出站。
- wanta 式细分授权相位（`waiting_for_admin` 等），先做简单四相位。
- 企微 license 确认（发布前 blocker，不阻塞开发）。

## 3. 架构

### 三层职责（零跨层耦合）

| 层 | 职责 | 新增 |
|---|---|---|
| **sidecar** | `cli-auth-manager`(start/poll/cancel) + 复用 `cli-binary-manager`/`cli-executor` + 泛化 config | manager + 3 IPC handler |
| **desktop** | 仅复用现有 `openExternal`（main.ts:1862） | **零新增** |
| **web** | `ImSettings` 加"企业 CLI 能力"区 + poll 状态机(仿微信 2.5s) | desktop-api 3 函数 + UI |

### 关键决策:CLI 授权是 provider 级,非账号级

入站凭据是账号级(im.json 多账号);CLI OAuth 是**一个 provider 授权一次**——CLI config/keychain 目录(`~/.lume/im-cli/<provider>-cli/config`)共享,与入站账号无关。`startAuth` 入参 `{provider}`,UI 按渠道维度授权。

### 关键决策:sidecar 主导 + start/poll（仿微信登录）

`runCliAuth` 当前 `await exec` 阻塞式(最长 16min),不能当 RPC。改为仿 `weixinLoginManager` 的 start/poll:spawn 后立即返回 OAuth URL,子进程常驻,web 轮询状态。不照搬 wanta 的 desktop 主导(那会割裂 IM 架构,Lume IM 内核在 sidecar)。

### 状态枚举（简单四相位）

`idle | authorizing | connected | error`。wanta 细分相位先用 `authorizing` 笼统覆盖。

## 4. 数据流（钉钉为例）

```
web                sidecar(cli-auth-manager)        desktop          浏览器
 │ 点"授权CLI"      │                                 │                 │
 │─START_CLI_AUTH─▶│ startAuth('dingtalk')           │                 │
 │                  │  ensureBinary(dws)─sha256校验    │                 │
 │                  │  spawnCli(dws auth login,流式)   │                 │
 │                  │  扫stdout命中 login.dingtalk URL │                 │
 │ ◀─{sessionKey,authUrl}──│                         │                 │
 │─openExternal(authUrl)──────────────────────────────▶│ shell.openExternal│
 │─POLL_CLI_AUTH(2.5s)▶│ pollAuth: proc未exit→authorizing              │
 │ ◀─{phase:'authorizing'}──│                                          │
 │                  │  dws exit, parseAuthStatus→connected            │
 │─POLL_CLI_AUTH─▶│ pollAuth: connected                              │
 │ ◀─{phase:'connected'}──│                                            │
 │ 停止轮询,按钮变"已授权"                                             │
```

飞书同构(feishu.cn URL);企微同构(work.weixin.qq.com/ai/qc/gen?scode,手机扫)。三渠道统一走 openExternal + 进程等完成,差异仅在 config 的 `authUrlPattern` 与 `parseAuthStatus`。

## 5. 组件设计

### B1. 泛化 config 解析器

`CliProviderConfig` 加两字段:
```ts
statusCommand: string[];  // 授权后确认 connected 的命令
parseAuthStatus: (stdout: string) => { connected: boolean; profile?: string };  // 解析 statusCommand 输出
```
**关键修正(wanta 核实)**:connected 判定**不是**解析 authCommand stdout,而是 authCommand exit 0 后**单独再跑 statusCommand**。三渠道:
- 钉钉:`statusCommand=["auth","status","--format","json"]` → JSON `{authenticated}` → connected=`authenticated===true`
- 飞书:`statusCommand=["auth","status","--json","--verify"]` → JSON `{identity,verified?}` → connected=`identity==="user"&&verified!==false`
- 企微:`statusCommand=["auth","show","--auth-status"]` → 纯文本 `stdout.trim()==="authorized"`
- URL 提取已泛化(authCommand 输出扫 `authUrlPattern`)。`runCliAuth` 退役,逻辑进 manager。
- `extractDingtalkAuthUrl` 删;`parseDingtalkAuthStatus` → dingtalk config 的 `parseAuthStatus` 字段值。

### B2. cli-auth-manager（新建,两段 spawn 状态机）

`apps/sidecar/src/services/agent-runtime/tools/im-cli/cli-auth-manager.ts`,仿 `weixinLoginManager`。

```ts
interface AuthSession {
  provider: string; authUrl?: string;
  phase: 'authorizing' | 'connected' | 'error';
  profile?: string; error?: string;
  authProc?: ChildProcess; statusProc?: ChildProcess;
  timeoutTimer?: NodeJS.Timeout; resolveStart?: (r: { sessionKey: string; authUrl?: string; error?: string }) => void;
}
class CliAuthManager {
  private sessions = new Map<string, AuthSession>();
  async startAuth(provider: string, deps?: CliAuthDeps): Promise<{ sessionKey: string; authUrl?: string; error?: string }>;
  pollAuth(sessionKey: string): { phase: CliAuthPhase; authUrl?: string; profile?: string; error?: string };
  cancelAuth(sessionKey: string): void;
  stopAll(): void; // sidecar 退出清理
}
```
- `startAuth`(两段):① ensureBinary → `spawnCli(authCommand,流式)` → 监听 stdout 命中 `authUrlPattern` 存 authUrl → 一旦有 authUrl(或 spawn 失败)即 resolve `{sessionKey,authUrl}`(不等 authProc exit) → ② authProc exit 0 → `spawnCli(statusCommand)` → exit 后 `config.parseAuthStatus(stdout)` 定 phase=connected/error;authProc exit!==0 → phase=error(含 stderr 摘要)。`authTimeoutMs` timer 兜底 kill 两 proc。
- 依赖注入:`spawnCli`、`ensureBinary`、`sessionId()` 可注入(fake)。
- 单例 `cliAuthManager`,sidecar 退出 `stopAll`。

### B3. cli-executor 抽 buildCliEnv + 加 spawnCli

- 抽 `buildCliEnv(env?, denyList?): Record<string,string|undefined>`(`{...process.env}`→merge env→delete denyList),`execCli` 内部改用它(DRY)。
- 加 `spawnCli(command, args, options): ChildProcess`——spawn 裸进程,env 用 buildCliEnv,不收集输出。auth manager 监听其 stdout/stderr/exit。

### B4. 二进制下载校验（解压支持）

`cli-binary-manager` 改造为支持压缩包:
- `CliProviderConfig` 加下载策略字段:`downloadStrategy: { buildUrl(platform,arch); checksums: Record<string,string>; archive: 'tgz'|'zip'|'npm-tgz'; binaryPathInArchive: (platform,arch)=>string }`。
- `ensureBinary`:env 路径 → 缓存 → 下载 → 解压(tgz 用 `node:zlib`+`tar-stream` 或 wanta 的无依赖 extract;zip 用跨平台 lib)→ 取 binaryPathInArchive → sha256 校验 checksums → 落盘 0o755。
- 三渠道 checksum 表 + buildUrl + archive 类型(待 wanta 数据回填,见 §8)。
- `fetchTarball` 注入点保留(测试 mock)。

## 6. IPC + UI

### C1. IPC
- `IM_IPC_CHANNELS`(`packages/shared/src/types/im.ts:111`)加:`START_CLI_AUTH`/`POLL_CLI_AUTH`/`CANCEL_CLI_AUTH`。
- `im-handlers.ts` 加 3 handler(委托 `cliAuthManager`),依赖注入 `authManager?`。
- `schemas.ts` 加 input schema(`{provider}`/`{sessionKey}`)。
- shared types 加 `CliAuthStartResult`/`CliAuthPollResult`。

### C2. desktop-api
`apps/web/src/lib/desktop-api/im.ts` 加 `startCliAuth`/`pollCliAuth`/`cancelCliAuth`(sidecarCall)。

### C3. UI
`ImSettings.tsx` 主面板加**"企业 CLI 能力"独立 section**(provider 级,不挂账号行):
- 三行(钉钉/飞书/企微):provider 名 + 授权状态 badge + 按钮(授权/重新授权)。
- 点击 → `handleStartCliAuth(provider)` → `startCliAuth` 拿 authUrl → 调 desktop `openExternal` → 起 `pollCliAuth` 2.5s 轮询 → 更新 badge+按钮。
- 状态映射 `idle/authorizing/connected/error` → 复用 `ImStatusTone` 配色。
- `im-settings-state.ts` 加纯函数:`formatCliAuthPhase(phase)`、`shouldKeepPollingCliAuth(result)`。

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 二进制缺失/下载失败 | `startAuth` 返回 `error`("CLI 未就绪,可重试或设 `LUME_<PROVIDER>_CLI_BIN`") |
| 授权超时(authTimeoutMs) | timer kill proc → `pollAuth` phase=error("授权超时") |
| 用户取消 | `cancelAuth` kill proc + 清 session |
| 授权失败(exit 非 connected) | `pollAuth` phase=error(含 stderr 摘要) |
| 孤儿 session | authTimeoutMs timer 兜底 + sidecar 退出 `stopAll` |
| openExternal 失败 | web 捕获 → toast + 降级显示 URL 供手动复制 |

## 8. 测试（bun:test,注入模式）

参照 `dingtalk-stream-worker.test.ts` 的 fake 注入模式。
- `cli-auth-manager.test.ts`:fake `spawnCli`(可控 emit stdout/exit)、fake `ensureBinary` → 验证 startAuth 拿 authUrl、pollAuth 状态机(authorizing→connected/error)、超时、cancel、stopAll。
- `providers/*.test.ts`:三渠道 `parseAuthStatus`(钉钉 JSON/飞书/企微)、`authUrlPattern` 命中。
- `cli-binary-manager.test.ts`:fake fetchTarball → 校验通过/失败、解压取 binary、缓存命中、env 路径 fallback。
- `cli-executor.test.ts`:`buildCliEnv` 净化(denyList 优先)、`spawnCli` 返回 proc。
- `im-handlers.test.ts`:3 新 handler(注入 fake authManager)。
- `im-settings-state.test.ts`:`formatCliAuthPhase`/`shouldKeepPollingCliAuth`。

## 9. 验收清单

**自动(bun:test)**
- [ ] im-cli 域全绿(manager/executor/binary-manager/providers)
- [ ] im-handlers 新 handler 测试通过
- [ ] im-settings-state 新纯函数测试通过
- [ ] web typecheck 绿

**手动(需企业账号 + 联网,交付后由用户验收)**
- [ ] 钉钉:授权→浏览器 OAuth→connected→agent 调 `dingtalk_cli` 发消息成功
- [ ] 飞书:授权→浏览器 OAuth→connected→agent 调 `feishu_cli`
- [ ] 企微:授权→扫码→connected→agent 调 `wecom_cli`
- [ ] 三渠道 `ensureBinary` 首次下载(联网)成功 + sha256 校验通过

## 10. 实现切片（提交粒度，emoji 前缀）

1. `♻️ refactor(im-cli): 抽 buildCliEnv + 加流式 spawnCli` — cli-executor DRY 改造
2. `✨ feat(im-cli): 泛化 config auth 解析器(三渠道 parseAuthStatus)` — providers + config 字段
3. `✨ feat(im-cli): cli-auth-manager(start/poll/cancel 状态机)` — + 测试
4. `✨ feat(im-cli): 二进制下载解压校验(移植 wanta)` — cli-binary-manager + 三渠道 checksum
5. `✨ feat(im): CLI 授权 IPC handler + schema` — im-handlers + shared types + IM_IPC_CHANNELS
6. `✨ feat(im-web): 企业 CLI 能力授权 UI` — ImSettings section + desktop-api + im-settings-state
7. `📝 docs: 出站 CLI 接通设计文档` — 本 spec

## 11. 已核实数据（wanta 移植源）

### 钉钉 dws v1.0.55
- 下载:`https://registry.npmjs.org/dingtalk-workspace-cli/-/dingtalk-workspace-cli-1.0.55.tgz`(npm tarball)
- 两段校验:整包 sha512-base64 `0h4qxnHT3KUgNgzgUzwczZfnS0oKv9hc9mUPphJUZerqYjg6LtWtOvJRgFiMMCo9TfSmcx5/NfoItO7d1xmeVQ==`,再各 asset sha256。
- asset sha256(包内 `package/assets/<name>`):darwin-amd64 `f465eb7a...` / darwin-arm64 `dd753bbd...` / linux-amd64 `051ba404...` / linux-arm64 `5961be0f...` / windows-amd64 `9e273fa5...` / windows-arm64 `2c417f89...`(完整值见 providers/dingtalk.ts)。
- 平台:darwin/linux→tar.gz、win32→zip;arch x64→amd64。包内 asset 再解压取 `dws`/`dws.exe`。
- authUrlPattern:`https://login.dingtalk.com/oauth2/auth`(hostname+pathname 精确,port 空,无 userinfo)。

### 飞书 lark-cli v1.0.81
- 下载:`https://github.com/larksuite/cli/releases/download/v1.0.81/<asset>`(GitHub release,非 npm)
- 单段 sha256:asset `lark-cli-1.0.81-<platform>-<arch>.{tar.gz|zip}`。darwin-amd64 `8efdf270...` / darwin-arm64 `0693846b...` / linux-amd64 `4c783dc4...` / linux-arm64 `31691d83...` / windows-amd64 `d6ba5f47...` / windows-arm64 `c4305ddb...`(完整值见 providers/feishu.ts)。
- 解压即单文件 binary `lark-cli`/`lark-cli.exe`。
- authUrlPattern:`feishu.cn`/`*.feishu.cn`/`larksuite.com`/`*.larksuite.com`(port 空或 443)。

### 企微 wecom-cli v0.1.9
- 下载:npm 子包 `@wecom/cli-<platform>-<arch>`(darwin/linux/win32 × arm64/x64,win32 仅 x64),版本 0.1.9。
- 校验:registry packument 的 `dist.integrity`(实时取,不硬编码)+ `gitHead` 必须等于 `72e14f7695f34d28f1ff23ea504ddd2210a87c13`。
- 包内 `package/bin/wecom-cli`/`wecom-cli.exe`,npm tarball 解压。
- authUrlPattern:`work.weixin.qq.com/ai/qc/gen`(pathname 精确,必须带 `scode` 查询参数)。

### 解压依赖
- tar.gz:`node:zlib`(gunzipSync)+ 自定义 tar entry 解析(仿 wanta `extractFileFromTar`,无依赖)。
- zip:需跨平台库(评估 `jszip` 或 sidecar 现有依赖;见 package.json)。
