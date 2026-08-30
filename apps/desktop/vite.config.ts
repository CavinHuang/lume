import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { GUEST_PRELOAD_SOURCE } from './src/browser/guest-preload'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const external = ['electron', /^node:/, ...builtinModules]

/**
 * guest preload 源码以字符串形态存在（src/browser/guest-preload.ts），构建期原样
 * 落盘为 webview will-attach 注入的 cjs 脚本。录制器渲染页逻辑内嵌于
 * createElectronBrowserWebmRecorder 的 recorderHtml()，其缺省 preload 路径
 * （dist/preload/browserVideoRecorder.cjs）以空脚本占位，避免 Electron 加载缺失
 * preload 时报错。
 */
const emitBrowserPreloads: Plugin = {
  name: 'lume-emit-browser-preloads',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'browser-guest-preload.cjs', source: GUEST_PRELOAD_SOURCE })
    this.emitFile({
      type: 'asset',
      fileName: 'browserVideoRecorder.cjs',
      source: '// 录制页逻辑内嵌于 recorderHtml()（browser/core/recording/recorder.ts）;此 preload 刻意留空。\n',
    })
  },
}

export const mainConfig = defineConfig({
  build: {
    target: 'node22',
    outDir: resolve(desktopRoot, 'dist', 'main'),
    emptyOutDir: true,
    minify: false,
    ssr: resolve(desktopRoot, 'src', 'main.ts'),
    rollupOptions: {
      external,
      output: {
        entryFileNames: 'main.mjs',
        format: 'es',
        inlineDynamicImports: true,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
})

export const preloadConfig = defineConfig({
  plugins: [react(), emitBrowserPreloads],
  build: {
    target: 'node22',
    outDir: resolve(desktopRoot, 'dist', 'preload'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: {
        preload: resolve(desktopRoot, 'src', 'preload.ts'),
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: {
      external,
    },
  },
})

export default mainConfig
