# Computer Use 视觉探测截断修复设计

## 背景

Computer Use 在微信无障碍文本不可用时成功截取了完整窗口，但 `step-3.7-flash` 的视觉探测只允许生成 40 个 token。模型在生成最终文本前耗尽预算，路由将这次未完成的响应错误地缓存为“不支持视觉”24 小时。由于没有配置独立视觉模型，截图随后返回 `vision_unavailable`。

## 目标

- 给视觉探测足够的输出预算，使带推理过程的模型能够返回最终答案。
- 将 `max_tokens` 截断视为临时、未完成的探测，不写入负缓存。
- 保持现有工具契约、视觉模型配置和截图生命周期不变。

## 设计

`probeVision` 将输出预算从 40 提高到 300。若 Provider 返回 `stopReason: "max_tokens"`，它抛出一个探测未完成错误，而不是返回 `false`。

`ComputerUseVisionRouter.#supportsVision` 继续缓存确定性的 `true` 或 `false` 结果；探测抛错时只记录脱敏失败类别并返回 `false`，不写入 24 小时缓存。这样本次截图仍安全地返回 `vision_unavailable`，下一次截图可以重新探测，而不是被错误结果锁死一天。

不读取或记录模型 thinking 内容，不依赖静态模型能力元数据，也不改变独立视觉模型的回退顺序。

## 测试

- 新增回归测试：第一次探测抛出截断错误后，下一次路由必须再次探测并可成功返回 `image_ready`。
- 保留现有测试：成功探测在同一 channel/model 版本下只执行一次。
- 运行视觉路由定向测试和 Computer Use portable 验证。

## 非目标

- 不新增依赖或配置项。
- 不实现 OCR。
- 不修改截图捕获、无障碍适配或 Provider 图片编码。
