# Wiki 验收矩阵

日期：2026-07-20  
范围：本地单用户 Wiki、Agent 受保护访问、Windows 0.1.6 安装包

状态定义：`implemented + tested` 表示实现已接通并有对应自动化测试或安装包 smoke；本矩阵不以总测试数代替边界证明。

| 验收域 | 状态 | 证据 |
| --- | --- | --- |
| 独立中央 Wiki 与 workspace UUID 归宿 | implemented + tested | Markdown store round-trip、inbox、primary/associated workspace 与 Lume 平级导航测试 |
| 页面/块 ownership | implemented + tested | Agent block hash、block patch、用户外部编辑晋升、整页保护与 stale undo 测试 |
| Renderer scope 创建约束 | implemented + tested | Ask Wiki scope 由 sidecar 校验并绑定新 thread；runtime profile 测试覆盖 page/workspace/inbox |
| Proposal 确认边界 | implemented + tested | nonce-free `WikiProposalSummaryV1`、canonical diff hash、权威摘要刷新、独立 apply/resolve/undo contract 与重放/替换负例 |
| Privileged credential | implemented + tested | 每 sidecar 启动随机凭证、主进程私有交付、常量时间校验、旧凭证轮换、Agent 子进程环境剥离 |
| Permission modes / protected root | implemented + tested | `default`、`acceptEdits`、`dontAsk`、`bypassPermissions` 均先经过 protected-root gate；Bash/node-repl/MCP/通用文件工具负例 |
| Windows junction / Unix symlink | implemented + tested | 同一可移植测试在 Windows 使用 junction、Unix 使用 directory symlink，覆盖读写逃逸；本轮在 Windows 执行 junction 分支 |
| Safe HTTP / DNS rebinding / TLS SNI | implemented + tested | 每跳解析、混合 DNS、私网/保留地址、rebinding、固定连接地址、原 hostname/SNI、端口/大小/超时测试 |
| 页面 scope 与 provenance grant 串联 | implemented + tested | ACL store 测试证明页面可见不等于来源可读；workspace archive 追加 revoke event |
| Lock takeover / fencing / journal recovery | implemented + tested | live writer 拒绝、dead writer 接管递增 fencing token、操作中断恢复与外部竞争保护测试 |
| 导入与来源生命周期 | implemented + tested | text/url/file/workspace file/chat/reading/memory adapter、不可变 provenance、blob 去重不合并授权、零引用 GC |
| 单一导入入口 | implemented + tested | 按产品决定仅在 Wiki 功能页提供显式“导入”，不在聊天/读书/Memory 重复增加快捷入口；后端 adapter 保持完整 |
| Wiki UI 与确认卡体验 | implemented + tested | 三个平级功能、搜索/目录/阅读编辑/元数据/inspector/待审核；确认后卡片收起且 settled 状态不再提示操作；render/state smoke |
| Obsidian 可选互操作 | implemented + tested | 标准 Markdown/frontmatter/wiki links；`obsidian://open?path=` 由桌面外链白名单测试覆盖，不依赖 Obsidian 运行 |
| 全文与 hybrid index | implemented + tested | FTS5 trigram 或确定性 CJK 2/3-gram、权限先过滤、embedding cache 按 model+content hash 增量保留、确定性融合与模式标识 |
| 派生索引覆盖 | implemented + tested | pages/sections/source blobs/provenance/tags/workspaces/links/aliases/citations/revisions/lint findings；索引可删除重建，不是事实源 |
| 结构与语义维护 | implemented + tested | schema/link/source/workspace/hash/journal lint；generation 去重、模型/耗时/finding counts、无模型降级与后台失败不阻塞读取 |
| 隐私清除 | implemented + tested | 只读影响预览、高风险二次确认、按 source/page/thread/message/workspace/content hash、共享 payload 引用保留、不可撤销 tombstone |
| 工作区生命周期 | implemented + tested | project removal 在破坏性清理前调用 Wiki 归档；页面移至 archived-workspaces 且撤销来源 grant；项目移除回归测试 |
| 数据管理边界 | implemented + tested | Wiki 纳入数据统计/导出范围；vector cache 清理只删除 `.lume/index`，保留页面、来源、pending 与版本 |
| 5,000 页 / 50,000 段性能 | implemented + tested | Windows 本机：lexical p95 `15.6751 ms`，warm hybrid `3.8329 ms`，均低于 300 ms / 2 s 门槛 |
| Windows 0.1.6 release artifact | implemented + tested | 安装包资源检查通过；packaged Electron utility process 完成 native、XHR、Wiki runtime 及 proposal → confirm → searchable smoke |

## 验证命令

```powershell
bun run --cwd apps/sidecar typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun test apps/sidecar/src/services/wiki/wiki-security-contracts.test.ts apps/sidecar/src/services/wiki/wiki.test.ts
bun test apps/sidecar/src/services/wiki/runtime-profile.test.ts apps/sidecar/src/services/wiki/wiki-runtime-capability.test.ts
bun test apps/sidecar/src/services/agent/agent-project-lifecycle-service.test.ts apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.test.ts apps/sidecar/src/services/agent-runtime/tools/protected-root-policy.test.ts apps/sidecar/src/services/agent-runtime/tools/tool-execution-gateway.test.ts
bun test apps/sidecar/src/services/system/general-settings-service.test.ts apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-manager.test.ts
node --test apps/desktop/scripts/electron-security.test.mjs apps/desktop/scripts/desktop-core.test.mjs
bun test apps/web/src/components/wiki/wiki-view-state.test.ts apps/web/src/components/wiki/wiki-view-render.test.tsx apps/web/src/components/lume/LumeView.test.tsx
node apps/sidecar/scripts/benchmark-wiki-search.mjs
node scripts/verify-desktop-package-artifacts.mjs
node scripts/smoke-sidecar-bundle.mjs
```

## 仍属 out of scope

- Obsidian 捆绑、插件、Sync/Publish；Obsidian 只是可选编辑器。
- 云同步、多人实时协作、组织 RBAC 与共享 Vault 冲突合并。
- Notion 式块编辑器、WYSIWYG、Canvas 与原生知识图谱。
- 静默导入历史聊天、Memory、读书笔记或工作区文件；沉淀仍由用户显式触发。
- Agent 绕过用户确认直接写正式 Wiki，或语义维护自动联网、自动改写结论。
- 超过首版规模后的 ANN 引擎，以及任意二进制深度解析、OCR、音视频转录。

## 已知剩余风险

- Unix symlink 分支由同一跨平台测试定义，本轮只在 Windows 执行了 junction 分支；Unix CI 应继续执行该测试，防止平台 API 行为回归。
- `node:sqlite` 在当前 Node 运行时仍输出 experimental warning；索引是可重建派生数据，失败会降级 lexical/rebuild，不影响 Markdown 事实源。
- 完整 `package:desktop` 在本轮被并行任务的非 Wiki 测试 fixture 类型错误阻断；Wiki 所需 sidecar bundle 已单独重建，并重新运行 electron-builder、产物验证和 packaged smoke。
