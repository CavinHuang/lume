# 插件更新与回滚流程设计

Status: 手动更新方案已确认，等待规格审阅后进入实现计划
Date: 2026-07-06

## 背景

Lume 已经具备插件安装状态基础：

- `plugins-state.json` 以 `pluginId -> activeVersion -> versions` 记录已安装版本。
- 插件市场 catalog/detail 会读取当前市场源 manifest，并返回 `installState`。
- 插件详情页已经能显示 `update-available`，并提供“确认权限并更新”按钮。
- sidecar 已暴露 `UPDATE_PLUGIN` IPC 和 `PluginMarketService.updatePlugin()`。

但当前更新语义还不完整：

1. `resolveInstallState()` 只要版本不同就返回 `update-available`，没有区分升级、降级和本地市场源回退。
2. 插件详情页更新路径仍调用 `installMarketItem(overwrite: true)`，不是明确的 update 语义。
3. `updatePlugin()` 固定使用 `workspaceSlug: "default"`，会破坏非默认工作区的更新体验。
4. `updatePlugin()` 用 `activate` 决定是否全局启用，不能保留原来的 workspace/global 启用范围。
5. 更新后旧版本没有清理策略，也没有从详情页回滚到上一版本的产品路径。

用户已确认的方向：

- 只做手动更新，不做后台自动更新。
- 只有权限 hash 变化才重新确认权限。
- 更新后保留最近 1 个旧版本，可回滚。
- 只根据当前市场源 manifest version 判断是否有更新。
- 只有 semver 更高版本显示为“有更新”。

## 目标

- 插件市场刷新或详情页打开时，能准确显示“有更新”。
- 用户在详情页明确确认后才执行更新。
- 权限 hash 未变化时可直接更新；权限 hash 变化时必须先确认权限。
- 更新成功后保留原启用范围，避免 workspace 插件被意外改成 global 或 disabled。
- 更新成功后只保留当前版本和最近 1 个旧版本。
- 详情页提供回滚到上一版本的入口。
- 更新失败不修改 `activeVersion`，旧版本仍可继续使用。

## 非目标

- 不做后台定时检查、启动时弹窗或自动更新。
- 不做 stable/beta channel、release feed、changelog 拉取或签名校验。
- 不支持保留所有历史版本。
- 不把同版本权限 hash 变化显示成“有更新”；同版本 hash 变化由现有 `needs-review`/权限门禁体系处理。
- 不在本次设计里重写插件安装目录结构。

## 用户体验

### 插件列表

插件卡片继续使用现有状态：

- 未安装：显示“安装”。
- 已安装且当前市场版本等于 activeVersion：显示“启用/禁用”。
- 当前市场版本 semver 高于 activeVersion：显示“更新”。

点击“更新”不直接更新，而是打开插件详情页。

### 插件详情页

详情页在 header 和概览中展示：

- 当前安装版本：来自 `plugins-state.json` 的 `activeVersion`。
- 可更新版本：来自当前市场源 manifest。
- 权限状态：`permissionsHash` 是否与 activeVersion 的 `permissionsHash` 一致。
- 安装来源：当前市场条目或安装记录中的 source。

按钮语义：

- 权限 hash 未变化：按钮文案为“更新到 vX.Y.Z”。
- 权限 hash 变化：按钮文案为“确认权限并更新”。
- 有可回滚旧版本：显示次要动作“回滚到 vA.B.C”。

更新完成后：

- 刷新 catalog/detail。
- 保留在插件详情页，展示新 activeVersion。
- 若原来已启用，仍保持原启用范围。

### 回滚

回滚是显式管理动作：

- 入口在详情页设置 tab 或 header 次级菜单。
- 回滚只切换 `activeVersion` 到最近一个保留版本。
- 回滚不复制文件，不重新下载，不重新安装。
- 回滚到已审核过的旧版本不需要重新确认权限。

如果旧版本目录缺失，回滚按钮不显示或显示不可用诊断。

## 版本规则

使用项目内最小 semver 比较函数，不引入新依赖。

规则：

1. `targetVersion > activeVersion` 时，`installState = "update-available"`。
2. `targetVersion === activeVersion` 时，`installState = "installed"`。
3. `targetVersion < activeVersion` 时，`installState = "installed"`，但详情可展示“市场源版本低于已安装版本”的诊断。
4. 非标准 semver 版本不显示为 update。若版本字符串相同仍视为 installed；若无法比较且不同，详情显示诊断，不自动归类为更新。

这样可以避免本地市场源切分支、远端索引回退或开发中的降级 manifest 被误显示为“有更新”。

## 服务层设计

### 类型扩展

`UpdatePluginInput` 需要携带工作区上下文：

```ts
interface UpdatePluginInput {
  workspaceSlug: string
  pluginId: string
  source?: PluginSourceRef
  targetVersion?: string
  acceptedPermissionsHash?: string
  force?: boolean
}
```

移除或停止使用 `activate`。更新不负责改变启用范围。

`UpdatePluginResult` 保持轻量，但需要返回回滚信息：

```ts
interface UpdatePluginResult {
  pluginId: string
  installedVersion: string
  activeVersion: string
  previousActiveVersion?: string
  retainedVersions: string[]
  needsReview: boolean
  diagnostics?: AgentPluginDiagnostic[]
}
```

新增回滚输入输出：

```ts
interface RollbackPluginInput {
  pluginId: string
  targetVersion?: string
}

interface RollbackPluginResult {
  pluginId: string
  previousActiveVersion?: string
  activeVersion: string
  diagnostics?: AgentPluginDiagnostic[]
}
```

如果为了保持 diff 小，也可以先复用现有 `setPluginActiveVersion()` 作为回滚实现，UI 文案叫“回滚”，服务层暂不新增 IPC。实现计划再决定是否需要专门 IPC。

