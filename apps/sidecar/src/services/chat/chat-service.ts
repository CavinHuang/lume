/**
 * Facade kept for RPC/import stability while chat send/title logic moves to dedicated services.
 */

export {
  CHAT_IPC_CHANNELS,
  sendMessage,
  stopAllGenerations,
  stopGeneration
} from "./chat-send-service";
export { generateTitle } from "./chat-title-service";
