# Image Generation Tool Design

## Goal

实现真正的 `image_gen` 工具，让它读取已配置的 `models.imageGeneration.priorityModelRefs`，调用对应 provider 的图像生成 API 生成图片，按优先级失败回退，并把结果以线程附件形式呈现给用户。同时提供 `list_image_models` 工具，让 agent 能查询可用图像模型。

填充现有"配置 + UI 已就绪、运行时调用点未接"的缺口。

## Background

当前状态（探索结论）：

- **没有 `image_gen` 工具实现**。`apps/sidecar/src/services/agent-runtime/tools/` 下无任何图像生成工具；`create-lume-tools.ts` 装配入口也未引入。
- **只有占位 Skill**：`apps/sidecar/default-skills/image-gen/SKILL.md` 是纯提示词助手，带 `disable_model_invocation: true`，并明确声明"当前 Lume 尚未接入 image_gen、list_image_models"。`agent-artist/SKILL.md` 同样声明。
- **配置链路完整但运行时零消费**：`LumeConfigImageGenerationStrategy.priorityModelRefs`（`packages/shared/src/types/lume-config.ts:23-25`，注册于 `:76`）→ Zod schema（`apps/sidecar/src/rpc/schemas.ts:537`）→ 归一化/持久化（`apps/sidecar/src/services/system/lume-config-service.ts:138`）→ 设置 UI"图像生成模型优先级"（`apps/web/src/components/settings/AgentSettings.tsx:899`，文案承诺"失败时自动尝试下一个"）。但 sidecar 运行时没有任何代码读取 `priorityModelRefs`。
- **Agent SDK 不支持图像生成**：`packages/sdk/src` 无任何 `images/generations` / `generateImage` 调用，需 sidecar 自实现 HTTP 调用。
- 设计文档 `2026-06-19-model-action-settings-design.md` 已明确将"图像生成调用点"列为后续工作。

## Key Technical Findings（决策依据）

1. **豆包与 OpenAI 兼容同源**：`apps/sidecar/src/providers/index.ts:41` 已用 `OpenAIAdapter` 处理豆包；火山 Ark（`ark.cn-beijing.volces.com/api/v3`）的 Seedream 走 OpenAI 兼容的 `/images/generations`。OpenAI / 豆包 / StepFun / siliconflow 全是同一协议家族。
2. **凭证解析现成**：`resolveChannelModelBinding(modelRef, capability?)`（`apps/sidecar/src/services/channel/channel-manager.ts:231`）从 `provider/model` 解析到 `{ channel, modelId, family }`。不传 `capability` 即可匹配任意 enabled 图像模型（图像模型通常未标 chat capability）。apiKey 用 `decryptApiKey(channel.id)`（`channel-manager.ts:190` 导出，参数为 channelId）解密。
3. **图片输出有现成落点**：线程附件链路——`SAVE_FILES_TO_THREAD`（`agent-handlers.ts:1383`）保存 → `AgentMessageAttachmentInput.threadPath`（`agent.ts:1134`）引用 → 前端 `READ_THREAD_FILE_DATA` + `AgentAttachmentGrid` 渲染；agent 文本里的 `threadPath` 也被 `thread-file-links` 渲染为可预览链接。
4. **provider 特有生成参数**（StepFun `cfg_scale`/`steps`/`text_mode`/`seed`）必须由 profile 吸收，不暴露到 agent 统一 schema。

## Scope

已确认的范围决策：

| 维度 | 决策 |
|---|---|
| Provider | OpenAI 兼容 + 豆包 Seedream + StepFun（协议同源，一套适配器） |
| 生成能力 | 文生图 + 图生图（参考图）+ 图片编辑/重绘（mask） |
| 模型选择 | 工具内部按 `priorityModelRefs` 自动回退；额外提供 `list_image_models` |
| 架构 | 方案 A：单一 OpenAI 兼容适配器 + `ImageProviderProfile` 表 |
| 模式判定 | 由参数存在性隐式区分（无显式 `mode` 字段） |
| `model` 参数 | 保留（agent 可显式指定，仍走回退） |
| 生成数量 | 固定 1 张（不暴露 `n`） |
| provider 特有参数 | 封进 profile 默认值，不进 agent schema |

## Architecture

方案 A：单一 OpenAI 兼容适配器 + provider profile。沿用现有 `tools/<group>/` 模式，新建 `image-gen` 工具组：

```
apps/sidecar/src/services/agent-runtime/tools/image-gen/
├── create-image-gen-tools.ts    # 定义 image_gen + list_image_models 工具，工具组入口
├── image-gen-core.ts            # 读配置→解析凭证→调用→失败回退→保存→返回 threadPath
├── image-provider-profiles.ts   # ImageProviderProfile 表：size 映射、参考图/mask 传法、响应解析、特有参数
├── image-gen-http.ts            # OpenAI 兼容 /images/generations、/images/edits 的 HTTP 调用 + abortSignal
└── image-gen-output.ts          # 图片下载/解码 → 写入线程文件目录 → 产出 threadPath
```

