# 模型设置支持自定义添加模型 — 设计文档

- **日期**: 2026-06-13
- **作者**: brainstorming session
- **状态**: 待实现

## 背景与现状

设置页的「模型设置」（`AgentSettings` → `ProviderConfigurationWorkbench` → `ChannelForm`）目前只能通过「拉取模型列表」按钮，调用厂商 `/models` 接口**全量获取**模型，且拉取是**全量替换**整个 `models` 数组：

- `apps/web/src/components/settings/ChannelForm.tsx` 的 `handleFetchModels` 中 `setModels(r.models)` 直接覆盖。
- 模型列表 UI 只在 `models.length > 0` 时显示（即必须先拉取成功才看得到任何东西）。
- 没有任何手动添加单个模型的入口。

**痛点**：当厂商的 `/models` 接口未返回某个模型（新模型、接口限制、私有部署模型），用户无法把它加进来。

## 目标

在模型区新增「手动添加模型」能力，与「拉取模型列表」并列。让用户在任意渠道下都能补录单个模型，且再次拉取时手动添加的模型不会被清空。

**关键决策**（已与用户确认）：

1. **入口交互**：按钮 → 内联展开输入框（与「拉取模型列表」按钮风格一致）。
2. **拉取策略**：合并保留（按 id 去重，手动添加且厂商未返回的予以保留）。
3. **适用范围**：所有渠道（内置 anthropic/openai 等 + custom）均可手动添加。

## 设计

### 改动范围（极小）

**仅改动一个前端文件**：`apps/web/src/components/settings/ChannelForm.tsx`

- **后端零改动**：`ChannelModel`（`id/name/alias?/capabilities?/enabled`）字段已够用；`channel:update` IPC 本就接受任意 `models[]`。
- 不新增 IPC 端点、不新增类型字段、不触碰持久化（`channels.json`）与加解密逻辑。

### 1. 合并去重逻辑（核心）

在 `ChannelForm.tsx` 中新增与现有 `filterChannelModels` 并列的纯函数并导出：

```ts
export function mergeChannelModels(existing: ChannelModel[], fetched: ChannelModel[]): ChannelModel[] {
  const fetchedIds = new Set(fetched.map((m) => m.id))
  const preserved = existing.filter((m) => !fetchedIds.has(m.id))
  return [...fetched, ...preserved]
}
```

`handleFetchModels` 内：

```ts
// 旧: setModels(r.models)
setModels((prev) => mergeChannelModels(prev, r.models))
```

**语义**：
- 手动添加的模型，若厂商 `/models` 也返回了 → 用拉取结果（元数据更准），按 id 覆盖。
- 手动添加的模型，厂商未返回 → 保留（补录新模型的核心场景）。
- 拉取结果在前（保留厂商顺序），手动保留项在后。

### 2. 手动添加 UI（按钮 → 内联展开）

在模型区标题行，「拉取模型列表」按钮**左侧**加「+ 手动添加」按钮。该按钮始终可见（即便 `models` 为空、尚未拉取也能用，解决"必须先拉取才看到模型列表"的限制）：

```
模型          [+ 手动添加]   [拉取模型列表]
```

点击后在下方展开输入区，由新增的 `showAddModel` state 控制：

- **模型 ID**（必填，如 `claude-sonnet-4-5`）
- **显示名**（可选，留空时自动取 ID）
- 「取消」「添加」按钮

新增 state：`showAddModel`、`newModelId`、`newModelName`、`addError`。

**添加逻辑**（`handleAddModel`）：

1. `id = newModelId.trim()`；为空 → `addError = '请输入模型 ID'`，终止。
2. `models` 中已存在同 id → `addError = '该模型已存在'`，终止。
3. 否则：`name = newModelName.trim() || id`，调用共享包已有的 `normalizeChannelModel({ id, name, enabled: true, provider })` 规整后追加到 `models`，清空 `newModelId`/`newModelName`/`addError`，收起 `showAddModel`。

复用 `normalizeChannelModel`（来自 `@lume/shared`）保证手动添加的模型与拉取的模型走同一套规整逻辑（trim、name 兜底、`inferChannelModelCapabilities` 推断 chat/embedding 能力）。

> 说明：`ChannelForm.tsx` 当前已从 `@lume/shared` import 了若干符号，新增 `normalizeChannelModel` 到同一 import 语句即可。

### 3. 测试

参照项目已有的 `apps/web/src/components/model-selection/model-selection-state.test.ts` 风格，为新增纯函数加单测。测试文件：`apps/web/src/components/settings/channel-form.test.ts`（与 `ChannelForm.tsx` 同目录，与现有 `model-selection-state.test.ts` 平行）。

覆盖 `mergeChannelModels` 的分支：
- 厂商返回的与手动保留的合并去重。
- 手动添加且厂商也返回 → 被厂商结果覆盖（用厂商的 name）。
- 手动添加且厂商未返回 → 保留原对象。
- 空数组场景。

（手动添加的去重与规整为组件内联逻辑，可通过上述纯函数 + UI 交互验证覆盖，无需为内联 handler 单独 mock。）

## 验证标准

- [ ] 任意渠道（anthropic / openai / custom）点「+ 手动添加」，输入 ID 后能加入列表并默认勾选。
- [ ] 添加已存在 ID 时显示「该模型已存在」，不重复添加。
- [ ] 显示名留空时，列表中显示 ID 作为名称。
- [ ] 手动添加若干模型后点「拉取模型列表」：厂商未返回的手动模型仍在；厂商也返回的被拉取结果覆盖。
- [ ] 保存渠道 → 重新打开编辑 → 手动添加的模型仍在（落盘正常）。
- [ ] 对话页 `ModelPicker` 能选到手动添加的模型。
- [ ] `mergeChannelModels` 单测通过。

## 非目标（YAGNI）

- 不为 `ChannelModel` 新增 `source`/`custom` 标记字段——按 id 合并已足够满足需求。
- 不新增后端 IPC（如 `channel:add-model`）——复用 `channel:update` 整批保存即可。
- 不做手动添加模型的实时连通性校验——用户可在保存后用现有「测试」能力验证整个渠道。
- 不引入全局 channels store——维持现状各组件本地 `useState`。
- 不改动 `model-meta.ts` 静态注册表。
