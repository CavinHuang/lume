import { describe, expect, test } from "bun:test";
import { toLumeRpcErrorShape } from "./rpc-error";

describe("toLumeRpcErrorShape", () => {
  test("显式 code 优先", () => {
    const error = Object.assign(new Error("boom"), { code: "connection_disabled" });
    expect(toLumeRpcErrorShape(error)).toEqual({ code: "connection_disabled", message: "boom" });
  });

  test("code 优先于非泛型 name(两者并存时不得取 name)", () => {
    class VaultLockedError extends Error {
      constructor() {
        super("vault locked");
        this.name = "VaultLockedError";
      }
    }
    const error = Object.assign(new VaultLockedError(), { code: "vault_locked" });
    const shape = toLumeRpcErrorShape(error);
    expect(shape.code).toBe("vault_locked");
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

  test("内置子类 name 同样透传为 code(TypeError 直抛边界)", () => {
    // 过渡态语义(rpc-error.ts 注释钉死):name 码非稳定 API,新增错误一律显式 code。
    expect(toLumeRpcErrorShape(new TypeError("not a fn")).code).toBe("TypeError");
  });

  test("空串 code 视为缺失,回落 name/E_RPC 判定链", () => {
    const error = Object.assign(new Error("empty code"), { code: "" });
    expect(toLumeRpcErrorShape(error).code).toBe("E_RPC");
  });

  test("裸 Error 与非 Error 塌缩到 E_RPC", () => {
    expect(toLumeRpcErrorShape(new Error("plain")).code).toBe("E_RPC");
    expect(toLumeRpcErrorShape("raw string")).toEqual({ code: "E_RPC", message: "raw string" });
    expect(toLumeRpcErrorShape(undefined).code).toBe("E_RPC");
  });

  test("空 message 的 Error 以 String(error) 兜底文案", () => {
    const shape = toLumeRpcErrorShape(new Error(""));
    expect(shape.message).toBe("Error");
  });

  test("details 显式携带时透传,缺省不出现该键", () => {
    const withDetails = Object.assign(new Error("bad input"), {
      code: "E_INVALID_PARAMS",
      details: { method: "test:m", path: "threadId" }
    });
    expect(toLumeRpcErrorShape(withDetails)).toEqual({
      code: "E_INVALID_PARAMS",
      message: "bad input",
      details: { method: "test:m", path: "threadId" }
    });
    const withoutDetails = toLumeRpcErrorShape(new Error("plain"));
    expect(Object.keys(withoutDetails)).toEqual(["code", "message"]);
  });
});