装配：`create-lume-tools.ts` 引入 `createImageGenTools({ threadId, workspaceSlug })`，加入 `customTools`；`image_gen`、`list_image_models` 加入 `availableToolNames`。

**不新增任何基础设施**，只填充调用点：复用配置读取、凭证解析、线程文件存储、前端渲染。

## Data Flow

`image_gen` 一次调用：

```
读 getEffectiveLumeConfig(workspaceSlug).models.imageGeneration.priorityModelRefs
   （空 → 直接返回错误"未配置图像生成模型"，不进入循环）
   ▼
modelRefs = agent 显式传 model ? [model, ...priorityModelRefs 去重] : priorityModelRefs
   ▼
for each modelRef（按优先级）:
   ├─ resolveChannelModelBinding(modelRef)  → { channel, modelId, family }   // 不传 capability
   │     无 binding → 记录"渠道未配置/未启用"，continue
   ├─ apiKey = decryptApiKey(channel.id)；profile = 按 channel.provider 查表
   ├─ 模式判定（隐式）：
   │     无 reference_image           → 文生图  POST {baseUrl}/images/generations
   │     有 reference_image、无 mask  → 图生图  POST {baseUrl}/images/edits
   │     有 reference_image + mask    → 编辑    POST {baseUrl}/images/edits（带 mask）
   ├─ image-gen-http 调用，全程携带 abortSignal
   │     成功 → 解析响应（data[0].url 或 data[0].b64_json）→ 跳出循环
   │     失败 → 记录 {modelRef, error}，continue
   ▼
全部失败 → 抛聚合错误（列出每个 modelRef 的失败原因）
   ▼
image-gen-output：下载 URL / 解码 base64 → 写 getAgentThreadFilesPath(workspaceSlug, threadId)/image-gen/<ts>-<id>.<ext>
   ▼
返回 { images:[{threadPath,filename,mediaType,size}], modelUsed, mode }
   ▼
agent 在回复文本里引用 threadPath → 前端 thread-file-links + AgentAttachmentGrid 渲染图片
```

## Tool Interface

### `image_gen`

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `prompt` | string | ✅ | 生成提示词（建议英文，agent 可自译） |
| `size` | string | ❌ | `1024x1024` / `1:1` / `16:9`；profile 负责映射到 provider 实际支持的尺寸；未传则不发送 size |
| `reference_image` | string | ❌ | 参考图 `threadPath`（相对线程目录）；存在即进入图生图模式 |
| `mask_image` | string | ❌ | 编辑/重绘蒙版 `threadPath`；存在即进入编辑模式（须与 reference_image 同传） |
| `model` | string | ❌ | 显式指定 modelRef（覆盖自动选择，仍回退到 priorityModelRefs） |

模式判定：无图 → `text-to-image`；有 `reference_image` 无 `mask` → `image-to-image`；有 `reference_image` + `mask` → `edit`；仅传 `mask_image` 而无 `reference_image` → 参数错误。

返回：

```jsonc
{ "data": {
    "images": [
      { "threadPath": "image-gen/<ts>-<id>.png", "filename": "...", "mediaType": "image/png", "size": 12345 }
    ],
    "modelUsed": "doubao/seedream-3-0-t2i",
    "mode": "text-to-image"
}}
```

### `list_image_models`

无参数。从 `getEffectiveLumeConfig().models.imageGeneration.priorityModelRefs` 解析，逐个用 `resolveChannelModelBinding` 探测可用性：

```jsonc
{ "data": { "models": [
  { "modelRef": "doubao/seedream-3-0-t2i", "provider": "doubao", "modelId": "seedream-3-0-t2i", "available": true, "priority": 1 },
  { "modelRef": "openai/gpt-image-1", "provider": "openai", "modelId": "gpt-image-1", "available": false, "reason": "渠道未配置/未启用", "priority": 2 }
]}}
```

## Image Output

- **保存位置**：`getAgentThreadFilesPath(workspaceSlug, threadId)` 下的 `image-gen/` 子目录（与 reading 的 assets 子目录模式一致）。
- **文件名**：`<Date.now()>-<shortHash>.<ext>`，ext 由响应内容决定（png/jpg/webp），默认 png。
- **写入**：URL → `fetch` 下载；b64_json → Buffer 解码；`fs.writeFileSync` 到绝对路径（工具上下文已有 `workspaceSlug`/`threadId`）。
- **threadPath**：相对线程目录路径 `image-gen/<ts>-<id>.<ext>`，前端 `READ_THREAD_FILE_DATA` 据此读取。
- **参考图输入**：`reference_image`/`mask_image` 接受 `threadPath`，工具内解析成绝对路径读取上传（与 thread-file 机制一致）。
- **abortSignal**：HTTP 全程携带工具上下文的 `abortSignal`，与项目"停止即时中断"（commit 51324559）一致。

