import {
  getBrowserStatus,
  startBrowser,
  navigateTo,
  getSnapshot,
  takeScreenshot,
  stopBrowser
} from "../src/services/browser/browser-service";

async function test() {
  console.log("1. 检查状态...");
  console.log(await getBrowserStatus());

  console.log("\n2. 启动浏览器...");
  console.log(await startBrowser());

  console.log("\n3. 导航到百度...");
  console.log(await navigateTo("https://www.baidu.com"));

  console.log("\n4. 获取快照...");
  const snap = await getSnapshot(2000);
  console.log({ url: snap.url, snapshotLength: snap.snapshot.length });

  console.log("\n5. 截图...");
  console.log(await takeScreenshot());

  console.log("\n6. 等待 2 秒后关闭...");
  await new Promise(r => setTimeout(r, 2000));

  console.log("\n7. 关闭浏览器...");
  console.log(await stopBrowser());

  console.log("\n✅ 测试完成");
}

test().catch(console.error);
