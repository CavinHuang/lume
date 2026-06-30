import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { mainConfig, preloadConfig } from '../vite.config'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(resolve(desktopRoot, 'dist'), { recursive: true, force: true })

await build({ ...mainConfig, configFile: false })
await build({ ...preloadConfig, configFile: false })
