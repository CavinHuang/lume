import React, { useEffect, useMemo, useRef, useState } from 'react';
import './lume-boot-screen.css';

export type LumeBootScene = 'awaken' | 'organize' | 'memory' | 'ready';

export interface LumeBootStep {
  key: LumeBootScene;
  status: string;
  title: string;
  subtitle: string;
  hint: string;
  duration: number;
}

export interface LumeBootScreenProps {
  logoSrc: string;
  /** Controlled scene. When omitted and autoPlay is true, the built-in sequence is used. */
  scene?: LumeBootScene;
  /** Optional controlled copy. Falls back to the built-in defaults for the current scene. */
  statusLabel?: string;
  title?: string;
  subtitle?: string;
  hint?: string;
  /** Enable the built-in startup sequence demo. */
  autoPlay?: boolean;
  /** Show the replay button for the built-in sequence. */
  showReplay?: boolean;
  /** Called after the built-in sequence reaches the last step. */
  onSequenceEnd?: () => void;
  /** Override the built-in sequence. */
  steps?: LumeBootStep[];
}

const DEFAULT_STEPS: LumeBootStep[] = [
  {
    key: 'awaken',
    status: '正在唤醒',
    title: '正在唤醒 Lume',
    subtitle: '像轻轻睁开眼睛一样，让启动更安静，也更有陪伴感。',
    hint: '启动页不需要“加载中”，而是让用户感到：Lume 已经在身边。',
    duration: 2600,
  },
  {
    key: 'organize',
    status: '正在整理',
    title: '正在整理你的工作现场',
    subtitle: '最近窗口、会话与工作上下文，正在被轻轻整理到位。',
    hint: '这是最符合 Lume 产品定位的一组动画语言。',
    duration: 3400,
  },
  {
    key: 'memory',
    status: '正在连接记忆',
    title: '正在连接记忆与当前窗口',
    subtitle: '历史记忆与此刻的桌面上下文，正在一点点重新连上。',
    hint: '恢复上下文的阶段，更适合作为启动中段。',
    duration: 3200,
  },
  {
    key: 'ready',
    status: '准备就绪',
    title: '准备好了',
    subtitle: '在进入主界面前，给用户一个很轻的“状态完成”确认。',
    hint: '建议真实产品中停留 300ms - 600ms 后进入主界面。',
    duration: 1900,
  },
];

const CONTROLLED_FALLBACKS: Record<LumeBootScene, Omit<LumeBootStep, 'duration'>> = {
  awaken: {
    key: 'awaken',
    status: '正在唤醒',
    title: '正在唤醒 Lume',
    subtitle: '像轻轻睁开眼睛一样，让启动更安静，也更有陪伴感。',
    hint: 'Lume 已经在身边，只是在安静地准备好当前状态。',
  },
  organize: {
    key: 'organize',
    status: '正在整理',
    title: '正在整理你的工作现场',
    subtitle: '最近窗口、会话与工作上下文，正在被轻轻整理到位。',
    hint: 'Lume 正在整理你当前的工作现场。',
  },
  memory: {
    key: 'memory',
    status: '正在连接记忆',
    title: '正在连接记忆与当前窗口',
    subtitle: '历史记忆与此刻的桌面上下文，正在一点点重新连上。',
    hint: 'Lume 正在恢复之前的上下文与记忆。',
  },
  ready: {
    key: 'ready',
    status: '准备就绪',
    title: '准备好了',
    subtitle: '你的桌面上下文已经整理好，可以进入主界面了。',
    hint: '适合在进入主界面前停留 300ms - 600ms。',
  },
};

