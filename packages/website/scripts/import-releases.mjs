// 从 GitHub Releases 导入更新日志：bun scripts/import-releases.mjs
// 每次发版后重跑即可；正文保持发布原文，不区分语言
import { mkdirSync, writeFileSync } from 'node:fs';

const REPO = 'CavinHuang/lume';
const OUT = new URL('../src/content/changelog/', import.meta.url);

const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`);
if (!res.ok) {
  console.error(`GitHub API ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const releases = await res.json();
mkdirSync(OUT, { recursive: true });

for (const r of releases) {
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(r.name ?? r.tag_name)}`,
    `version: ${r.tag_name}`,
    `date: ${r.published_at}`,
    '---',
    '',
  ].join('\n');
  const body = (r.body ?? '').replace(/\r\n/g, '\n');
  writeFileSync(new URL(`${r.tag_name}.md`, OUT), frontmatter + body + '\n');
  console.log(`✓ ${r.tag_name}`);
}
console.log(`Imported ${releases.length} releases.`);
