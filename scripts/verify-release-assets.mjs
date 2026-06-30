import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag) fail("missing tag name");
if (!process.env.GH_TOKEN) fail("missing GH_TOKEN");

const release = ghJson(["release", "view", tag, "--json", "assets,isDraft"]);
if (!release.isDraft) fail(`release ${tag} is not draft`);
const names = (release.assets ?? []).map((asset) => asset.name);

requireAsset("macOS ARM dmg", names, [/\.dmg$/i], [/aarch64|arm64/i]);
requireAsset("macOS Intel dmg", names, [/\.dmg$/i], [/x86_64|x64/i]);
requireAsset("macOS updater manifest", names, [/^latest-mac\.yml$/i], []);
requireAsset("Windows NSIS installer", names, [/\.exe$/i], []);
requireAsset("Windows NSIS blockmap", names, [/\.exe\.blockmap$/i], []);
requireAsset("Windows updater manifest", names, [/^latest\.yml$/i], []);
requireAsset("Linux x64 AppImage", names, [/\.AppImage$/i], [/x64|x86_64|amd64/i]);
requireAsset("Linux ARM64 AppImage", names, [/\.AppImage$/i], [/arm64|aarch64/i]);
requireAsset("Linux updater manifest", names, [/^latest-linux\.yml$/i], []);

const windowsLatest = downloadReleaseAsset(tag, "latest.yml");
if (!/\.exe/i.test(windowsLatest)) fail("latest.yml does not reference a Windows installer");

const macLatest = downloadReleaseAsset(tag, "latest-mac.yml");
if (!/\.dmg/i.test(macLatest)) fail("latest-mac.yml does not reference a macOS dmg");
if (!/(?:aarch64|arm64)/i.test(macLatest) || !/(?:x86_64|x64)/i.test(macLatest)) {
  fail("latest-mac.yml does not reference both macOS ARM and Intel artifacts");
}

writeSummary(names);
console.error(`[verify-release-assets] ok for ${tag}`);

function requireAsset(label, names, requiredPatterns, optionalArchPatterns) {
  const found = names.some((name) => {
    const hasRequired = requiredPatterns.every((pattern) => pattern.test(name));
    const hasArch = optionalArchPatterns.length === 0 || optionalArchPatterns.some((pattern) => pattern.test(name));
    return hasRequired && hasArch;
  });
  if (!found) fail(`missing remote asset: ${label}\nassets:\n${names.join("\n")}`);
}

function ghJson(args) {
  return JSON.parse(ghText(args));
}

function ghText(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) fail(`gh ${args.join(" ")} failed\n${result.stderr}`);
  return result.stdout;
}

function downloadReleaseAsset(tag, pattern) {
  const dir = mkdtempSync(join(tmpdir(), "lume-release-assets-"));
  try {
    ghText(["release", "download", tag, "--pattern", pattern, "--dir", dir]);
    return readFileSync(join(dir, pattern), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSummary(names) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  appendFileSync(summary, `\n### Remote release assets\n` + names.map((name) => `- ${name}`).join("\n") + "\n");
}

function fail(message) {
  console.error(`[verify-release-assets] ${message}`);
  process.exit(1);
}
