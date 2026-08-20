# bundled browser dist（上游构建快照）

本目录是上游 lume-chrome BrowserClient 构建产物的 vendored 快照，**不是本仓库的可再生构建物**。
经 desktop `extraResources`（apps/desktop/package.json）整目录分发到安装包，desktop 主进程按
bundled-plugins 目录定位加载；sidecar 侧运行时消费链为
`src/.../node-repl-runtime-manager.ts` / `plugin-manager.ts` → `../scripts/browser-client.mjs`
（broker 协议适配层）→ 本目录 barrel `browser-client.js`。

## 当前组成（9 文件）

- `browser-client.js` — barrel（re-export client/BrowserClient 与 setupBrowserRuntime）
- `client/` × 7 — BrowserClient 实现与握手（协议窗口 5..8，按 runtime_ping 动态字段协商）
- `shared/locator.js` — 定位器（shared 下唯一被 client 引用的文件）

已删除上游产物中的 4 个零消费文件（本仓与 dist 内部均无引用）：
`shared/protocol.js`、`shared/commands.js`、`shared/errors.js`、`shared/browser-contract.generated.js`
（其中 browser-contract 的 `externalProtocolVersion: 5` 为静态描述常量，不参与 wire 握手，
疑似 native-host 协议线而非 runtime 协议）。下次整目录替换时如它们以新增文件回到 diff，可按本记录复核后再删。

## 协议版本真相

runtime 协议版本常量以 `packages/shared/src/types/browser-runtime.ts` 为单源
（`BROWSER_PROTOCOL_VERSION = 8`），由 sidecar `browser-broker.ts` 消费；dist 内 client
按 runtime_ping 动态字段协商兼容窗口，不依赖被删的静态 contract。

## 更新流程

1. 上游 lume-chrome 仓库构建 BrowserClient 产物；
2. 整目录替换本 dist（对照上文件清单，复核被删的 4 个死文件是否仍零消费）；
3. **检查 `../scripts/browser-client.mjs` 适配层兼容性**——它按方法名硬适配 broker 协议，
   上游方法名/envelope 结构变化需要同步跟改；
4. 同步 `src/rpc/bundled-browser-plugin.test.ts` 的 ship 清单断言与 SKILL.md/docs 相关描述。
