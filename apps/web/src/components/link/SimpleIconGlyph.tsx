// 渲染 simple-icons 的 SVG path（brand 单色路径，默认跟随 currentColor）
export function SimpleIconGlyph({ path, size }: { path: string; size: number }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="shrink-0"
      style={{ fill: "currentColor" }}
    >
      <path d={path} />
    </svg>
  );
}
