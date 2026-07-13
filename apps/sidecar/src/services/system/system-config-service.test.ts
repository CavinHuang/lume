import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLumeConfigYamlPath, getLumeJsonPath } from "../infra/config-paths";
import { getEffectiveSystemConfig, getPrimarySystemConfig } from "./system-config-service";

describe("system-config-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-system-config-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("应在缺失时生成默认 lume.json", () => {
    const config = getPrimarySystemConfig();
    expect(config.version).toBe(1);
    expect(readFileSync(getLumeJsonPath(), "utf-8")).toContain("\"version\": 1");
  });

  test("应优先用 lume.yaml 覆盖 lume.json 中的 embedding model ref", () => {
    writeFileSync(getLumeJsonPath(), JSON.stringify({
      version: 1,
      models: {
        chat: {
          defaultModelRef: "openai/gpt-4.1"
        },
        agent: {
          defaultModelRef: "openai/gpt-5.4"
        },
        embedding: {
          defaultModelRef: "openai/text-embedding-3-small"
        },
        computerUse: {
          visionModelRefs: ["openai/gpt-4.1-mini"]
        }
      }
    }, null, 2), "utf-8");

    writeFileSync(getLumeConfigYamlPath(), [
      "version: 1",
      "models:",
      "  chat:",
      "    defaultModelRef: anthropic/claude-sonnet-4-5",
      "  agent:",
      "    defaultModelRef: openai/gpt-5.4-mini",
      "  embedding:",
      "    defaultModelRef: google/gemini-embedding-001",
      "  computerUse:",
      "    visionModelRefs:",
      "      - google/gemini-2.5-flash"
    ].join("\n"), "utf-8");

    const effective = getEffectiveSystemConfig();
    expect(effective.models?.chat?.defaultModelRef).toBe("anthropic/claude-sonnet-4-5");
    expect(effective.models?.agent?.defaultModelRef).toBe("openai/gpt-5.4-mini");
    expect(effective.models?.embedding?.defaultModelRef).toBe("google/gemini-embedding-001");
    expect(effective.models?.computerUse?.visionModelRefs).toEqual(["google/gemini-2.5-flash"]);
  });
});
