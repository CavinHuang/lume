import { describe, expect, test } from "bun:test";
import { sendImSegments, splitImMessage } from "./outbound-segment";

describe("sendImSegments（#598 分段失败归因与瞬时重发）", () => {
  test("微信 3000 字符上限：超长文本按顺序拆分且不超限", () => {
    const segments = splitImMessage("a".repeat(3001), { maxChars: 3000 });

    expect(segments).toEqual(["a".repeat(3000), "a"]);
    expect(segments.every((segment) => segment.length <= 3000)).toBe(true);
  });

  test("微信分段不因 emoji 的代理对而超过字符上限", () => {
    const text = "😀".repeat(1499) + "a😀";
    const segments = splitImMessage(text, { maxChars: 3000 });

    expect(segments.join("")).toBe(text);
    expect(segments.every((segment) => segment.length <= 3000)).toBe(true);
  });

  test("全部成功直通", async () => {
    const sent: string[] = [];
    expect(await sendImSegments(["a", "b"], async (s) => {
      sent.push(s);
      return { ok: true };
    })).toEqual({ ok: true });
    expect(sent).toEqual(["a", "b"]);
  });

  test("瞬时错误重发一次后成功，不计失败", async () => {
    const attempts: string[] = [];
    expect(
      await sendImSegments(["a"], async (s) => {
        attempts.push(s);
        return attempts.length === 1 ? { ok: false, error: "timeout", transient: true } : { ok: true };
      })
    ).toEqual({ ok: true });
    expect(attempts).toEqual(["a", "a"]);
  });

  test("中途确定性失败：错误补已送达 N/M 段，且不重发", async () => {
    const attempts: string[] = [];
    const result = await sendImSegments(["s1", "s2", "s3"], async (s) => {
      attempts.push(s);
      return s === "s2" ? { ok: false, error: "HTTP 400", transient: false } : { ok: true };
    });
    expect(result).toEqual({ ok: false, error: "已送达 1/3 段，后续未送达：HTTP 400" });
    expect(attempts).toEqual(["s1", "s2"]);
  });

  test("瞬时错误重发仍失败：只重发一次", async () => {
    let count = 0;
    const result = await sendImSegments(["x"], async () => {
      count += 1;
      return { ok: false, error: "net down", transient: true };
    });
    expect(count).toBe(2);
    expect(result).toEqual({ ok: false, error: "net down" });
  });
});
