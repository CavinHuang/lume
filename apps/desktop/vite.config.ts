import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const external = ['electron', /^node:/, ...builtinModules]

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
  plugins: [react()],
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
