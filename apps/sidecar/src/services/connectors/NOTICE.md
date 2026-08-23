# Notices

本目录核心框架(`core/`、`oauth/oauth-token.ts`、`providers/provider-runtime.ts`)与 Gmail
provider(`providers/gmail/`)迁移自 [open-connector](https://github.com/oomol-lab/open-connector)
(Apache License, Version 2.0, Copyright OOMOL),并已按 Lume 的架构适配:

- import 后缀与路径调整;移除 server/hono 依赖、slack 特例与生成的 action 名契约;
- `provider-runtime.ts` 中未使用的 proxy/transit-file 能力暂随迁移带入,待后续裁剪。

Apache License 2.0 要求保留版权与许可声明:上游完整许可文本见上游仓库 LICENSE.txt;
本目录改动以本仓 LICENSE(MIT)发布,上游部分的 Apache 2.0 授权条款不变。
第三方服务名称(Gmail 等)仅用于标识与互操作,商标归各自所有者所有。
