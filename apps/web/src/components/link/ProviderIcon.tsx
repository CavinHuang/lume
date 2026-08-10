import { useState } from "react";
// 走 Mono 组件直连深路径,绕过 @lobehub/icons 的 index/features 入口:
// 根 es/index.js 用 `export * from './features'`,features/IconAvatar 依赖 @lobehub/ui,
// 而 @lobehub/ui v5 的 Tooltip 用 React 19 的 `use()` hook;项目是 React 18.3.1 →
// 任何加载 features 的路径(含 bun:test 无 tree-shake 场景、含每个 icon 的 Avatar 组件)运行时崩。
// `es/<Icon>/components/Mono.js` 仅 `import { memo } from 'react'` + 自家 style,自包含。
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";
import FigmaMono from "@lobehub/icons/es/Figma/components/Mono";
import GithubMono from "@lobehub/icons/es/Github/components/Mono";
import MicrosoftMono from "@lobehub/icons/es/Microsoft/components/Mono";
import NotionMono from "@lobehub/icons/es/Notion/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import PerplexityMono from "@lobehub/icons/es/Perplexity/components/Mono";
import VercelMono from "@lobehub/icons/es/Vercel/components/Mono";
import type { IconType } from "@lobehub/icons/es/types";
import { LINK_ICONS } from "@/lib/generated/link-icons";
import { colorForSeed, decideIconKind, initialOf } from "@/lib/provider-icon";
import { SimpleIconGlyph } from "./SimpleIconGlyph";

// service(小写)→ lobehub Mono 组件。keys 必须与 LOBEHUB_SERVICES 对齐。
const LOBEHUB_MAP: Record<string, IconType> = {
  github: GithubMono, notion: NotionMono, microsoft: MicrosoftMono, figma: FigmaMono, vercel: VercelMono,
  openai: OpenAIMono, anthropic: AnthropicMono, cohere: CohereMono, perplexity: PerplexityMono,
};

interface ProviderIconProps {
  service: string;
  displayName?: string;
  iconUrl?: string;
  size?: number;
}

export function ProviderIcon({ service, displayName, iconUrl, size = 24 }: ProviderIconProps) {
  const kind = decideIconKind(service, iconUrl);

  if (kind === "lobehub") {
    const Icon = LOBEHUB_MAP[service.toLowerCase()];
    if (Icon) return <Icon size={size} />;
  }

  if (kind === "simpleIcon") {
    const icon = LINK_ICONS[service.toLowerCase()];
    if (icon) {
      return (
        <span className="shrink-0 text-[var(--lume-text-2)]" style={{ width: size, height: size }}>
          <SimpleIconGlyph path={icon.path} size={size} />
        </span>
      );
    }
  }

  if (kind === "image" && iconUrl) {
    return <ImageIcon src={iconUrl} alt={displayName ?? service} size={size} fallbackLetter={initialOf(displayName || service)} fallbackSeed={service} />;
  }

  return <LetterBlock size={size} seed={service} letter={initialOf(displayName || service)} />;
}

function LetterBlock({ size, seed, letter }: { size: number; seed: string; letter: string }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded font-medium text-white"
      style={{ width: size, height: size, background: colorForSeed(seed), fontSize: size * 0.45 }}
    >
      {letter}
    </div>
  );
}

function ImageIcon({ src, alt, size, fallbackLetter, fallbackSeed }: { src: string; alt: string; size: number; fallbackLetter: string; fallbackSeed: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <LetterBlock size={size} seed={fallbackSeed} letter={fallbackLetter} />;
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="shrink-0 rounded object-contain"
      onError={() => setFailed(true)}
    />
  );
}
