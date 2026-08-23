import { describe, expect, test } from "bun:test";
import { stableSerialize } from "./stable-serialize";

// The exact byte output is load-bearing (repeat-guard signatures in the SDK,
// persisted payload hashes in the sidecar submission store) — these golden
// values pin it. Any change here is a breaking change for existing hashes.
describe("stableSerialize", () => {
  test("sorts object keys by code-unit order, independent of locale", () => {
    expect(stableSerialize({ b: 1, a: 2, C: 3 })).toBe('{"C":3,"a":2,"b":1}');
  });

  test("sorts non-ASCII and mixed-case keys by code points, not locale collation", () => {
    // The localeCompare fork point: locale collation groups case-insensitively
    // and reorders CJK/symbol blocks; code-unit sort keeps uppercase < lowercase
    // and BMP < astral. This exact byte order is load-bearing.
    expect(
      stableSerialize({ az: 1, 中文: 2, AZ: 3, "🎉": 4, Az: 5, 键: 6, aZ: 7 }),
    ).toBe('{"AZ":3,"Az":5,"aZ":7,"az":1,"中文":2,"键":6,"🎉":4}');
  });

  test("drops undefined-valued properties but keeps null", () => {
    expect(stableSerialize({ a: undefined, b: null, c: 0, d: "" })).toBe(
      '{"b":null,"c":0,"d":""}',
    );
  });

  test("preserves array order", () => {
    expect(stableSerialize([3, 1, 2])).toBe("[3,1,2]");
    expect(stableSerialize({ list: ["z", "a"] })).toBe('{"list":["z","a"]}');
  });

  test("recurses into nested structures deterministically", () => {
    const input = {
      outer: { z: 1, a: { y: [2, { k: undefined, j: 1 }] } },
      arr: [{ q: 1, b: 2 }],
    };
    expect(stableSerialize(input)).toBe(
      '{"arr":[{"b":2,"q":1}],"outer":{"a":{"y":[2,{"j":1}]},"z":1}}',
    );
  });

  test("serializes primitives exactly like JSON.stringify", () => {
    expect(stableSerialize("x")).toBe('"x"');
    expect(stableSerialize(42)).toBe("42");
    expect(stableSerialize(true)).toBe("true");
    expect(stableSerialize(null)).toBe("null");
    expect(stableSerialize(undefined)).toBe("undefined");
  });
});
