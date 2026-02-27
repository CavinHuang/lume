import { startRelayServer, isRelayConnected, getAttachedTabs } from "../src/services/browser/extension-relay";

async function test() {
  console.log("1. 启动 Relay 服务器...");
  const { port } = await startRelayServer();
  console.log(`   服务器已启动在端口 ${port}`);

  console.log("\n2. 等待 Chrome 扩展连接...");
  console.log("   请在 Chrome 中加载扩展并点击图标附加标签页");
  console.log(`   扩展目录: ${process.cwd()}/assets/chrome-extension`);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (isRelayConnected() && getAttachedTabs().length > 0) {
      console.log("\n✅ 扩展已连接，标签页已附加:");
      console.log(getAttachedTabs());
      break;
    }
    process.stdout.write(".");
  }

  console.log("\n按 Ctrl+C 退出");
  await new Promise(() => {});
}

test().catch(console.error);
