import type { ProviderDefinition } from "../../core/types";

import { qqMailActions } from "./actions";

export const nodeOnly = true;

export const provider: ProviderDefinition = {
  service: "qq_mail",
  displayName: "QQ 邮箱",
  description:
    "Unavailable on Cloudflare Workers. QQ Mail requires IMAP/SMTP, so run this provider from the Node.js runtime.",
  categories: ["Communication", "Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "email",
          label: "邮箱地址",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "user@qq.com",
          description: "要连接的 QQ 邮箱完整地址,例如 user@qq.com。",
        },
        {
          key: "authorizationCode",
          label: "授权码",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "16 位授权码",
          description:
            "先在 QQ 邮箱网页版「设置 → 账号与安全」开启 IMAP/SMTP 服务,再使用生成的 16 位授权码(不是 QQ 登录密码):https://help.mail.qq.com/detail/0/1087",
        },
      ],
      testAction: {
        actionName: "list_folders",
        input: {},
      },
    },
  ],
  homepageUrl: "https://mail.qq.com/",
  actions: qqMailActions,
};
