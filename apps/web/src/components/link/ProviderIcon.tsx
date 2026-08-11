import { useState } from "react";
// 走 Mono 组件直连深路径,绕过 @lobehub/icons 的 index/features 入口:
// 根 es/index.js 用 `export * from './features'`,features/IconAvatar 依赖 @lobehub/ui,
// 而 @lobehub/ui v5 的 Tooltip 用 React 19 的 `use()` hook;项目是 React 18.3.1 →
// 任何加载 features 的路径(含 bun:test 无 tree-shake 场景、含每个 icon 的 Avatar 组件)运行时崩。
// `es/<Icon>/components/Mono.js` 仅 `import { memo } from 'react'` + 自家 style,自包含。
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import PerplexityMono from "@lobehub/icons/es/Perplexity/components/Mono";
import type { IconType } from "@lobehub/icons/es/types";
import { LINK_ICONS, LINK_ICON_URLS } from "@/lib/generated/link-icons";
import { colorForSeed, decideIconKind, initialOf } from "@/lib/provider-icon";
import { SimpleIconGlyph } from "./SimpleIconGlyph";

// service(小写)→ lobehub Mono 组件。keys 必须与 LOBEHUB_SERVICES 对齐。
const LOBEHUB_MAP: Record<string, IconType> = {
  openai: OpenAIMono, anthropic: AnthropicMono, cohere: CohereMono, perplexity: PerplexityMono,
};

interface ProviderIconProps {
  service: string;
  displayName?: string;
  iconUrl?: string;
  size?: number;
}

export function ProviderIcon({ service, displayName, iconUrl, size = 24 }: ProviderIconProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const resolvedIconUrl = iconUrl === failedSrc ? undefined : iconUrl;
  const communityUrl = LINK_ICON_URLS[service.toLowerCase()];
  const kind = decideIconKind(service, resolvedIconUrl);
  const glyphSize = size >= 36 ? 24 : Math.max(12, Math.round(size * 0.67));
  const frameStyle = { width: size, height: size };

  if (kind === "lobehub") {
    const Icon = LOBEHUB_MAP[service.toLowerCase()];
    if (Icon) {
      return (
        <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--lume-border-subtle)] bg-background shadow-xs" style={frameStyle}>
          <Icon size={glyphSize} />
        </span>
      );
    }
  }

  if (kind === "simpleIcon") {
    const icon = LINK_ICONS[service.toLowerCase()];
    if (icon) {
      return (
        <span
          className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--lume-border-subtle)] bg-background shadow-xs"
          style={{
            width: size,
            height: size,
            color: `color-mix(in oklab, #${icon.hex} 70%, var(--text-1))`,
          }}
        >
          <SimpleIconGlyph path={icon.path} size={glyphSize} />
        </span>
      );
    }
  }

  if (kind === "image" && resolvedIconUrl) {
    return <ImageIcon src={resolvedIconUrl} alt={displayName ?? service} size={size} glyphSize={glyphSize} onError={() => setFailedSrc(resolvedIconUrl)} />;
  }

  if (kind === "community" && communityUrl !== failedSrc) {
    return <ImageIcon src={communityUrl} alt={displayName ?? service} size={size} glyphSize={glyphSize} onError={() => setFailedSrc(communityUrl)} />;
  }

  return <LetterBlock size={size} seed={service} letter={initialOf(displayName || service)} />;
}

function LetterBlock({ size, seed, letter }: { size: number; seed: string; letter: string }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-md border border-[var(--lume-border-subtle)] font-semibold text-white shadow-xs"
      style={{ width: size, height: size, background: colorForSeed(seed), fontSize: size * 0.34 }}
    >
      {letter}
    </div>
  );
}

function ImageIcon({ src, alt, size, glyphSize, onError }: { src: string; alt: string; size: number; glyphSize: number; onError: () => void }) {
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--lume-border-subtle)] bg-background shadow-xs" style={{ width: size, height: size }}>
      <img
        src={src}
        alt={alt}
        width={glyphSize}
        height={glyphSize}
        className="object-contain"
        onError={onError}
      />
    </span>
  );
}
