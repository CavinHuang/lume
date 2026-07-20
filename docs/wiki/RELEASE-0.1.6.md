# Wiki Windows 0.1.6 发布验收

日期：2026-07-20

## 产物

- `apps/desktop/dist-release/Lume-0.1.6-x64.exe`
- `apps/desktop/dist-release/Lume-0.1.6-x64.exe.blockmap`
- `apps/desktop/dist-release/latest.yml`
- `apps/desktop/dist-release/win-unpacked/`

## 结果

1. sidecar bundle 从当前 Wiki 源码重新生成，未包含构建机绝对路径。
2. 产物检查确认安装包包含 `agent-wiki/SKILL.md`、受保护 Wiki 工具注册、Windows MXC native resource 与 sidecar runtime。
3. `win-unpacked/resources` 在真实 Electron `utilityProcess` 中通过 native 与 XHR worker smoke。
4. Wiki smoke 创建导入草案，确认返回的公开摘要不含 nonce，经 privileged apply 正式提交，再通过 `wiki.search` 找回页面。
5. 5,000 页面 / 50,000 段基准通过：lexical p95 15.6751 ms，warm hybrid 3.8329 ms。

## 打包说明

标准 `bun run package:desktop` 在 `@lume/sidecar build` 阶段被另一并行任务的 `agent-files-service.test.ts` fixture 类型错误阻断（缺少 `expectedKind`）。未修改该非 Wiki 工作。随后执行等价的 Wiki 发布路径：

```powershell
bun scripts/build-sidecar-bundle.mjs
node apps/desktop/scripts/run-electron-builder.mjs --output-dir dist-release --publish never --config.directories.output=dist-release
$env:LUME_DESKTOP_OUTPUT_DIR='dist-release'; node scripts/verify-desktop-package-artifacts.mjs
$env:LUME_SMOKE_RESOURCES_DIR='apps/desktop/dist-release/win-unpacked/resources'; node scripts/smoke-sidecar-bundle.mjs
```

上述链路成功退出，安装包内 sidecar 即为本轮重建版本。
