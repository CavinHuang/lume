# Computer Use Codex 对齐清理清单

## 基线

- 基线提交：`df0e2ffdce4b4db53d2ccd4e025bad7367a166f8`
- 独立分支：`codex/computer-use-v2`
- 原工作区用户改动：`.npmrc`、`bun.lock`；本分支不复制、不修改、不暂存。
- 基线验证：Computer Use 相关 Bun 测试 44 项通过；desktop-host Cargo 测试全部通过。

## 删除顺序

1. 删除 Agent 工具参数中的 `windowId`、`appId`、`appName`、`windowTitle` 混合定位，仅接受 canonical `window`。
2. 删除 Agent 工具参数中的 `elementId`；观察快照只暴露 `element_index`，动作使用快照索引或窗口相对坐标。
3. 删除几何/title 派生的 `revision` 以及基于该值的截图复用判断，分别改用唯一 `stateId` 和 `screenshotId`。
4. 删除 `attachPostActionVerification` 及其“调用成功即验证成功”的路径，动作只写入不可伪造的 ledger 阶段。
5. 删除持久消息和 `tool_result` 中的内嵌 base64 图片；图片仅保留线程文件引用和一次请求期临时载荷。
6. 删除 Agent 可见的 `current_context`、`search_context`、`wait_for_state`、`move_pointer` 和 Computer Use 权限诊断工具。
7. 删除旧 `win:*` 线程绑定解释逻辑；旧目标只允许通过 app/title 唯一重选，否则返回 `stale_target`。
8. 删除自然语言摘要中的可编辑动作事实；动作事实只能由 ledger 确定性渲染。

## 保留与替换

- 保留现有 UIA/WGC/SendInput、AX/ScreenCaptureKit/CGEvent 实现，通过统一平台 adapter 收口。
- 保留显式 `take_screenshot` 作为 Lume 扩展；`get_window_state` 只做语义观察。
- 保留现有确认横幅，替换为集中动作分类器与动作时确认数据。
- 不新增依赖，不增加未经证实的截图重试。

## 完成判据

- desktop-host v2 严格握手，v1 组合明确失败。
- shared、Windows、macOS 使用同一 canonical Window/State/Screenshot 契约。
- 所有输入动作只返回 `dispatched` 与 `actionId`；只有 ledger `verified` 可支持“已完成”。
- 图片不会进入持久 transcript、token 估算或压缩摘要。
- 计划中的 portable、native、provider、Cargo 和 desktop build 验证通过。
