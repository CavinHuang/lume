import { useEffect, useMemo, useRef, useState } from 'react'
import type { GLViewer } from '3dmol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function RightPanelPdbPreview({ source }: { source: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<GLViewer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [model, setModel] = useState('*')
  const [chain, setChain] = useState('*')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const stats = useMemo(() => parsePdbStats(source), [source])
  const chainResidues = chain === '*' ? stats.residueEntries : stats.residueEntries.filter((residue) => residue.chain === chain)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let observer: ResizeObserver | null = null
    setLoading(true)
    setError(null)
    if (!supportsWebGL()) {
      setLoading(false)
      setError('当前图形环境不支持 WebGL。你仍可切换到源码模式查看 PDB。')
      return
    }
    void import('3dmol').then(($3Dmol) => {
      if (disposed) return
      const viewer = $3Dmol.createViewer(host, {
        backgroundColor: 'rgba(0,0,0,0)',
        antialias: true,
      })
      viewerRef.current = viewer
      if (stats.models > 1) viewer.addModels(source, 'pdb')
      else viewer.addModel(source, 'pdb')
      viewer.setStyle({}, {
        cartoon: { colorscheme: 'b' },
        stick: { radius: 0.12, colorscheme: 'Jmol' },
      })
      viewer.zoomTo()
      viewer.render()
      setLoading(false)
      observer = new ResizeObserver(() => viewer.resize())
      observer.observe(host)
    }).catch((reason) => {
      if (!disposed) {
        setLoading(false)
        setError(reason instanceof Error ? reason.message : 'PDB 预览初始化失败')
      }
    })
    return () => {
      disposed = true
      observer?.disconnect()
      viewerRef.current?.clear()
      viewerRef.current = null
    }
  }, [source, stats.models])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const selection = {
      ...(model === '*' ? {} : { model: Number(model) }),
      ...(chain === '*' ? {} : { chain }),
    }
    viewer.setStyle({}, {})
    viewer.setStyle(selection, {
      cartoon: { colorscheme: 'b' },
      stick: { radius: 0.12, colorscheme: 'Jmol' },
    })
    viewer.zoomTo(selection)
    viewer.render()
  }, [chain, model])

  if (error) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">无法加载 PDB 三维预览：{error}</div>
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[11px] text-foreground/55">
        <span>{stats.atoms} 原子</span>
        <span>{stats.residues} 残基</span>
        <span>{stats.models} 模型</span>
        {stats.models > 1 && (
          <Select value={model} onValueChange={(value) => setModel(value ?? '*')}>
            <SelectTrigger size="sm" className="ml-auto min-w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">全部模型</SelectItem>
              {Array.from({ length: stats.models }, (_, index) => (
                <SelectItem key={index} value={String(index)}>模型 {index + 1}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={chain} onValueChange={(value) => setChain(value ?? '*')}>
          <SelectTrigger size="sm" className={stats.models > 1 ? 'min-w-28' : 'ml-auto min-w-28'}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">全部链</SelectItem>
            {stats.chains.map((value) => <SelectItem key={value} value={value}>链 {value}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setModel('*')
            setChain('*')
            viewerRef.current?.zoomTo().render()
          }}
        >
          重置视图
        </Button>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/50 px-3">
        <span className="text-[10px] text-foreground/45">残基范围</span>
        <Input value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} placeholder="起始" className="h-6 w-16 px-2 text-[11px]" />
        <span className="text-foreground/30">–</span>
        <Input value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} placeholder="结束" className="h-6 w-16 px-2 text-[11px]" />
        <Button size="xs" variant="secondary" onClick={() => {
          const viewer = viewerRef.current
          const start = Number.parseInt(rangeStart, 10)
          const end = Number.parseInt(rangeEnd || rangeStart, 10)
          if (!viewer || !Number.isFinite(start) || !Number.isFinite(end)) return
          const residueSelection: number | `${number}-${number}` = start === end
            ? start
            : `${Math.min(start, end)}-${Math.max(start, end)}` as `${number}-${number}`
          const selection = {
            ...(model === '*' ? {} : { model: Number(model) }),
            ...(chain === '*' ? {} : { chain }),
            resi: residueSelection,
          }
          viewer.zoomTo(selection).render()
        }}>聚焦</Button>
        <span className="ml-2 min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/45" title={chainResidues.map((residue) => `${residue.name}${residue.number}`).join(' ')}>
          {chainResidues.map((residue) => residue.code).join('')}
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1" />
      {loading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[76px] flex items-center justify-center text-xs text-foreground/45">
          正在加载三维预览…
        </div>
      )}
    </div>
  )
}

export function supportsWebGL(): boolean {
  if (
    typeof document === 'undefined'
    || typeof window === 'undefined'
    || (!window.WebGLRenderingContext && !window.WebGL2RenderingContext)
  ) return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export function parsePdbStats(source: string): {
  atoms: number
  residues: number
  models: number
  chains: string[]
  residueEntries: Array<{ chain: string; number: number; name: string; code: string }>
} {
  let atoms = 0
  let models = 0
  const residues = new Set<string>()
  const chains = new Set<string>()
  const residueEntries = new Map<string, { chain: string; number: number; name: string; code: string }>()
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('MODEL ')) models += 1
    if (!line.startsWith('ATOM  ') && !line.startsWith('HETATM')) continue
    atoms += 1
    const chain = line.slice(21, 22).trim() || '_'
    const residue = line.slice(22, 27).trim()
    const residueNumber = Number.parseInt(residue, 10)
    const residueName = line.slice(17, 20).trim()
    chains.add(chain)
    residues.add(`${chain}:${residue}`)
    if (Number.isFinite(residueNumber) && !residueEntries.has(`${chain}:${residue}`)) {
      residueEntries.set(`${chain}:${residue}`, {
        chain,
        number: residueNumber,
        name: residueName,
        code: AMINO_ACID_CODES[residueName] ?? 'X',
      })
    }
  }
  return {
    atoms,
    residues: residues.size,
    models: Math.max(models, atoms > 0 ? 1 : 0),
    chains: [...chains].sort(),
    residueEntries: [...residueEntries.values()],
  }
}

const AMINO_ACID_CODES: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
  GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
  PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
}