### 更新算法

`updatePlugin(input)` 应执行以下顺序：

1. 读取插件安装记录，找到 activeVersion 和 active installed source。
2. 解析更新 source：优先 `input.source`，否则使用 activeVersion 记录的 source。
3. inspect 新 source，得到 target plugin、targetVersion、permissionsHash。
4. 校验 target pluginId 与 input.pluginId 一致。
5. 比较版本：只有 targetVersion 高于 activeVersion 才允许普通更新；`force` 可用于开发或重装场景。
6. 权限 hash 变化时，如果 `acceptedPermissionsHash !== targetHash`，返回或抛出 `permission_review_required`。
7. 调用安装复制逻辑写入新版本目录。
8. 写入新版本 state，包括 `permissionsHash`、`source`、`sensitiveApprovals`。
9. 将 `activeVersion` 切到新版本。
10. 保留最近 1 个旧版本，删除更老版本目录和 state。
11. 不修改 `plugins.global/workspaces.*.enabled`。

关键约束：

- activeVersion 的切换必须发生在新版本复制和状态写入成功之后。
- 更新失败不得删除旧版本，不得修改 activeVersion。
- 旧版本的 `permissionsHash` 和 `sensitiveApprovals` 随版本 state 保留，用于回滚。

### 权限策略

权限确认只看 `permissionsHash`：

- `targetHash === activeHash`：不要求重新确认。
- `targetHash !== activeHash`：必须带 `acceptedPermissionsHash = targetHash`。

安装新版本时仍复用现有 MCP 敏感授权生成逻辑：

- 如果新版本声明 `permissions.mcpServers.register: true`，为目标版本生成 `mcpServer:${pluginId}:${serverId}` approval。
- scope 依据安装时上下文写入；更新应优先沿用原有启用 scope。若没有启用 scope，则使用当前 workspace scope。

## 状态保留与清理

更新成功后的 state 目标形态：

```json
{
  "plugins": {
    "obsidian-bridge": {
      "activeVersion": "0.2.0",
      "versions": {
        "0.2.0": { "version": "0.2.0" },
        "0.1.0": { "version": "0.1.0" }
      }
    }
  }
}
```

清理规则：

- 当前 activeVersion 永远保留。
- 最近一个 previousActiveVersion 保留。
- 更旧版本从 state 和磁盘目录删除。
- 如果删除旧版本目录失败，保留 state 并返回 warning diagnostic，不阻断更新成功。

“最近一个旧版本”按 installedAt 排序，而不是按 semver 排序。这样用户从 1.3.0 回滚到 1.2.0 后再更新到 1.3.1，也能保留实际上一版 activeVersion。

## UI 与 IPC

### Web API

`apps/web/src/lib/desktop-api/plugin-market.ts` 已有 `updatePlugin()`，需要开始实际使用。

详情页更新动作改为：

- installState 为 `not-installed`：调用 `installMarketItem()`。
- installState 为 `update-available`：调用 `updatePlugin()`。

如果 update 返回 `permission_review_required`，详情页保持在当前页并要求用户确认权限。实际实现可继续使用已有 inspected permissions hash，不需要新弹窗。

### Detail State

`plugin-detail-state.ts` 增加纯函数：

- 计算更新动作文案。
- 计算是否需要权限确认。
- 计算是否显示回滚。

优先用纯函数测试覆盖 UI 状态，不为了简单文案改动启动整套渲染测试。

## 错误处理

- source 缺失：显示“找不到插件来源，无法更新”。
- target pluginId 不一致：阻止更新，显示 manifest 不匹配。
- targetVersion 不高于 activeVersion：阻止普通更新；force 场景只供开发入口使用。
- 权限 hash 变化但未确认：阻止更新，要求确认权限。
- 文件复制失败：不改 activeVersion。
- state 写入失败：不改 activeVersion；如果新版本目录已复制，后续清理或覆盖由下一次更新处理。
- 清理旧版本失败：更新成功，但返回 warning diagnostic。

## 测试策略

服务层测试优先：

- semver 更高版本才返回 `update-available`。
- 版本低于 activeVersion 不显示 update。
- `updatePlugin()` 保留 workspace/global 启用状态。
- 权限 hash 不变时更新不要求 accepted hash。
- 权限 hash 变化时缺少 accepted hash 会失败。
- 更新成功保留当前版本和最近 1 个旧版本。
- 更新失败不改变 activeVersion。
- 回滚切换到上一版本，不重新确认权限。

Web 侧测试保持轻量：

- update-available 的详情页调用 `updatePlugin()`，不再调用 `installMarketItem(overwrite: true)`。
- 权限 hash 变化时按钮文案为“确认权限并更新”。
- 可回滚时显示“回滚到 vX.Y.Z”。

## 实现顺序

1. 补 semver 比较纯函数和 installState 服务层测试。
2. 修 `resolveInstallState()`。
3. 修 `updatePlugin()` 输入、权限确认、启用范围保留和版本保留。
4. 为回滚补服务层能力，优先复用 `setPluginActiveVersion()`。
5. Web 详情页更新动作改用 `updatePlugin()`。
6. 增加详情页版本/权限/回滚展示。
7. 跑聚焦测试，避免全量 typecheck 被既有测试替身问题干扰。

## 自检

- 没有后台自动更新、release channel 或自动安装范围扩张。
- 更新发现、权限确认、旧版保留和回滚规则互相一致。
- 设计保留现有 `plugins-state.json` 结构，只扩展必要输入输出。
- 版本比较明确处理升级、相等、降级和非 semver。
- 更新失败路径明确不修改 activeVersion。
