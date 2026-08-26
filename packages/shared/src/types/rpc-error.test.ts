import { describe, expect, test } from "bun:test";
import { toLumeRpcErrorShape } from "./rpc-error";

describe("toLumeRpcErrorShape", () => {
  test("显式 code 优先", () => {
    const error = Object.assign(new Error("boom"), { code: "connection_disabled" });
    expect(toLumeRpcErrorShape(error)).toEqual({ code: "connection_disabled", message: "boom" });
  });

  test("Error 子类 name 兜底为 code", () => {
    class VaultLockedError extends Error {
      constructor() {
        super("vault locked");
        this.name = "VaultLockedError";
      }
    }
    expect(toLumeRpcErrorShape(new VaultLockedError())).toEqual({ code: "VaultLockedError", message: "vault locked" });
  });

  test("裸 Error 与非 Error 塌缩到 E_RPC", () => {
    expect(toLumeRpcErrorShape(new Error("plain")).code).toBe("E_RPC");
    expect(toLumeRpcErrorShape("raw string")).toEqual({ code: "E_RPC", message: "raw string" });
    expect(toLumeRpcErrorShape(undefined).code).toBe("E_RPC");
  });
});