## Provider Profile

```ts
interface ImageProviderProfile {
  mapSize?: (size?: string) => string | undefined;   // "1:1"/"16:9" → provider 实际尺寸
  responseFormat: "url" | "b64_json";                 // 请求 response_format + 响应解析依据
  extraBody?: Record<string, unknown>;                // 文生图 JSON 的 provider 特有参数
  extraFormFields?: Record<string, string>;           // 编辑 multipart 的 provider 特有参数
  editImageField?: string;                            // 默认 "image"
  editMaskField?: string;                             // 默认 "mask"
}
```

| provider key | responseFormat | extraBody / extraFormFields | 说明 |
|---|---|---|---|
| `openai`（默认兜底） | `b64_json` | 无 | gpt-image-1；表未命中时用此 |
| `doubao` | `url` | 无 | 火山 Ark Seedream |
| `stepfun` / `stepfun-coding-plan` | `b64_json` | `{steps:8, cfg_scale:1.0, text_mode:true}` | step-image-edit-2 |

provider 识别：取 `channel.provider`（或 `providerId`）查表；未命中 → 默认 profile。

**extraBody vs extraFormFields**：文生图走 JSON，用 `extraBody`（值为原始类型，如 `steps:8`）；图生图/编辑走 multipart，用 `extraFormFields`（值须为字符串，如 `steps:"8"`）。同一 provider 的两组字段语义相同、类型不同，由 profile 各自提供。

## API Call Details

baseUrl **直接拼接** `/images/generations`、`/images/edits`（channel.baseUrl 已含版本段：OpenAI `/v1`、豆包 `/api/v3`、StepFun `/step_plan/v1`，与现有 chat 请求拼接方式一致）。

- **文生图**：`POST {baseUrl}/images/generations`
  - `Content-Type: application/json`、`Authorization: Bearer {apiKey}`
  - body：`{ model, prompt, size: profile.mapSize(size), response_format: profile.responseFormat, ...profile.extraBody }`
- **图生图/编辑**：`POST {baseUrl}/images/edits`（multipart/form-data）
  - `image`=<参考图 bytes>、可选 `mask`=<蒙版 bytes>、`model`、`prompt`、`response_format`、`size`、`...profile.extraFormFields`
- `abortSignal` 传入 fetch。
- 非 2xx 或响应缺 `data` → 抛错（触发回退）。

## Fallback Logic

```
priorityModelRefs 空 → 报错"未配置图像生成模型"
agent 传 model → [model, ...priorityModelRefs 去重]（显式优先，仍回退）
for modelRef of modelRefs:
  binding = resolveChannelModelBinding(modelRef)
  无 binding → 记录失败，continue
  profile = 按 channel.provider 查表
  调 http（按参数隐式判定模式）
    成功 → output 保存 → 立即返回（含 modelUsed）
    失败 → 记录 {modelRef, error}，continue
全部失败 → 抛聚合错误（每个 modelRef 的失败原因）
```

## Skill & Test Updates（必改）

1. **`default-skills/image-gen/SKILL.md`**：从"提示词助手（声明未接入）"改为"引导调用真工具"——去掉 `disable_model_invocation: true`，`allowed_tools` 改为 `["image_gen","list_image_models"]`，删除所有"当前不能生成"声明。
2. **`default-skills/agent-artist/SKILL.md`**：同样删除"未接入 image_gen"声明。
3. **`default-skills-inventory.test.ts:49-50`**：当前断言 allowedTools **不含** image_gen/list_image_models → 反转为**含**这两个工具。

## Testing Strategy（全部 mock，不联网）

- `image-provider-profiles.test.ts`：size 映射、extraBody 注入、provider 识别（openai/doubao/stepfun/未知→默认）。
- `image-gen-core.test.ts`：主成功 / 主失败回退备 / 全部失败聚合错误 / 空配置报错 / 显式 model 优先。mock http 层。
- `image-gen-http.test.ts`：文生图 JSON 与编辑 multipart 构造、baseUrl 拼接（3 种版本段）、响应解析（url/b64）、非 2xx 抛错。mock fetch。
- `image-gen-output.test.ts`：url 下载 / b64 解码 → 写线程文件 → 正确 threadPath。临时目录。
- `create-image-gen-tools.test.ts`：工具注册、参数校验（reference_image+mask 编辑模式、缺 prompt 报错）、装配进 `create-lume-tools`（`availableToolNames` 含两个工具）。

## Out of Scope（YAGNI）

- Google Imagen / Midjourney 原生协议适配（留待将来；届时再升级为 adapter 接口，重构成本小）。
- 图像生成流式（图像 API 无流式）。
- 图片历史/画廊 UI（落盘到线程文件即可，前端现有机制展示）。
- 真实 provider 联网测试（CI 不依赖外部 API）。
- provider 特有参数暴露到 agent schema。
