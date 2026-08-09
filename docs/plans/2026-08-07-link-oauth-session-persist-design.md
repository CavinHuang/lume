# #3 OAuth Pending Session 落盘 设计

**日期**: 2026-08-07
**分支**: `codex/link-oauth-session`(stacked on `codex/link-openconnector`,PR#32)
**状态**: 设计已确认,待实现(writing-plans)

## 背景

`link-handlers.ts:5` `pendingOAuth = new Map<state, LinkOAuthSession & {startedAt}>()`(module-level)。`oauth-start` 存、`oauth-status`/`oauth-cancel` 读改、`oauth-sessions` 列。sidecar(UtilityProcess)重启 Map 清空 → `oauth-status` 抛 `link_oauth_session_not_found`,UI 轮询失效(用户授权中 sidecar 重启,进度丢失)。

authorized 判定查 OpenConnector `/api/connections`(持久)。OpenConnector state store 一次性临时(15min 消费)不能借。

## 方案:Lume 侧落盘

`pendingOAuth` Map → `PersistentOAuthSessions`(Map + 文件持久化)。

## 设计

### 1. 架构

`link-handlers.ts` `pendingOAuth` → `PersistentOAuthSessions` 封装。

- **文件**:`${process.env.LUME_CONFIG_DIR}/link-oauth-sessions.json`(对齐 agent-handlers 的 config 目录用法)
- **加载**:module 初始化(首次访问)读文件 → Map;立即 `expireOAuthSessions`(5min TTL,过滤过期)
- **写**:`oauth-start`(set)/ `oauth-status`(改 status)/ `oauth-cancel` 后,原子写(tmp 文件 + rename,`mode: 0o600`,对齐 supervisor `savePersistedState`)
- **集成**:`createLinkHandlers` 签名不变(module 读 `process.env.LUME_CONFIG_DIR`);`pendingOAuth.get/set/values` 改走 `PersistentOAuthSessions` 同名方法

### 2. PersistentOAuthSessions

- 构造(configDir?):读 `${configDir}/link-oauth-sessions.json`(无/不可读 → 空 Map);加载后 expire(5min,复用 `expireOAuthSessions` 逻辑)
- `get/set/delete/values`:代理 Map;写操作(set/delete/status 改)后 `persist`
- `persist`:JSON.stringify → tmp 文件 → rename(`mode: 0o600`)
- `LUME_CONFIG_DIR` 未设:降级纯内存(不崩,headless/测试场景)

### 3. 测试

- session 重启恢复(set → 新实例读文件 → 恢复)
- 5min TTL:加载时 expire 过期 session
- 原子写(tmp+rename,中断不留半截)
- `LUME_CONFIG_DIR` 未设 → 纯内存降级

### 4. 文件

- `apps/sidecar/src/rpc/link-handlers.ts`(`pendingOAuth` → `PersistentOAuthSessions`)
- `apps/sidecar/src/rpc/link-handlers.test.ts`(P0 已有 86 行,加 session 持久化 case)

### 5. 非目标

不改 UI、不改 OpenConnector、不持久化 authorized/timed_out 终态(那些查 `/api/connections` 即可,只持久化 pending 跟踪)。
