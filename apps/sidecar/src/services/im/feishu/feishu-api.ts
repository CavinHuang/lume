import * as lark from "@larksuiteoapi/node-sdk";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-feishu-api");

/** 仅描述 sendText 用到的 message.create 调用面,便于测试注入伪实现。 */
export interface FeishuRestClient {
  im: {
    v1: {
      message: {
        create(req: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }): Promise<unknown>;
      };
    };
  };
}

export interface SendFeishuTextInput {
  appId: string;
  appSecret: string;
  /** 目标会话 chat_id(单聊/群聊);来自入站 event.message.chat_id,经 thread binding 传回。 */
  peerId: string;
  text: string;
}

export interface FeishuApiDeps {
  /** 测试注入伪 client;生产省略走按 appId 缓存的 lark.Client 工厂。 */
  createClient?: (appId: string, appSecret: string) => FeishuRestClient;
}

// 按 appId 缓存 lark.Client,复用其内部 tenant_access_token 自动刷新,避免每次发送都重取 token。
const clientCache = new Map<string, FeishuRestClient>();

function defaultCreateClient(appId: string, appSecret: string): FeishuRestClient {
  return new lark.Client({ appId, appSecret }) as unknown as FeishuRestClient;
}

function getFeishuClient(appId: string, appSecret: string): FeishuRestClient {
  let client = clientCache.get(appId);
  if (!client) {
    client = defaultCreateClient(appId, appSecret);
    clientCache.set(appId, client);
  }
  return client;
}

/**
 * 飞书出站:client.im.v1.message.create 发送文本到指定 chat_id。
 * content 为 JSON 字符串 {"text":"..."}。与入站 WSClient 分离(REST)。
 */
export async function sendFeishuText(
  input: SendFeishuTextInput,
  deps: FeishuApiDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!input.appId || !input.appSecret) {
    return { ok: false, error: "缺少 App ID/App Secret,无法发送飞书消息" };
  }
  const getClient = deps.createClient ?? getFeishuClient;
  try {
    const client = getClient(input.appId, input.appSecret);
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: input.peerId,
        msg_type: "text",
        content: JSON.stringify({ text: input.text }),
      },
    });
    return { ok: true };
  } catch (error) {
    log.error("飞书 sendText 失败", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
