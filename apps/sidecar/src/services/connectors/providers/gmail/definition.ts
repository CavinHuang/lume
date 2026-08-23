import type { ProviderDefinition } from "../../core/types";

import { gmailActions } from "./actions";
import { gmailOAuthScopes } from "./scopes";

const service = "gmail";

/**
 * Gmail provider backed by the Gmail API and user-provided Google OAuth app.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Gmail",
  categories: ["Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: gmailOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      authorizationParams: {
        access_type: "offline",
        prompt: "consent",
      },
      clientSetup: {
        docsUrl: "https://console.cloud.google.com/apis/credentials",
        steps: [
          "打开 Google Cloud Console,新建或选择一个项目。",
          "在「API 和服务 → 库」中搜索 Gmail API 并点击启用。",
          "在「OAuth 同意屏」选择 External 创建,并把使用 Lume 的邮箱添加为 Test user(测试模式下仅测试用户可授权)。",
          "在「凭据 → 创建凭据 → OAuth 客户端 ID」,应用类型选择桌面应用后创建。",
          "复制生成的 Client ID 与 Client Secret,粘贴到下方保存即可发起授权。",
        ],
      },
    },
  ],
  homepageUrl: "https://mail.google.com",
  actions: gmailActions,
};
