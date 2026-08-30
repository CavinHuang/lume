import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { mainConfig, preloadConfig } from '../vite.config'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(resolve(desktopRoot, 'dist'), { recursive: true, force: true })

await build({ ...mainConfig, configFile: false })
await build({ ...preloadConfig, configFile: false })

// 打包守卫:injected-loader 在运行时经 createRequire 从 main.mjs 位置解析
// playwright-core/lib/generated/injectedScriptSource.js。这里用同款解析提前失败,
// 避免缺依赖/版本漂移只在打包后的浏览器工具里暴露(1.60+ 已移除该生成文件)。
const requireFromMain = createRequire(resolve(desktopRoot, 'dist', 'main', 'main.mjs'))
const playwrightCoreDir = dirname(requireFromMain.resolve('playwright-core/package.json'))
if (!existsSync(join(playwrightCoreDir, 'lib', 'generated', 'injectedScriptSource.js'))) {
  throw new Error(
    `playwright-core is missing lib/generated/injectedScriptSource.js at ${playwrightCoreDir} `
    + '(injected-loader resolves it at runtime; pin playwright-core < 1.60)',
  )
}
