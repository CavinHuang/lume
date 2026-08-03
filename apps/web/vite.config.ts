import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFile } from 'node:fs/promises'

const THREEDMOL_STRING_CALLBACK = `    if (callback && typeof callback === "string") {
        /* jshint ignore:start */
        callback = eval("(" + callback + ")");
        /* jshint ignore:end */
    }`
const THREEDMOL_DISABLED_STRING_CALLBACK = `    if (callback && typeof callback === "string") {
        console.warn("3Dmol string callbacks are disabled in Lume.");
        return () => { };
    }`

function strip3DmolStringCallbacks(code: string): string {
  if (!code.includes(THREEDMOL_STRING_CALLBACK)) {
    throw new Error('3dmol string callback implementation changed; refusing to ship an unreviewed eval path')
  }
  return code.replace(THREEDMOL_STRING_CALLBACK, THREEDMOL_DISABLED_STRING_CALLBACK)
}

function disable3DmolStringCallbacks(): Plugin {
  return {
    name: 'lume-disable-3dmol-string-callbacks',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/3dmol/build/3Dmol.js')) return
      return strip3DmolStringCallbacks(code)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), disable3DmolStringCallbacks()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [{
        name: 'lume-disable-3dmol-string-callbacks',
        setup(build) {
          build.onLoad({ filter: /[\\/]3dmol[\\/]build[\\/]3Dmol\.js$/ }, async ({ path: filePath }) => ({
            contents: strip3DmolStringCallbacks(await readFile(filePath, 'utf8')),
            loader: 'js',
          }))
        },
      }],
    },
  },
  server: { port: 3000, strictPort: true },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          return id.replace(/\\/g, '/').includes('/3dmol/') ? 'pdb-viewer' : undefined
        },
      },
    },
  },
})
