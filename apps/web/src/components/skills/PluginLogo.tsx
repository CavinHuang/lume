import { useState } from 'react'
import { Puzzle } from 'lucide-react'
import { cn } from '@/lib/utils'

export function PluginLogo({ src, alt, className }: { src?: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <Puzzle aria-label={alt} className={cn('text-[var(--text-3)]', className)} />
  return <img src={src} alt={alt} data-plugin-marketplace-icon="true" className={cn('object-contain', className)} onError={() => setFailed(true)} />
}
