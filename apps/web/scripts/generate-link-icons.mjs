// 构建期：读取仓库内锁定的 OpenConnector catalog，生成 service→theSVG URL 映射。
import { readdir, writeFile } from "node:fs/promises";

const COMMUNITY_SLUG_OVERRIDES = {
  apollo: "apollodotio",
  outlook: "microsoft-outlook",
  telegram_bot: "telegram",
};

const catalogUrl = new URL("../../../apps/desktop/resources/openconnector/catalog/apps/", import.meta.url);
const services = (await readdir(catalogUrl))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -".json".length))
  .sort();
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

const communityMap = {};
for (const service of services) {
  const communitySlug =
    COMMUNITY_SLUG_OVERRIDES[service] ??
    (service.startsWith("alibaba_cloud_") ? "alibaba-cloud" : communitySlugs.get(compact(service)));
  if (communitySlug) {
    communityMap[service.toLowerCase()] =
      `https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/${communitySlug}/default.svg`;
  }
}

const output = `// 自动生成（scripts/generate-link-icons.mjs）。勿手改。\n` +
  `// 首选社区维护的 theSVG 品牌目录；加载失败后回退本地图标，再回退字母图标。\n` +
  `export const LINK_ICON_URLS: Record<string, string> = ${JSON.stringify(communityMap, null, 2)};\n`;
await writeFile(new URL("../src/lib/generated/link-icons.ts", import.meta.url), output, "utf8");
console.log(`generated ${Object.keys(communityMap).length} community icon URLs`);
