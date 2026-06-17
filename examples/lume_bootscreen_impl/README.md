# Lume 启动页实现

这个目录包含一份可以直接预览的启动页实现，以及一份可集成到 React / Tauri 项目中的组件版本。

## 文件说明

- `boot-screen-preview.html`：独立预览版，直接打开即可查看启动动画。
- `assets/lume-mascot-transparent.png`：从你提供的参考图里提取出的透明背景 Logo / IP 形象。
- `react/LumeBootScreen.tsx`：React 组件版本。
- `react/lume-boot-screen.css`：组件样式。
- `react/index.ts`：导出文件。

## 预览版

直接打开：

```text
boot-screen-preview.html
```

## React 集成

```tsx
import LumeBootScreen from './react/LumeBootScreen';
import './react/lume-boot-screen.css';
import logoSrc from './assets/lume-mascot-transparent.png';

export default function App() {
  return <LumeBootScreen logoSrc={logoSrc} />;
}
```

上面这段会播放完整的推荐启动序列：

```text
苏醒呼吸 → 整理现场 → 连接记忆 → 准备就绪
```

## 受控模式

如果你已经有真实的启动状态，可以自己控制场景和文案：

```tsx
import LumeBootScreen, { type LumeBootScene } from './react/LumeBootScreen';
import './react/lume-boot-screen.css';
import logoSrc from './assets/lume-mascot-transparent.png';

const scene: LumeBootScene = 'organize';

export default function App() {
  return (
    <LumeBootScreen
      autoPlay={false}
      logoSrc={logoSrc}
      scene={scene}
      statusLabel="正在整理"
      title="正在整理你的工作现场"
      subtitle="最近窗口、会话与工作上下文，正在被轻轻整理到位。"
      hint="首次启动或本地数据较多时，可能需要多等几秒。"
    />
  );
}
```

## 建议的状态映射

```ts
const bootSceneMap = {
  starting: 'awaken',
  'loading-local-data': 'organize',
  'loading-memory': 'memory',
  'restoring-context': 'organize',
  ready: 'ready',
} as const;
```

## 说明

- 当前实现使用透明背景 Logo。
- 没有进度条，没有 spinner。
- 过渡采用交叠式淡入淡出，更适合 Lume 的温和气质。
