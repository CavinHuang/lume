/**
 * #637：注入密钥就位后，把 im-config / reading-settings 中存量 legacy 弱种子
 * 密文一次性升级为 v2（注入密钥加密）。迁移失败只记日志——下次启动重试，
 * 不阻断密钥注入应答本身。
 */
import { createLogger } from "../infra/logger";
import { reencryptImTokensWithInstalledKey } from "../im/im-config-manager";
import { reencryptWereadApiKeyWithInstalledKey } from "../reading/reading-store";

const log = createLogger("secret-reencryption");

export async function migrateLegacySecretCiphertexts(): Promise<{ imTokens: number; wereadKeys: number }> {
  let imTokens = 0;
  try {
    imTokens = reencryptImTokensWithInstalledKey();
  } catch (error) {
    log.warn("IM token 重加密失败", { error: error instanceof Error ? error.message : String(error) });
  }
  let wereadKeys = 0;
  try {
    wereadKeys = reencryptWereadApiKeyWithInstalledKey();
  } catch (error) {
    log.warn("weread apiKey 重加密失败", { error: error instanceof Error ? error.message : String(error) });
  }
  if (imTokens + wereadKeys > 0) {
    log.info("legacy secret ciphertext migrated to v2", { imTokens, wereadKeys });
  }
  return { imTokens, wereadKeys };
}
