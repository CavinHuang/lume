/**
 * Built-in LSP registry.
 *
 * Server names, commands, file types and root markers are derived from the
 * Oh My Pi coding-agent registry (MIT):
 * Copyright 2025 Mario Zechner
 * Copyright 2025-2026 Can Bölük
 */

import { access, readdir } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export type LspServerRole = 'primary' | 'linter'

export interface LspRegistryServer {
  command: string
  args: string[]
  fileTypes: string[]
  rootMarkers: string[]
  initOptions?: Record<string, unknown>
  settings?: Record<string, unknown>
  role?: LspServerRole
  priority?: number
  warmupTimeoutMs?: number
  adapter?: 'swiftlint'
}

const server = (
  command: string,
  args: string[],
  fileTypes: string[],
  rootMarkers: string[],
  role: LspServerRole = 'primary',
): LspRegistryServer => ({ command, args, fileTypes, rootMarkers, initOptions: {}, settings: {}, role })

export const DEFAULT_LSP_SERVERS: Readonly<Record<string, LspRegistryServer>> = {
  'rust-analyzer': {
    ...server('rust-analyzer', [], ['.rs'], ['Cargo.toml', 'rust-analyzer.toml']),
    settings: { 'rust-analyzer': { checkOnSave: false } },
  },
  tlaplus: server('tlapm_lsp', ['--stdio'], ['.tla', '.tlaplus'], ['*.tla']),
  clangd: server('clangd', ['--background-index', '--clang-tidy', '--header-insertion=iwyu'], ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.m', '.mm'], ['compile_commands.json', 'CMakeLists.txt', '.clangd', '.clang-format', 'Makefile']),
  zls: server('zls', [], ['.zig'], ['build.zig', 'build.zig.zon', 'zls.json']),
  gopls: {
    ...server('gopls', ['serve'], ['.go', '.mod', '.sum'], ['go.mod', 'go.work', 'go.sum']),
    settings: { gopls: { analyses: { unusedparams: true, shadow: true }, staticcheck: true, gofumpt: true } },
  },
  'typescript-language-server': {
    ...server('typescript-language-server', ['--stdio'], ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], ['package.json', 'tsconfig.json', 'jsconfig.json']),
    initOptions: {
      hostInfo: 'lume',
      preferences: {
        includeInlayParameterNameHints: 'all',
        includeInlayVariableTypeHints: true,
        includeInlayFunctionParameterTypeHints: true,
      },
    },
  },
  biome: server('biome', ['lsp-proxy'], ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc'], ['biome.json', 'biome.jsonc'], 'linter'),
  eslint: {
    ...server('vscode-eslint-language-server', ['--stdio'], ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'], ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'], 'linter'),
    settings: { validate: 'on', run: 'onType' },
  },
  denols: {
    ...server('deno', ['lsp'], ['.ts', '.tsx', '.js', '.jsx'], ['deno.json', 'deno.jsonc', 'deno.lock']),
    initOptions: { enable: true, lint: true, unstable: true },
  },
  'vscode-html-language-server': {
    ...server('vscode-html-language-server', ['--stdio'], ['.html', '.htm'], ['package.json', '.git']),
    initOptions: { provideFormatter: true },
  },
  'vscode-css-language-server': {
    ...server('vscode-css-language-server', ['--stdio'], ['.css', '.scss', '.sass', '.less'], ['package.json', '.git']),
    initOptions: { provideFormatter: true },
  },
  'vscode-json-language-server': {
    ...server('vscode-json-language-server', ['--stdio'], ['.json', '.jsonc'], ['package.json', '.git']),
    initOptions: { provideFormatter: true },
  },
  tailwindcss: server('tailwindcss-language-server', ['--stdio'], ['.html', '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'], ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs', 'tailwind.config.cjs']),
  svelte: server('svelteserver', ['--stdio'], ['.svelte'], ['svelte.config.js', 'svelte.config.mjs', 'package.json']),
  'vue-language-server': server('vue-language-server', ['--stdio'], ['.vue'], ['vue.config.js', 'nuxt.config.js', 'nuxt.config.ts', 'package.json']),
  astro: server('astro-ls', ['--stdio'], ['.astro'], ['astro.config.mjs', 'astro.config.js', 'astro.config.ts']),
  pyright: {
    ...server('pyright-langserver', ['--stdio'], ['.py', '.pyi'], ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']),
    settings: { python: { analysis: { autoSearchPaths: true, diagnosticMode: 'openFilesOnly', useLibraryCodeForTypes: true } } },
  },
  basedpyright: {
    ...server('basedpyright-langserver', ['--stdio'], ['.py', '.pyi'], ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'requirements.txt']),
    settings: { basedpyright: { analysis: { autoSearchPaths: true, diagnosticMode: 'openFilesOnly', useLibraryCodeForTypes: true } } },
  },
  pylsp: server('pylsp', [], ['.py'], ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']),
  ruff: server('ruff', ['server'], ['.py', '.pyi'], ['pyproject.toml', 'ruff.toml', '.ruff.toml'], 'linter'),
  jdtls: server('jdtls', [], ['.java'], ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', '.project']),
  'kotlin-lsp': server('kotlin-lsp', ['--stdio'], ['.kt', '.kts'], ['build.gradle', 'build.gradle.kts', 'pom.xml', 'settings.gradle', 'settings.gradle.kts']),
  metals: {
    ...server('metals', [], ['.scala', '.sbt', '.sc'], ['build.sbt', 'build.sc', 'build.gradle', 'pom.xml']),
    initOptions: { statusBarProvider: 'show-message', isHttpEnabled: true },
  },
  hls: {
    ...server('haskell-language-server-wrapper', ['--lsp'], ['.hs', '.lhs'], ['stack.yaml', 'cabal.project', 'hie.yaml', 'package.yaml', '*.cabal']),
    settings: { haskell: { formattingProvider: 'ormolu', checkProject: true } },
  },
  ocamllsp: server('ocamllsp', [], ['.ml', '.mli', '.mll', '.mly'], ['dune-project', 'dune-workspace', '*.opam', '.ocamlformat']),
  elixirls: {
    ...server('elixir-ls', [], ['.ex', '.exs', '.heex', '.eex'], ['mix.exs', 'mix.lock']),
    settings: { elixirLS: { dialyzerEnabled: true, fetchDeps: false } },
  },
  expert: server('expert', ['--stdio'], ['.ex', '.exs', '.heex', '.eex'], ['mix.exs', 'mix.lock']),
  erlangls: server('erlang_ls', [], ['.erl', '.hrl'], ['rebar.config', 'erlang.mk', 'rebar.lock']),
  gleam: server('gleam', ['lsp'], ['.gleam'], ['gleam.toml']),
  solargraph: {
    ...server('solargraph', ['stdio'], ['.rb', '.rake', '.gemspec'], ['Gemfile', '.solargraph.yml', 'Rakefile']),
    initOptions: { formatting: true },
    settings: { solargraph: { diagnostics: true, completion: true, hover: true, formatting: true, references: true, rename: true, symbols: true } },
  },
  'ruby-lsp': {
    ...server('ruby-lsp', [], ['.rb', '.rake', '.gemspec', '.erb'], ['Gemfile', '.ruby-version', '.ruby-gemset']),
    initOptions: { formatter: 'auto' },
  },
  rubocop: server('rubocop', ['--lsp'], ['.rb', '.rake'], ['.rubocop.yml', 'Gemfile'], 'linter'),
  bashls: {
    ...server('bash-language-server', ['start'], ['.sh', '.bash', '.zsh'], ['.git']),
    settings: { bashIde: { globPattern: '*@(.sh|.inc|.bash|.command)' } },
  },
  'lua-language-server': {
    ...server('lua-language-server', [], ['.lua'], ['.luarc.json', '.luarc.jsonc', '.luacheckrc', '.stylua.toml', 'stylua.toml']),
    settings: { Lua: { runtime: { version: 'LuaJIT' }, diagnostics: { globals: ['vim'] }, workspace: { checkThirdParty: false }, telemetry: { enable: false } } },
  },
  intelephense: server('intelephense', ['--stdio'], ['.php', '.phtml'], ['composer.json', 'composer.lock', '.git']),
  phpactor: server('phpactor', ['language-server'], ['.php'], ['composer.json', '.phpactor.json', '.phpactor.yml']),
  omnisharp: {
    ...server('omnisharp', ['-z', '--hostPID', String(process.pid), '--encoding', 'utf-8', '--languageserver'], ['.cs', '.csx'], ['*.sln', '*.csproj', 'omnisharp.json', '.git']),
    settings: { FormattingOptions: { EnableEditorConfigSupport: true }, RoslynExtensionsOptions: { EnableAnalyzersSupport: true } },
  },
  yamlls: {
    ...server('yaml-language-server', ['--stdio'], ['.yaml', '.yml'], ['.git']),
    settings: { yaml: { validate: true, format: { enable: true }, hover: true, completion: true }, redhat: { telemetry: { enabled: false } } },
  },
  terraformls: server('terraform-ls', ['serve'], ['.tf', '.tfvars'], ['.terraform', 'terraform.tfstate', '*.tf']),
  dockerls: server('docker-langserver', ['--stdio'], ['.dockerfile', 'Dockerfile'], ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore']),
  'helm-ls': server('helm_ls', ['serve'], ['.yaml', '.yml', '.tpl'], ['Chart.yaml', 'Chart.yml']),
  nixd: server('nixd', [], ['.nix'], ['flake.nix', 'default.nix', 'shell.nix']),
  nil: server('nil', [], ['.nix'], ['flake.nix', 'default.nix', 'shell.nix']),
  ols: server('ols', [], ['.odin'], ['ols.json', '.git']),
  dartls: {
    ...server('dart', ['language-server', '--protocol=lsp'], ['.dart'], ['pubspec.yaml', 'pubspec.lock']),
    initOptions: { closingLabels: true, flutterOutline: true, outline: true },
  },
  marksman: {
    ...server('marksman', ['server'], ['.md', '.markdown'], ['.marksman.toml', '.git']),
    warmupTimeoutMs: 2_000,
  },
  texlab: {
    ...server('texlab', [], ['.tex', '.bib', '.sty', '.cls'], ['.latexmkrc', 'latexmkrc', '.texlabroot', 'texlabroot', 'Tectonic.toml']),
    settings: { texlab: { build: { executable: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', '-synctex=1', '%f'] }, chktex: { onOpenAndSave: true } } },
  },
  graphql: server('graphql-lsp', ['server', '-m', 'stream'], ['.graphql', '.gql'], ['.graphqlrc', '.graphqlrc.json', '.graphqlrc.yml', '.graphqlrc.yaml', 'graphql.config.js']),
  prismals: server('prisma-language-server', ['--stdio'], ['.prisma'], ['schema.prisma', 'prisma/schema.prisma']),
  vimls: {
    ...server('vim-language-server', ['--stdio'], ['.vim', '.vimrc'], ['.git']),
    initOptions: { isNeovim: true, diagnostic: { enable: true } },
  },
  'emmet-language-server': server('emmet-language-server', ['--stdio'], ['.html', '.css', '.scss', '.less', '.jsx', '.tsx', '.vue', '.svelte'], ['.git']),
  'sourcekit-lsp': server('sourcekit-lsp', [], ['.swift'], ['Package.swift', '*.xcodeproj', '*.xcworkspace', 'project.yml', '.swiftpm']),
  swiftlint: {
    ...server('swiftlint', ['lint', '--quiet', '--reporter', 'json'], ['.swift'], ['.swiftlint.yml', '.swiftlint.yaml', 'Package.swift', '*.xcodeproj'], 'linter'),
    adapter: 'swiftlint',
  },
}

export function supportsLspFile(serverConfig: Pick<LspRegistryServer, 'fileTypes'>, filePath: string): boolean {
  if (serverConfig.fileTypes.length === 0) return true
  const lower = filePath.toLowerCase()
  const extension = extname(lower)
  const name = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1)
  return serverConfig.fileTypes.some((fileType) => {
    const normalized = fileType.toLowerCase()
    return normalized === extension || normalized === name || normalized.replace(/^\./, '') === extension.slice(1)
  })
}

export async function findLspWorkspaceRoot(cwd: string, filePath: string | undefined, markers: string[]): Promise<string | undefined> {
  if (markers.length === 0) return resolve(cwd)
  let directory = filePath ? dirname(resolve(filePath)) : resolve(cwd)
  const boundary = resolve(cwd)
  while (true) {
    if (await directoryHasMarker(directory, markers)) return directory
    const parent = dirname(directory)
    if (parent === directory || (directory === boundary && !filePath)) return undefined
    directory = parent
  }
}

export async function resolveLspExecutable(command: string, workspaceRoot: string, configuredCwd?: string): Promise<string | undefined> {
  const cwd = resolve(configuredCwd ?? workspaceRoot)
  if (isAbsolute(command)) return await executableFile(command)
  const localCandidates = [
    join(cwd, command),
    join(workspaceRoot, 'node_modules', '.bin', command),
    join(workspaceRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', command),
  ]
  for (const candidate of localCandidates) {
    const executable = await executableFile(candidate)
    if (executable) return executable
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const executable = await executableFile(join(directory, command))
    if (executable) return executable
  }
  return undefined
}

async function executableFile(candidate: string): Promise<string | undefined> {
  const extensions = process.platform === 'win32'
    ? [...windowsExecutableExtensions(), '']
    : ['']
  for (const extension of extensions) {
    const path = candidate.toLowerCase().endsWith(extension) ? candidate : `${candidate}${extension}`
    try {
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return resolve(path)
    } catch {
      // Try the next executable shim.
    }
  }
  return undefined
}

// Only .exe/.com binaries are directly spawnable on Windows; .cmd/.bat shims
// need the cmd.exe wrapper from the client, and the extensionless
// node_modules/.bin shell scripts cannot run at all, so probe last.
function windowsExecutableExtensions(): string[] {
  const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.toLowerCase())
    .filter(Boolean)
  const rank = (extension: string): number =>
    extension === '.exe' || extension === '.com' ? 0
      : extension === '.cmd' || extension === '.bat' ? 1
      : 2
  return pathext.sort((left, right) => rank(left) - rank(right))
}

async function directoryHasMarker(directory: string, markers: string[]): Promise<boolean> {
  const exact = markers.filter((marker) => !marker.includes('*'))
  if (exact.some((marker) => existsSync(join(directory, marker)))) return true
  const globs = markers.filter((marker) => marker.includes('*'))
  if (globs.length === 0) return false
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return false
  }
  return globs.some((marker) => {
    const expression = new RegExp(`^${marker.split('*').map(escapeRegExp).join('.*')}$`, 'i')
    return entries.some((entry) => expression.test(entry))
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
