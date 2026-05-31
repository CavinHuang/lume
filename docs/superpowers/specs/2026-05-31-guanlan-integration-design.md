# Guanlan 搜索集成设计

## 概述

为 Lume 集成 guanlan 的本地搜索能力，目标是吸收 Alice 的长处：本地能力托管、运行时状态可见、搜索结果结构化、可配置启停、失败时可回退；同时遵循 Lume 现有分层：配置归 `lume-config`，桌面/进程依赖归 sidecar，Agent 面向标准工具使用搜索能力。

第一版不把 Python 运行时下载器塞进 SDK。SDK 只负责搜索工具编排和受限的 `python -m guanlan` 调用；sidecar 负责 guanlan/Python 的探测、standalone Python 下载、guanlan 安装、状态测试和环境变量注入；web 负责配置入口。客户端没有 Python 时，Lume 会在 sidecar 准备路径自动下载托管 Python runtime。

## 目标

- 在现有网络搜索设置中加入 `guanlan` provider，可启停、可测试。
- WebSearch 优先级链路支持 guanlan，并在失败或不可用时继续回退到现有 provider。
- WebSearch 消费现有 `webSearch.providers.*.enabled` 配置，避免设置页开关有名无实。
- sidecar 提供 guanlan runtime service，执行 `python -m guanlan`，统一解析输出。
- 支持客户端无 Python 的可解释失败：不开启时不影响现有搜索；开启但不可用时测试按钮和工具结果给出明确原因。
- 不新增 npm 依赖，不引入与 Lume 当前架构相冲突的全局 Python 假设。

## 非目标

- 不做 renderer 下载进度 UI；第一版下载在 sidecar 内部完成，失败时返回明确错误。
- 不新增独立 `GuanlanResearch` 复杂研究工具。
- 不改变现有 WebSearch/WebFetch 的用户提示和通用工具名。
- 不把 guanlan 作为必需依赖打进 SDK。

## Alice 参考点

Alice 的实现特点：

- 主进程启动时先 `ensurePythonReady()`，再 `ensureGuanlanReady()`。
- Python 优先放在用户数据目录，旧 resources Python 会迁移到 userData。
- guanlan 通过 `python -m guanlan <command>` 调用。
- 设置页有 `guanlanEnabled` 开关。
- 工具暴露为只读搜索/阅读/热点能力，并限制调用次数。

Lume 采用其中的模式，但调整落点：

- 不在 renderer 或 SDK 直接管理 Python。
- 不新增独立设置存储，复用 `lume-config.webSearch.providers`。
- 通过现有 ToolRuntime 的只读网络工具策略承载风险和可见性。

## 架构

```
apps/web/settings
  WebSearchSettings
      |
      v
apps/sidecar/rpc
  testSearchBackend({ provider: "guanlan" })
      |
      v
apps/sidecar/services/infra
  guanlan-runtime-service
      |
      v
packages/sdk/tools
  WebSearchTool provider fallback
      |
      v
sidecar 注入的 Python/Guanlan env
      |
      v
python -m guanlan search
```

### 配置层

修改 `packages/shared/src/types/general-settings.ts`：

```ts
export type WebSearchProvider =
  | "guanlan"
  | "exa"
  | "tavily"
  | "brave"
  | "duckduckgo"
  | "pipellm"
  | "zhipu"
  | "bing"
```

修改 `DEFAULT_LUME_WEB_SEARCH`：

```ts
providers: {
  guanlan: { enabled: false },
  duckduckgo: { enabled: true },
  bing: { enabled: true }
}
```

配置仍然写入 `lume.yaml` 的 `webSearch.providers.guanlan.enabled`。不需要 API key。

### sidecar runtime

新增 `apps/sidecar/src/services/infra/guanlan-runtime-service.ts`。

职责：

- 查找 Python：
  - `process.env.LUME_PYTHON` 显式指定。
  - Lume 私有目录，建议路径为 `getConfigDir()/runtime/python`。
  - 系统命令：`python3`，再 `python`。
- Python 不存在时：
  - 下载 python-build-standalone `cpython-3.11.15+20260414`。
  - 解压到 `getConfigDir()/runtime/python`。
  - 再重新探测 Python。
- 检查 guanlan：
  - `python -m guanlan --version` 或轻量命令。
  - 不可用时尝试 `python -m pip install --upgrade guanlan`。
- 执行 guanlan：
  - search：`python -m guanlan search <query> --profile china --limit <n>`
  - read：预留 `python -m guanlan read <url>`
  - hotnews：预留 `python -m guanlan hotnews --source today --limit <n>`
- 统一超时、stderr 截断、JSON/文本输出解析。

返回类型建议：

```ts
interface GuanlanSearchResult {
  title: string
  url: string
  snippet?: string
  sourceType?: string
  evidenceRole?: string
  domain?: string
}

interface GuanlanRuntimeStatus {
  ok: boolean
  pythonPath?: string
  guanlanVersion?: string
  error?: string
}
```

### SDK WebSearch

`packages/sdk/src/tools/web-search.ts` 增加 guanlan provider attempt，但不直接管理 Python 下载或 pip 安装。

最小可行实现方式：

- SDK 通过 sidecar 注入的环境变量判断 provider 启用顺序：
  - `LUME_WEB_SEARCH_PROVIDERS=guanlan,exa,pipellm,...`
  - 没有该变量时保持当前默认 fallback 行为，兼容 SDK 单独使用场景。
- SDK 通过环境变量判断 guanlan 执行方式：
  - `LUME_GUANLAN_ENABLED=1`
  - `LUME_GUANLAN_PYTHON=/path/to/python`
  - 未指定 Python 时使用 `python3`，再使用 `python`。
