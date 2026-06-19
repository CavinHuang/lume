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
requireAsset("macOS ARM updater archive", names, [/\.app\.tar\.gz$/i], [/aarch64|arm64/i]);
requireAsset("macOS ARM updater signature", names, [/\.app\.tar\.gz\.sig$/i], [/aarch64|arm64/i]);
requireAsset("macOS Intel dmg", names, [/\.dmg$/i], [/x86_64|x64/i]);
requireAsset("macOS Intel updater archive", names, [/\.app\.tar\.gz$/i], [/x86_64|x64/i]);
requireAsset("macOS Intel updater signature", names, [/\.app\.tar\.gz\.sig$/i], [/x86_64|x64/i]);
requireAsset("Windows NSIS installer", names, [/\.exe$/i], []);
requireAsset("Windows NSIS signature", names, [/\.exe\.sig$/i], []);
requireAsset("latest.json", names, [/^latest\.json$/i], []);

const latest = JSON.parse(downloadReleaseAsset(tag, "latest.json"));
const platformEntries = collectLatestJsonEntries(latest);
requireLatestCoverage("macOS ARM", platformEntries, [/darwin|macos/i, /aarch64|arm64/i]);
requireLatestCoverage("macOS Intel", platformEntries, [/darwin|macos/i, /x86_64|x64/i]);
requireLatestCoverage("Windows x64", platformEntries, [/windows|win32|msvc/i, /x86_64|x64/i]);

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

function collectLatestJsonEntries(value, path = "$", entries = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLatestJsonEntries(item, `${path}[${index}]`, entries));
    return entries;
  }
  if (value && typeof value === "object") {
    const record = value;
    const url = typeof record.url === "string" ? record.url : "";
    const signature = typeof record.signature === "string" ? record.signature : "";
    const notes = typeof record.notes === "string" ? record.notes : "";
    const payload = `${path} ${url} ${signature} ${notes}`;
    if (url || signature) entries.push(payload);
    for (const [key, item] of Object.entries(record)) {
      collectLatestJsonEntries(item, `${path}.${key}`, entries);
    }
  }
  return entries;
}

function requireLatestCoverage(label, entries, patterns) {
  const found = entries.some((entry) => patterns.every((pattern) => pattern.test(entry)));
  if (!found) fail(`latest.json missing updater coverage for ${label}\nentries:\n${entries.join("\n")}`);
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
