# Notices

本目录核心框架(`core/`、`oauth/oauth-token.ts`、`providers/provider-runtime.ts`)与 Gmail
provider(`providers/gmail/`)迁移自 [open-connector](https://github.com/oomol-lab/open-connector)
(Apache License, Version 2.0, Copyright OOMOL),并已按 Lume 的架构适配:

- import 后缀与路径调整;移除 server/hono 依赖、slack 特例与生成的 action 名契约;
- 迁移后已裁剪本地未使用的 proxy/transit-file 子系统与部署级 egress 开关等能力,
  仅保留当前 provider(gmail/qq_mail)实际消费的最小运行时面。

Apache License 2.0 要求保留版权与许可声明:上游完整许可文本见本目录
[LICENSE-Apache-2.0.txt](./LICENSE-Apache-2.0.txt);
本目录改动以本仓 LICENSE(MIT)发布,上游部分的 Apache 2.0 授权条款不变。
第三方服务名称(Gmail 等)仅用于标识与互操作,商标归各自所有者所有。

## 上游 open-connector NOTICE 原文(Apache-2.0 §4(d) 要求保留)

> # Notices
>
> OOMOL Connect is licensed under the Apache License, Version 2.0, except where otherwise noted.
>
> Third-party provider and app names, trademarks, logos, icons, service marks, trade names, APIs,
> documentation, and brand assets remain the property of their respective owners.
>
> References to third-party providers are included for identification and interoperability only. Such
> references do not imply endorsement, sponsorship, partnership, certification, or verification by the
> third-party owner.
