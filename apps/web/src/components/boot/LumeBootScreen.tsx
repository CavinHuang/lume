import { useEffect } from 'react'
import { BOOT_HINT, BOOT_TIMINGS, PHASE_COPY, type LumeBootPhase } from './boot-phase'
import { useBootScreen } from './useBootScreen'
import './lume-boot-screen.css'

export interface LumeBootScreenProps {
  logoSrc: string
  ready: boolean
  /** 受控阶段覆盖（未来真实启动阶段接入点）。 */
  scene?: LumeBootPhase
  onExited?: () => void
}

const STAGES: readonly LumeBootPhase[] = ['awaken', 'organize', 'memory', 'ready'] as const

export function LumeBootScreen({ logoSrc, ready, scene, onExited }: LumeBootScreenProps) {
  const { phase, fading, showHint } = useBootScreen({ ready, scene, onExited })
  const copy = PHASE_COPY[phase]

  // 从 index.html 静态层无缝交接：React 已绘制同款「唤醒」帧后移除静态层。
  useEffect(() => {
    const el = document.getElementById('boot-root')
    if (el) el.remove()
  }, [])

  return (
    <div
      className={`lume-boot-root${fading ? ' is-fading' : ''}`}
      data-phase={phase}
      style={{ ['--lb-fade' as string]: `${BOOT_TIMINGS.fadeMs}ms` }}
    >
      <div className="lume-boot-screen">
        <div className="lume-boot-status-chip">{copy.status}</div>
        <div className="lume-boot-soft-halo" />

        <div
          className={`lume-boot-scene-layer lume-boot-scene-organize${
            phase === 'organize' ? ' active' : ''
          }`}
        >
          <div className="lume-boot-card-node lume-boot-card-a" />
          <div className="lume-boot-card-node lume-boot-card-b" />
          <div className="lume-boot-card-node lume-boot-card-c" />
          <div className="lume-boot-card-node lume-boot-card-d" />
        </div>

        <div
          className={`lume-boot-scene-layer lume-boot-scene-memory${
            phase === 'memory' ? ' active' : ''
          }`}
        >
          <div className="lume-boot-memory-ring r1" />
          <div className="lume-boot-memory-ring r2" />
          <div className="lume-boot-memory-ring r3" />
          <div className="lume-boot-memory-orb lume-boot-orb-1" />
          <div className="lume-boot-memory-orb lume-boot-orb-2" />
          <div className="lume-boot-memory-orb lume-boot-orb-3" />
          <div className="lume-boot-memory-orb lume-boot-orb-4" />
        </div>

        <div
          className={`lume-boot-scene-layer lume-boot-scene-ready${
            phase === 'ready' ? ' active' : ''
          }`}
        >
          <div className="lume-boot-ready-ring r1" />
          <div className="lume-boot-ready-ring r2" />
          <div className="lume-boot-ready-ring r3" />
        </div>

        <div className="lume-boot-center-shell">
          <img className="lume-boot-logo" src={logoSrc} alt="Lume logo" />
        </div>

        <div className="lume-boot-copy" key={phase}>
          <div className="lume-boot-title">{copy.title}</div>
          <div className="lume-boot-subtitle">{copy.subtitle}</div>
          <div className="lume-boot-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>

        {showHint && <div className="lume-boot-footer-hint">{BOOT_HINT}</div>}

        <div className="lume-boot-stage-indicator" aria-hidden="true">
          {STAGES.map((p) => (
            <span key={p} className={phase === p ? 'active' : ''} />
          ))}
        </div>
      </div>
    </div>
  )
}

export default LumeBootScreen