- `syncWebSearchEnvVars` 在读取有效配置时同步：
  - `process.env.LUME_WEB_SEARCH_PROVIDERS`：只包含 enabled provider，按配置顺序。
  - `process.env.LUME_GUANLAN_ENABLED = enabled ? "1" : ""`
  - `process.env.LUME_GUANLAN_PYTHON`：来自 guanlan runtime service 的已探测 Python。
- WebSearch 的默认 attempts 顺序：
  - guanlan
  - Exa
  - PipeLLM
  - Zhipu
  - Tavily
  - Brave
  - DuckDuckGo
  - Bing

如果 guanlan 不可用，attempt 返回 `null` 或抛出后被现有 fallback 捕获。

`joint` 策略第一版仍可降级为 priority 语义。Lume 现有 SDK 尚未实现多 provider 并发合并，guanlan 集成不在本轮扩大这一行为面；但 provider enabled/order 必须生效。

### Web 设置页

`apps/web/src/components/settings/WebSearchSettings.tsx` 加入 provider meta：

- id：`guanlan`
- label：`Guanlan`
- description：`本地搜索能力，适合中文/国内信息场景，无需 API Key`
- needsApiKey：`false`
- badge：`本地`

测试按钮调用现有 `testSearchBackend({ provider: "guanlan" })`。测试失败时复用现有失败状态；具体错误由 sidecar 返回。

### 测试服务

`apps/sidecar/src/services/infra/search-test-service.ts` 加 `guanlan` case：

- 如果 provider 为 `guanlan`，调用 `getGuanlanRuntimeStatus()`。
- 成功返回 `{ ok: true, provider: "guanlan" }`。
- 失败返回 `{ ok: false, provider: "guanlan", error }`。

## Python 依赖处理

第一版采用三层处理：

1. **显式 Python**：`LUME_PYTHON`，用于开发、CI、手动配置。
2. **Lume 私有 Python 目录**：`~/.lume/runtime/python`，作为未来下载器目标。
3. **系统 Python**：`python3` / `python`。

客户端没有 Python 时：

- 设置页测试会触发 sidecar `ensureReady()`，自动下载托管 Python 并安装 guanlan。
- 自动下载失败时显示原因：`未找到 Python，且自动下载 Python 运行时失败。可安装 Python 3.11+ 或配置 LUME_PYTHON。`
- WebSearch 不因 guanlan 不可用而整体失败，只继续尝试后续 provider。
- 不在工具调用期间弹 UI，不阻塞 Agent。

后续增强可以补下载进度事件和旧 runtime 迁移；第一版先保证无 Python 客户端能通过 sidecar 准备路径自愈。

## 数据流

### 配置保存

1. 用户在 WebSearchSettings 开启 Guanlan。
2. web 调 `updateWebSearchConfig`。
3. sidecar 写入 `lume.yaml`。
4. `getEffectiveLumeConfig` 合并配置并调用 `syncWebSearchEnvVars`。
5. sidecar 探测可用 Python，并注入 `LUME_GUANLAN_PYTHON`。
6. 后续 Agent run 的 WebSearch provider chain 读取 env。

### 搜索调用

1. Agent 调用 `WebSearch({ query, num_results })`。
2. WebSearch 读取 `LUME_WEB_SEARCH_PROVIDERS` 获取启用 provider 顺序。
3. guanlan attempt 检查 `LUME_GUANLAN_ENABLED` 并执行 runtime command。
4. 成功时格式化成现有 WebSearch 输出。
5. 失败时记录 lastError，并继续后续 provider。

## 错误处理

- Python 不存在：明确提示，不安装失败伪装成搜索失败。
- pip 安装失败：返回 stderr 摘要，限制长度。
- guanlan 超时：默认 20s，返回超时错误并 fallback。
- 输出不是 JSON：尝试按文本块解析，解析失败则返回工具错误。
- provider 未启用：直接跳过。

## 安全与权限

- guanlan 是只读网络能力，metadata 沿用 WebSearch 的 network/read-only 分类。
- 不接受任意命令输入；query/url/source/limit 做白名单或长度限制。
- `limit` clamp 到 1-10。
- stdout/stderr 截断，避免巨大输出污染上下文。
- 不把 API key、路径等敏感信息写入工具输出。

## 实现文件

预计修改：

- `packages/shared/src/types/general-settings.ts`
- `packages/shared/src/types/lume-config.ts`
- `packages/shared/src/tool-names.ts`
- `apps/sidecar/src/services/system/lume-config-service.ts`
- `apps/sidecar/src/services/infra/search-test-service.ts`
- `apps/sidecar/src/services/infra/guanlan-runtime-service.ts`
- `apps/web/src/components/settings/WebSearchSettings.tsx`
- `packages/sdk/src/tools/web-search.ts`

预计测试：

- `apps/sidecar/src/services/system/lume-config-service.test.ts`
- `apps/sidecar/src/services/infra/search-test-service.test.ts` 如不存在则加 focused test
- `packages/sdk/src/tools/web-search.test.ts` 或现有 tools test 中覆盖 provider fallback

## 验收标准

- Web 搜索设置页能看到 Guanlan provider，可启停、可测试。
- `lume.yaml` 能保存 `webSearch.providers.guanlan.enabled`。
- 开启 guanlan 后，WebSearch 优先尝试 guanlan。
- guanlan 不可用时不会破坏现有 WebSearch fallback。
- 客户端没有 Python 时，测试入口和工具结果都有明确原因。
- 不新增 npm 依赖。
- 相关 focused tests 通过。
