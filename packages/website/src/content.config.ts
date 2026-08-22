import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 使用文档：目录分语 src/content/docs/{zh,en}/…，同 slug 即互译
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    lang: z.enum(['zh', 'en']),
    order: z.number().default(99),
  }),
});

// 更新日志：由 scripts/import-releases.mjs 从 GitHub Releases 导入，
// 正文保持发布原文（语言中立），zh/en 页共用同一份
const changelog = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/changelog' }),
  schema: z.object({
    title: z.string(),
    version: z.string(),
    date: z.coerce.date(),
  }),
});

export const collections = { docs, changelog };
