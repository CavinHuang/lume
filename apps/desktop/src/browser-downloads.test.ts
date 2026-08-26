import { describe, expect, test } from "bun:test";
import { AgentDownloadQuota } from "./browser-downloads";

describe("AgentDownloadQuota LRU eviction (#673)", () => {
  test("evicts oldest idle turn buckets beyond the cap", () => {
    const quota = new AgentDownloadQuota();
    // 把 old:0 桶灌到 maxFiles(20) 上限：此后同桶再 begin 必须被拒
    for (let index = 0; index < 20; index += 1) {
      const id = quota.begin("old:0", 0);
      expect(id).not.toBeNull();
      quota.finish("old:0", id!, true);
    }
    expect(quota.begin("old:0", 0)).toBeNull();
    // 灌入超过容量上限的新回合桶，把最老的 old:0 挤出
    for (let index = 0; index < 80; index += 1) quota.begin(`flood:${index}`, 0);
    // old:0 已被淘汰：重新 begin 成功（配额计数随桶一起清零）
    expect(quota.begin("old:0", 0)).not.toBeNull();
  });

  test("never evicts buckets with active downloads", () => {
    const quota = new AgentDownloadQuota();
    const activeId = quota.begin("active:0", 0);
    expect(activeId).not.toBeNull();
    for (let index = 1; index <= 100; index += 1) quota.begin(`idle:${index}`, 0);
    // active:0 是最老桶但下载仍在进行：淘汰必须跳过它，进度更新仍然命中
    expect(quota.update("active:0", activeId!, 50)).toBe(true);
  });
});
