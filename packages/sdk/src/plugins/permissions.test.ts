import { describe, expect, test } from "bun:test";
import {
  checkToolPermission,
  matchPathGlob,
  checkFilesystemPermission,
  checkNetworkPermission,
} from "./permissions.js";

describe("PluginPermissions", () => {
  const pluginRoot = "/home/user/.lume/plugins/cache/my-plugin/1.0.0";

  describe("matchPathGlob", () => {
    test("matches exact path", () => {
      expect(
        matchPathGlob(
          "/home/user/.lume/plugins/cache/my-plugin/1.0.0/data/file.txt",
          ["./data/**"],
          pluginRoot,
        ),
      ).toBe(true);
    });

    test("rejects path outside pattern", () => {
      expect(
        matchPathGlob(
          "/home/user/.lume/plugins/cache/my-plugin/1.0.0/secret.json",
          ["./data/**"],
          pluginRoot,
        ),
      ).toBe(false);
    });

    test("matches wildcard in subdirectory", () => {
      expect(
        matchPathGlob(
          "/home/user/.lume/plugins/cache/my-plugin/1.0.0/skills/foo/SKILL.md",
          ["./skills/**"],
          pluginRoot,
        ),
      ).toBe(true);
    });

    test("matches root-level pattern", () => {
      expect(
        matchPathGlob(
          "/home/user/.lume/plugins/cache/my-plugin/1.0.0/readme.md",
          ["./**"],
          pluginRoot,
        ),
      ).toBe(true);
    });

    test("normalizes relative paths against plugin root", () => {
      expect(matchPathGlob("data/file.txt", ["./data/**"], pluginRoot)).toBe(
        true,
      );
    });
  });

  describe("checkFilesystemPermission", () => {
    const perms = {
      filesystem: {
        read: ["./data/**", "./skills/**"],
        write: ["./data/**"],
      },
    };

    test("allows read within declared pattern", () => {
      expect(
        checkFilesystemPermission("read", "./data/config.json", perms, pluginRoot),
      ).toBe("allow");
    });

    test("denies read outside declared pattern", () => {
      expect(
        checkFilesystemPermission("read", "./secret.json", perms, pluginRoot),
      ).toBe("ask");
    });

    test("allows write within declared pattern", () => {
      expect(
        checkFilesystemPermission("write", "./data/output.txt", perms, pluginRoot),
      ).toBe("allow");
    });

    test("denies write outside declared pattern", () => {
      expect(
        checkFilesystemPermission("write", "./skills/foo.txt", perms, pluginRoot),
      ).toBe("ask");
    });

    test("returns ask when filesystem is not declared", () => {
      expect(
        checkFilesystemPermission("read", "./data/x.txt", {}, pluginRoot),
      ).toBe("ask");
    });
  });

  describe("checkToolPermission", () => {
    test("deny takes highest priority", () => {
      const perms = {
        tools: {
          allow: ["Bash"],
          deny: ["Bash"],
        },
      };
      expect(checkToolPermission("Bash", perms)).toBe("deny");
    });

    test("allow matches before ask", () => {
      const perms = {
        tools: {
          allow: ["FileRead", "Glob"],
          ask: ["WebFetch"],
        },
      };
      expect(checkToolPermission("FileRead", perms)).toBe("allow");
      expect(checkToolPermission("WebFetch", perms)).toBe("ask");
    });

    test("returns undefined when tool not listed", () => {
      const perms = {
        tools: {
          allow: ["FileRead"],
        },
      };
      expect(checkToolPermission("Bash", perms)).toBeUndefined();
    });

    test("returns undefined when no tools section", () => {
      expect(checkToolPermission("Bash", {})).toBeUndefined();
    });
  });

  describe("checkNetworkPermission", () => {
    test("allows host in outbound list", () => {
      const perms = { network: { outbound: ["api.example.com", "*.cdn.example.com"] } };
      expect(checkNetworkPermission("api.example.com", perms)).toBe("allow");
    });

    test("allows wildcard match", () => {
      const perms = { network: { outbound: ["*.cdn.example.com"] } };
      expect(checkNetworkPermission("assets.cdn.example.com", perms)).toBe("allow");
    });

    test("asks for host not in list", () => {
      const perms = { network: { outbound: ["api.example.com"] } };
      expect(checkNetworkPermission("evil.com", perms)).toBe("ask");
    });
  });
});