export function LumeBootScreen({
  logoSrc,
  scene,
  statusLabel,
  title,
  subtitle,
  hint,
  autoPlay = true,
  showReplay = true,
  onSequenceEnd,
  steps = DEFAULT_STEPS,
}: LumeBootScreenProps) {
  const controlled = scene !== undefined || autoPlay === false;
  const [activeIndex, setActiveIndex] = useState(0);
  const [displayedStep, setDisplayedStep] = useState<LumeBootStep>(steps[0]);
  const [isFading, setIsFading] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const fadeRef = useRef<number | null>(null);

  const activeStep = useMemo(() => {
    if (controlled) {
      const key = scene ?? 'awaken';
      const fallback = CONTROLLED_FALLBACKS[key];
      return {
        key,
        status: statusLabel ?? fallback.status,
        title: title ?? fallback.title,
        subtitle: subtitle ?? fallback.subtitle,
        hint: hint ?? fallback.hint,
        duration: 0,
      } satisfies LumeBootStep;
    }

    return steps[activeIndex] ?? steps[0];
  }, [controlled, scene, statusLabel, title, subtitle, hint, steps, activeIndex]);

  useEffect(() => {
    setIsFading(true);
    if (fadeRef.current) window.clearTimeout(fadeRef.current);
    fadeRef.current = window.setTimeout(() => {
      setDisplayedStep(activeStep);
      setIsFading(false);
    }, 260);

    return () => {
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
    };
  }, [activeStep]);

  useEffect(() => {
    if (controlled) return;

    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setActiveIndex((prev) => {
        const next = (prev + 1) % steps.length;
        if (next === 0) onSequenceEnd?.();
        return next;
      });
    }, steps[activeIndex]?.duration ?? 2400);

    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, [controlled, activeIndex, steps, onSequenceEnd]);

  const handleReplay = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    setActiveIndex(0);
  };

  const phase = displayedStep.key;

  return (
    <div className="lume-boot-root" data-phase={phase}>
      <div className="lume-boot-screen">
        <div className={`lume-boot-status-chip ${isFading ? 'is-fading' : ''}`}>
          {displayedStep.status}
        </div>

        <div className="lume-boot-soft-halo" />

        <div className={`lume-boot-scene-layer lume-boot-scene-organize ${phase === 'organize' ? 'active' : ''}`}>
          <div className="lume-boot-card-node lume-boot-card-a" />
          <div className="lume-boot-card-node lume-boot-card-b" />
          <div className="lume-boot-card-node lume-boot-card-c" />
          <div className="lume-boot-card-node lume-boot-card-d" />
        </div>

        <div className={`lume-boot-scene-layer lume-boot-scene-memory ${phase === 'memory' ? 'active' : ''}`}>
          <div className="lume-boot-memory-ring r1" />
          <div className="lume-boot-memory-ring r2" />
          <div className="lume-boot-memory-ring r3" />
          <div className="lume-boot-memory-orb lume-boot-orb-1" />
          <div className="lume-boot-memory-orb lume-boot-orb-2" />
          <div className="lume-boot-memory-orb lume-boot-orb-3" />
          <div className="lume-boot-memory-orb lume-boot-orb-4" />
        </div>

        <div className={`lume-boot-scene-layer lume-boot-scene-ready ${phase === 'ready' ? 'active' : ''}`}>
          <div className="lume-boot-ready-ring r1" />
          <div className="lume-boot-ready-ring r2" />
          <div className="lume-boot-ready-ring r3" />
        </div>

        <div className="lume-boot-center-shell">
          <img className="lume-boot-logo" src={logoSrc} alt="Lume logo" />
        </div>

        <div className={`lume-boot-copy ${isFading ? 'is-fading' : ''}`}>
          <div className="lume-boot-title">{displayedStep.title}</div>
          <div className="lume-boot-subtitle">{displayedStep.subtitle}</div>
          <div className="lume-boot-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>

        <div className={`lume-boot-footer-hint ${isFading ? 'is-fading' : ''}`}>
          {displayedStep.hint}
        </div>

        <div className="lume-boot-stage-indicator" aria-hidden="true">
          {steps.map((step, index) => {
            const isActive = (!controlled && index === activeIndex) || (controlled && step.key === phase);
            return <span key={step.key + index} className={isActive ? 'active' : ''} />;
          })}
        </div>

        {!controlled && showReplay && (
          <button type="button" className="lume-boot-replay-button" onClick={handleReplay}>
            重播演示
          </button>
        )}
      </div>
    </div>
  );
}

export default LumeBootScreen;
