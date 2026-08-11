import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_ICONS, LINK_ICON_URLS } from "../src/lib/generated/link-icons";
import { LOBEHUB_SERVICES } from "../src/lib/provider-icon";

interface OomolLogoEntry {
  service: string;
  displayName: string;
  url: string;
}

const mapPath = process.argv[2];
if (!mapPath) {
  throw new Error("Usage: bun scripts/sync-oomol-provider-logos.ts <oomol-logo-map.json>");
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const catalogDir = join(repoRoot, "apps", "desktop", "resources", "openconnector", "catalog", "apps");
const assetDir = join(webRoot, "public", "provider-logos");
const generatedMapPath = join(webRoot, "src", "lib", "generated", "local-provider-icons.ts");
const sourceManifestPath = join(assetDir, "sources.json");
const openConnectorResource = JSON.parse(
  await readFile(join(repoRoot, "scripts", "openconnector-resource.json"), "utf8"),
) as { version: string };
const oomolEntries = JSON.parse(await readFile(resolve(mapPath), "utf8")) as OomolLogoEntry[];
const oomolByService = new Map(oomolEntries.map((entry) => [entry.service.toLowerCase(), entry]));
const lobehubServices = new Set<string>(LOBEHUB_SERVICES);
const providerServices = (await readdir(catalogDir))
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -extname(name).length))
  .sort();
const missingServices = providerServices.filter(
  (service) => !LINK_ICON_URLS[service] && !LINK_ICONS[service] && !lobehubServices.has(service),
);
const missingOomolEntries = missingServices.map((service) => {
  const entry = oomolByService.get(service);
  if (!entry) throw new Error(`OOMOL logo missing for OpenConnector provider: ${service}`);
  if (!entry.url.startsWith("https://static.oomol.com/logo/")) {
    throw new Error(`Unexpected OOMOL logo source for ${service}: ${entry.url}`);
  }
  return entry;
});

await mkdir(assetDir, { recursive: true });
const localIconUrls: Record<string, string> = {};
const sources: Array<{ service: string; file: string; url: string }> = [];

for (let index = 0; index < missingOomolEntries.length; index += 20) {
  await Promise.all(
    missingOomolEntries.slice(index, index + 20).map(async (entry) => {
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`Download failed for ${entry.service}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const extension = imageExtension(bytes, entry.url, entry.service);
      const file = `${entry.service}${extension}`;
      const fileContent = extension === ".svg" ? normalizeSvg(bytes) : bytes;
      await writeFile(join(assetDir, file), fileContent);
      localIconUrls[entry.service] = `/provider-logos/${file}`;
      sources.push({ service: entry.service, file, url: entry.url });
    }),
  );
  console.log(`downloaded ${Math.min(index + 20, missingOomolEntries.length)} / ${missingOomolEntries.length}`);
}

const sortedLocalIconUrls = Object.fromEntries(Object.entries(localIconUrls).sort(([a], [b]) => a.localeCompare(b)));
sources.sort((a, b) => a.service.localeCompare(b.service));
await writeFile(
  generatedMapPath,
  `// 自动生成（scripts/sync-oomol-provider-logos.ts）。勿手改。\n` +
    `export const LOCAL_PROVIDER_ICON_URLS: Record<string, string> = ${JSON.stringify(sortedLocalIconUrls, null, 2)};\n`,
  "utf8",
);
await writeFile(
  sourceManifestPath,
  `${JSON.stringify(
    {
      source: "https://console.oomol.com/connections",
      assetOrigin: "https://static.oomol.com/logo/",
      openConnectorVersion: openConnectorResource.version,
      entries: sources,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`generated ${sources.length} local provider logos`);

function imageExtension(bytes: Uint8Array, url: string, service: string): ".svg" | ".png" | ".webp" | ".jpg" {
  const textPrefix = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
  if (textPrefix.startsWith("<svg") || textPrefix.startsWith("<?xml")) return ".svg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (textPrefix.startsWith("RIFF") && textPrefix.slice(8, 12) === "WEBP") return ".webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  throw new Error(`Invalid logo downloaded for ${service}: ${url}`);
}

function normalizeSvg(bytes: Uint8Array): string {
  return `${new TextDecoder().decode(bytes).replace(/\r\n/g, "\n").replace(/\t/g, "  ").replace(/ +$/gm, "").trimEnd()}\n`;
}
