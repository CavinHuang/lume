import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
}

const PI_PACKAGES = [
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent"
] as const;

function readPackageJson(path: string): PackageJsonShape {
  return JSON.parse(readFileSync(path, "utf-8")) as PackageJsonShape;
}

function getDeclaredVersion(pkg: PackageJsonShape, dependencyName: string): string | undefined {
  return pkg.dependencies?.[dependencyName] ?? pkg.devDependencies?.[dependencyName];
}

function collectPiOverrides(record: Record<string, unknown> | undefined): string[] {
  if (!record) {
    return [];
  }
  return Object.keys(record).filter((key) => key.includes("@mariozechner/pi-"));
}

describe("pi package graph guard", () => {
  test("sidecar 应将 Pi 包精确 pin 到同一版本", () => {
    const sidecarPackageJson = readPackageJson(join(import.meta.dir, "../../../package.json"));
    const versions = PI_PACKAGES.map((name) => getDeclaredVersion(sidecarPackageJson, name));

    for (const version of versions) {
      expect(version).toBeDefined();
      expect(version?.startsWith("^")).toBeFalse();
      expect(version?.startsWith("~")).toBeFalse();
    }

    expect(new Set(versions).size).toBe(1);
  });

  test("root 与 sidecar package.json 不应覆盖 Pi 包版本", () => {
    const rootPackageJson = readPackageJson(join(import.meta.dir, "../../../../../package.json"));
    const sidecarPackageJson = readPackageJson(join(import.meta.dir, "../../../package.json"));

    expect(collectPiOverrides(rootPackageJson.overrides)).toEqual([]);
    expect(collectPiOverrides(rootPackageJson.resolutions)).toEqual([]);
    expect(collectPiOverrides(sidecarPackageJson.overrides)).toEqual([]);
    expect(collectPiOverrides(sidecarPackageJson.resolutions)).toEqual([]);
  });
});
