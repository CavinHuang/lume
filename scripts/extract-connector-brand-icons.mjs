// 从 @iconify-json/* 抽取邮箱/IM 连接器需要的品牌图标 path,生成纯数据 ts 文件。
// 运行:bun scripts/extract-connector-brand-icons.mjs(在仓库根执行)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bunStore = resolve(REPO_ROOT, "node_modules", ".bun");

function loadSet(prefix) {
  const dir = readdirSync(bunStore).find((d) => d.startsWith(prefix));
  if (!dir) throw new Error(`package not found: ${prefix}`);
  return JSON.parse(readFileSync(resolve(bunStore, dir, "node_modules", "@iconify-json", prefix.replace("@iconify-json+", ""), "icons.json"), "utf8"));
}

/** 目标:连接器 service → 图标来源集合与名称。 */
const WANTED = [
  { key: "gmail", set: "logos", name: "google-gmail" },
  { key: "qq_mail", set: "fa6-brands", name: "qq" },
  { key: "weixin", set: "simple-icons", name: "wechat" },
  { key: "dingtalk", set: "arcticons", name: "dingtalk" },
  { key: "wecom", set: "arcticons", name: "wecom" },
];

const cache = new Map();
const out = [];
for (const item of WANTED) {
  if (!cache.has(item.set)) {
    cache.set(item.set, loadSet(`@iconify-json+${item.set}`));
  }
  const store = cache.get(item.set);
  const icon = store.icons[item.name];
  if (!icon) throw new Error(`icon missing in ${item.set}: ${item.name}`);
  const width = icon.width ?? store.width ?? 16;
  const height = icon.height ?? store.height ?? 16;
  out.push(`  ${item.key}: { body: ${JSON.stringify(icon.body)}, viewBox: "0 0 ${width} ${height}" },`);
}

const content = `// 由 scripts/extract-connector-brand-icons.mjs 生成;勿手改,重跑脚本再生成。
// 来源:@iconify-json/{logos,fa6-brands,simple-icons,arcticons}(devDependencies)。
export interface ConnectorBrandIcon {
  /** SVG 内部元素(iconify body)。 */
  body: string;
  viewBox: string;
}

export const CONNECTOR_BRAND_ICONS: Record<string, ConnectorBrandIcon> = {
${out.join("\n")}
};
`;

const target = resolve(REPO_ROOT, "apps", "web", "src", "components", "settings", "connector-brand-paths.ts");
writeFileSync(target, content, "utf8");
console.log(`written ${target} (${out.length} icons)`);
