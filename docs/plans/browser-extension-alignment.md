# Browser Extension 对齐评估（OpenClaw -> Lume）

## 结论

不建议做 1:1 完整复制；建议做“能力对齐 + 架构适配”。

原因：
- Lume 当前是 `Tauri + sidecar` 本地形态，未暴露 OpenClaw 那套独立 browser gateway `/cdp` 公共入口。
- 直接复制 OpenClaw 的完整 relay 鉴权/路由体系会引入不必要复杂度与维护成本。

## 已对齐（第一阶段）

1. 稳定安装路径
- `~/.lume/browser/chrome-extension`

2. 扩展信息与安装能力
- sidecar/browser tool 均支持：
  - `extension_info`
  - `extension_install`

3. relay 生命周期
- sidecar 启动默认自动启动 relay（可通过 `LUME_BROWSER_RELAY_AUTOSTART=0` 关闭）
- 新增 relay 状态读取能力（running/connected/tabs/port）

4. 前端可操作引导
- 设置页新增 Chrome Extension 模式卡片：安装、启动、状态刷新、打开 `chrome://extensions`

5. 安全基线增强
- relay websocket 连接增加来源限制：
  - 仅 loopback remote address
  - 仅 `chrome-extension://` origin
- 支持可选 token 鉴权：
  - sidecar: `LUME_BROWSER_RELAY_TOKEN`
  - extension options: `Relay Token`

## 暂不 1:1 对齐项

1. OpenClaw 风格 `/cdp` 对外 websocket + token header 鉴权
- 当前 Lume 架构没有对外 CDP client 接入需求，先不引入完整网关层。

2. 多 profile 自动路由与远程 gateway 拓扑
- 当前需求聚焦本机 Chrome extension relay，先不扩展。

## 下一阶段建议（第二阶段）

1. 增强 token 分发机制（当前为静态配置）
- 现状：通过 `LUME_BROWSER_RELAY_TOKEN` + 扩展 options 手动配置
- 目标：后续评估会话级动态 token 自动下发（避免人工同步）

2. 补充端到端 smoke
- 启动 relay -> 扩展连接 -> tab attach -> 一条 `browser.navigate` 成功
