import { describe, expect, it } from "bun:test";
import { createPinnedLookup } from "./guarded-fetch";

describe("createPinnedLookup", () => {
  it("answers from the screened set with round-robin failover", () => {
    const lookup = createPinnedLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    const seen: Array<{ address: string; family: number }> = [];
    const run = (index: number) =>
      new Promise<void>((resolve, reject) => {
        // LookupFunction 的 callback 形制:(err, address, family)
        (lookup as unknown as (...args: unknown[]) => void)(
          "example.com",
          {},
          (error: Error | null, address?: string, family?: number) => {
            if (error) reject(error);
            else {
              seen.push({ address: address!, family: family! });
              resolve();
            }
          },
        );
        void index;
      });

    return Promise.all([run(0), run(1), run(2)]).then(() => {
      expect(seen.map((entry) => entry.address)).toEqual([
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
        "93.184.216.34",
      ]);
      expect(seen[2]!.family).toBe(4);
    });
  });

  it("fails closed on an empty screened set", () => {
    const lookup = createPinnedLookup([]);
    return new Promise<void>((resolve, reject) => {
      (lookup as unknown as (...args: unknown[]) => void)("example.com", {}, (error: Error | null) => {
        expect(error?.message).toContain("no screened addresses");
        resolve();
        void reject;
      });
    });
  });
});
