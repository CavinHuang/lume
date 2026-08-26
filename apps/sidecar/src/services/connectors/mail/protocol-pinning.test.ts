import { describe, expect, it } from "bun:test";
import type { LookupFunction } from "node:net";
import { createMailProtocol, type MailCredential, type MailProtocolDependencies } from "./protocol";

/**
 * #696 回归钉死:连接期 host-pinning 默认启用。save-time 检查可被"连接时才指向
 * 内网地址"的 DNS 记录打穿(DNS rebinding),因此解析筛查 + 连接钉死必须在
 * 传输建立前生效;仅硬编码 host 的内置 provider 显式豁免。
 */

const credential: MailCredential = {
  email: "user@example.com",
  authorizationCode: "abcd1234efgh5678",
  imapHost: "imap.example.com",
  smtpHost: "smtp.example.com",
};

const config = { displayName: "Example Mail", attachmentFallbackPrefix: "attachment" };

function makeTransportDeps() {
  const captured: {
    lookupCalls: string[];
    transportConfigs: Array<Record<string, unknown>>;
    socketLookups: Array<LookupFunction | undefined>;
  } = { lookupCalls: [], transportConfigs: [], socketLookups: [] };
  const deps: MailProtocolDependencies = {
    lookup: async (hostname) => {
      captured.lookupCalls.push(hostname);
      return [{ address: "192.168.1.10", family: 4 }];
    },
    createSmtpTransport: (transportConfig) => {
      captured.transportConfigs.push(transportConfig as Record<string, unknown>);
      return {
        verify: async () => ({}),
        sendMail: async () => ({}),
        close: () => {},
      };
    },
    connectSocket: ((options: { lookup?: LookupFunction }) => {
      captured.socketLookups.push(options?.lookup);
      // 最小 Socket 替身:factory 只在其上挂监听,测试不真正建连
      return {
        once: () => {},
        removeListener: () => {},
        setTimeout: () => {},
        destroy: () => {},
      } as never;
    }) as never,
  };
  return { deps, captured };
}

describe("mail host pinning is on by default (#696)", () => {
  it("blocks the connection when the host resolves to a private address", async () => {
    const { deps } = makeTransportDeps();
    const protocol = createMailProtocol(config, deps);

    await expect(protocol.validateSmtpCredential(credential)).rejects.toMatchObject({
      kind: "blocked_host",
    });
    expect(deps.lookup).toBeDefined();
  });

  it("pins the transport to validated addresses: re-resolution cannot escape them", async () => {
    const publicAddresses = [{ address: "93.184.216.34", family: 4 }];
    const captured: {
      transportConfigs: Array<Record<string, unknown>>;
      socketLookups: Array<LookupFunction | undefined>;
    } = { transportConfigs: [], socketLookups: [] };
    const deps: MailProtocolDependencies = {
      lookup: async () => publicAddresses,
      createSmtpTransport: (transportConfig) => {
        captured.transportConfigs.push(transportConfig as Record<string, unknown>);
        return { verify: async () => ({}), sendMail: async () => ({}), close: () => {} };
      },
      connectSocket: ((options: { lookup?: LookupFunction }) => {
        captured.socketLookups.push(options?.lookup);
        return { once: () => {}, removeListener: () => {}, setTimeout: () => {}, destroy: () => {} } as never;
      }) as never,
    };
    const protocol = createMailProtocol(config, deps);

    await expect(protocol.validateSmtpCredential(credential)).resolves.toBeUndefined();

    // rebinding 模拟:transport 建连时无论解析到什么,lookup 都只返回已验证地址
    const getSocket = captured.transportConfigs[0]?.getSocket as
      | ((options: unknown, callback: (error: Error | null) => void) => void)
      | undefined;
    expect(typeof getSocket).toBe("function");
    getSocket!({}, () => {});
    const pinnedLookup = captured.socketLookups[0];
    expect(typeof pinnedLookup).toBe("function");
    const allResults: unknown[] = [];
    pinnedLookup!("attacker.example", { all: true }, (_error, addresses) => {
      allResults.push(addresses);
    });
    expect(allResults[0]).toEqual(publicAddresses);
    let singleResult: unknown;
    pinnedLookup!("attacker.example", {}, (_error, address, family) => {
      singleResult = { address, family };
    });
    expect(singleResult).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("opts out only when enforceHostNetworkPolicy is explicitly false", async () => {
    const { deps, captured } = makeTransportDeps();
    const protocol = createMailProtocol(
      { ...config, enforceHostNetworkPolicy: false },
      deps,
    );

    await expect(protocol.validateSmtpCredential(credential)).resolves.toBeUndefined();
    // 豁免路径不做连接期解析
    expect(captured.lookupCalls).toEqual([]);
    expect(captured.transportConfigs[0]?.getSocket).toBeUndefined();
  });
});
