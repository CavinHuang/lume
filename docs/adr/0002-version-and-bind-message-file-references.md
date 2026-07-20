# 为消息文件引用固化版本与绑定边界

消息文件引用是会被持久化并在未来重渲染的 Agent 输出协议，因此每条新消息保存 `fileReferenceProtocolVersion: 1`，无版本但带绑定快照的既有消息按 V1 解释，更早的无绑定消息只保留狭窄的 legacy-session 兼容；后续不兼容语法必须启用新版本，不能用新解析规则重新定义历史消息。消息携带的 Binding Guard 只验证引用与生成时项目或会话上下文的一致性，不是 renderer 无法伪造的授权 capability；从消息成功定位到 Files 后转为当前绑定导航，项目重绑必须清理该工作区的项目文件缓存、选择与临时预览，并撤销关联 preview scope。

## Considered Options

- 始终用最新版解析器重解析原始 Markdown：无需版本字段，但会让历史消息的含义随发布变化。
- 使用 sidecar 签名 capability：可建立更强的授权边界，但需要密钥、签发和轮换生命周期，超出受控本地 renderer 下的绑定一致性目标。
- 用随机 `projectBindingId` 取代 canonical project-root fingerprint：可降低跨消息关联性，但用户认为额外标识和轮换机制没有必要，因此 V1 保留 fingerprint。

## Consequences

协议演进需要显式兼容分支；Binding Guard 不能被描述为安全令牌。消息的首次定位保持生成时绑定语义，进入 Files 后则遵循当前绑定，项目重绑必须成为明确的缓存与预览失效边界。
