"use client"

import { Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export type SearchFieldProps = React.InputHTMLAttributes<HTMLInputElement>

export function SearchField({ className, ...props }: SearchFieldProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--lume-text-3)]" />
      <Input className="pl-8" {...props} />
    </div>
  )
}
