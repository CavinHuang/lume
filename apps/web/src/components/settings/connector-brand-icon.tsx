import { CONNECTOR_BRAND_ICONS } from './connector-brand-paths'

/** 连接器服务的真实品牌图标;无数据的 service 回退为 null 由调用方处理。 */
export function ConnectorBrandIcon({ service, size = 16, className }: { service: string; size?: number; className?: string }) {
  const icon = CONNECTOR_BRAND_ICONS[service]
  if (!icon) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon.viewBox}
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  )
}
