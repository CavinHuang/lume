// 构建期：读资源清单锁定的 OpenConnector service 列表 + simple-icons，生成 service→{path,hex} 映射。
import { readFile, writeFile } from "node:fs/promises";
import { extract } from "tar-stream";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import * as simpleIcons from "simple-icons";

const manifest = JSON.parse(
  await readFile(new URL("../../../scripts/openconnector-resource.json", import.meta.url), "utf8"),
);

// service(小写)→ simple-icons slug 手工修正（不一致时填）
const SLUG_OVERRIDES = {
  active_campaign: "activecampaign",
  google_calendar: "googlecalendar",
  microsoft_teams: "microsoftteams",
};

// OpenConnector service 与 theSVG 品牌 slug 的少量语义差异。
const COMMUNITY_SLUG_OVERRIDES = {
  apollo: "apollodotio",
  outlook: "microsoft-outlook",
  telegram_bot: "telegram",
};

function serviceToSlug(service) {
  if (SLUG_OVERRIDES[service]) return SLUG_OVERRIDES[service];
  return service.replaceAll("_", "-");
}

const services = [];

async function fetchServiceList() {
  const res = await fetch(manifest.archiveUrl);
  if (!res.ok || !res.body) throw new Error(`fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const gz = gunzipSync(buf);
  await new Promise((resolve, reject) => {
    const extractor = extract();
    extractor.on("entry", (header, stream, next) => {
      // 仅关注 providers 目录下的 definition 路径，取目录名
      const m = header.name.match(/open-connector-[^/]+\/src\/providers\/([^/]+)\/definition\.ts$/);
      if (m) {
        const svc = m[1];
        if (!services.includes(svc)) services.push(svc);
      }
      stream.on("data", () => {});
      stream.on("end", next);
    });
    extractor.on("finish", resolve);
    extractor.on("error", reject);
    Readable.from(gz).pipe(extractor);
  });
  return services.sort();
}

const map = {};
const communityMap = {};
const communityRegistry = await fetch("https://thesvg.org/api/registry.json").then((response) => {
  if (!response.ok) throw new Error(`fetch theSVG registry ${response.status}`);
  return response.json();
});
const compact = (value) => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
const communitySlugs = new Map();
for (const icon of communityRegistry.icons ?? []) {
  for (const value of [icon.slug, icon.title, ...(icon.aliases ?? [])]) {
    const key = compact(value);
    if (key && !communitySlugs.has(key)) communitySlugs.set(key, icon.slug);
  }
}

for (const service of await fetchServiceList()) {
  const slug = serviceToSlug(service);
  // simple-icons 导出形如 siSlack（驼峰）
  const exportName =
    "si" + slug.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  const icon = simpleIcons[exportName];
  if (icon && icon.path) {
    map[service.toLowerCase()] = { path: icon.path, hex: icon.hex };
  }
  const communitySlug =
    COMMUNITY_SLUG_OVERRIDES[service] ??
    (service.startsWith("alibaba_cloud_") ? "alibaba-cloud" : communitySlugs.get(compact(service)));
  if (communitySlug) {
    communityMap[service.toLowerCase()] =
      `https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/${communitySlug}/default.svg`;
  }
}

const out = `// 自动生成（scripts/generate-link-icons.mjs）。勿手改。OpenConnector ${manifest.version} × Simple Icons。
export const LINK_ICONS: Record<string, { path: string; hex: string }> = ${JSON.stringify(map, null, 2)};\n`;
const communityOut = `\n// 首选社区维护的 theSVG 品牌目录；加载失败后回退本地图标，再回退字母图标。\nexport const LINK_ICON_URLS: Record<string, string> = ${JSON.stringify(communityMap, null, 2)};\n`;
await writeFile(
  new URL("../src/lib/generated/link-icons.ts", import.meta.url),
  out + communityOut,
  "utf8",
);
console.log(`generated ${Object.keys(map).length} local icons + ${Object.keys(communityMap).length} community fallbacks`);
