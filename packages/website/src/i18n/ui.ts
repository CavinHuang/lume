export const languages = {
  zh: '中文',
  en: 'English',
} as const;

export type Lang = keyof typeof languages;

export const ui = {
  zh: {
    'nav.features': '功能',
    'nav.team': '团队',
    'nav.docs': '文档',
    'nav.changelog': '更新日志',
    'nav.download': '下载',
    'nav.github': 'GitHub',

    'hero.badge': 'v0.3.0 · 开源 MIT',
    'hero.title': '本地优先的 AI 工作台',
    'hero.subtitle': '有记忆、有主见、能动手。你的数据在你手上，你的助手为你工作。',
    'hero.ctaDownload': '下载 Lume',
    'hero.ctaGithub': 'GitHub',
    'hero.screenshotAlt': 'Lume 主界面截图',
    'hero.meta': 'Windows · macOS · 免费 · 开源 MIT',
    'hero.teamHint': '你的 AI 团队，整装待发',

    'team.title': '一支有性格的 AI 团队',
    'team.desc':
      '14 位角色各有所长。主线程理解任务后，把工作分发给最合适的人——他们不是模板，每个人都有自己的名字、语气和做事方式。',
    'team.photoAlt': 'Lume 角色团队合影',
    'team.explorer.role': '探索员',
    'team.explorer.desc': '代码库探索、文件检索、上下文收集和结构梳理。',
    'team.planner.role': '规划师',
    'team.planner.desc': '只读实现规划、架构权衡、关键文件识别和执行步骤设计。',
    'team.code-reviewer.role': '代码审查员',
    'team.code-reviewer.desc': '代码审查、回归风险识别、边界条件检查和实现质量复核。',
    'team.researcher.role': '调研员',
    'team.researcher.desc': '搜索、调研、事实核查和本地资料梳理。',
    'team.translator.role': '翻译官',
    'team.translator.desc': '多语言翻译、本地化和语境校准。',
    'team.writer.role': '作家',
    'team.writer.desc': '长文写作、品牌文案、文章结构和报告表达。',
    'team.voice.role': '配音师',
    'team.voice.desc': 'TTS 脚本、播客文案、朗读节奏和口播改写。',
    'team.designer.role': '设计工程师',
    'team.designer.desc': '前端设计、页面实现、可视化、PPT/Word 版式和交互原型。',
    'team.artist.role': '画师',
    'team.artist.desc': 'AI 图像生成、插画方向、视觉概念和提示词工程。',
    'team.analyst.role': '分析师',
    'team.analyst.desc': '数据分析、统计建模、表格处理和图表解释。',
    'team.quant.role': '量化交易分析师',
    'team.quant.desc': '市场数据、技术指标、量化策略和金融资讯分析。',
    'team.novelist.role': '小说家',
    'team.novelist.desc': '长篇小说、世界观、大纲、章节续写和伏笔管理。',
    'team.developer.role': '开发者',
    'team.developer.desc': '全栈开发、脚本自动化、调试、重构和代码审查。',

    'models.title': '接你想用的模型',
    'models.desc': '通过 OpenAI 兼容接口接入主流大模型，还能按任务给不同角色分配不同模型。',

    'why.title': '为什么是 Lume',
    'why.para1':
      '多数 AI 产品是一扇转门：打开浏览器，登录，对话，关闭——下次回来一切从零。它不记得你昨天在做什么，碰不到你的文件系统，更不会在你睡觉时推进任何事。',
    'why.para2':
      'Lume 运行在你自己的电脑上。记忆、对话、项目上下文、技能配置，全部是 ~/.lume/ 下可直接读写的本地文件；配合完整工具集和有性格的角色团队，它能真正参与你的工作流，而不是旁观。',

    'features.title': '核心特性',
    'features.local.title': '本地优先',
    'features.local.desc': '所有数据存在 ~/.lume/，Markdown 是真源——可读、可 grep、可备份、可迁移。',
    'features.memory.title': '持久记忆',
    'features.memory.desc': '三层作用域 × 六种类型，新对话中自然召回；矛盾记忆并存，取舍由你。',
    'features.personas.title': '角色团队',
    'features.personas.desc': '14 位有独立风格与专长的角色，主线程理解任务后分发给最合适的人。',
    'features.skills.title': 'Skills 与 MCP',
    'features.skills.desc': 'SKILL.md 热加载的技能体系 + 标准 MCP 客户端，能力无限扩展。',
    'features.tools.title': '完整工具集',
    'features.tools.desc': '文件系统、Bash、Office 文档、Web 搜索与抓取、图片生成。',
    'features.automation.title': '自动化',
    'features.automation.desc': 'cron 定时任务与每日日程，到点自动执行并把结果推送到指定渠道。',
    'features.im.title': 'IM 渠道',
    'features.im.desc': '微信、飞书、钉钉、企业微信接入，消息自动绑定工作区线程。',
    'features.models.title': '多模型',
    'features.models.desc': 'OpenAI 兼容接口接入主流模型，可按任务分配不同模型。',

    'sdk.title': 'Agent SDK',
    'sdk.desc': 'Agent 引擎以独立 SDK 提供：完整的 Agent 循环全在进程内完成，无本地 CLI 依赖，可部署到云端、Serverless、Docker、CI/CD。',

    'cta.title': '现在就开始',
    'cta.desc': '免费、开源，几分钟内跑起来。',
    'cta.button': '下载 Lume',

    'download.title': '下载 Lume',
    'download.desc': '最新版本 v0.3.0 · 支持 Windows 与 macOS',
    'download.windows': 'Windows',
    'download.windowsDesc': 'Windows 10/11 · x64 安装程序',
    'download.macos': 'macOS',
    'download.macAppleSilicon': 'Apple Silicon',
    'download.macIntel': 'Intel 芯片',
    'download.linux': 'Linux',
    'download.linuxSoon': '安装包制作中，可前往 Releases 关注进展。',
    'download.installTitle': '安装说明',
    'download.windowsInstall': '运行 .exe 按向导完成安装；首次启动如遇 SmartScreen 提示，选择「仍要运行」。',
    'download.macInstall': '打开 .dmg，将 Lume 拖入「应用程序」文件夹；未签名版本首次打开需在系统设置中允许。',
    'download.allReleases': '查看全部历史版本 →',
    'download.versionLabel': '当前版本',

    'changelog.title': '更新日志',
    'changelog.desc': '每个版本的改进与新能力，同步自 GitHub Releases。',

    'docs.title': '使用文档',
    'docs.desc': '从安装到进阶，了解 Lume 的全部能力。',
    'docs.index': '文档目录',
    'docs.backToDocs': '返回文档目录',

    'footer.tagline': '本地优先的 AI 工作台 — 有记忆、有主见、能动手。',
    'footer.product': '产品',
    'footer.community': '社区',
    'footer.license': 'MIT License',
    'footer.copyright': '© 2026 CavinHuang · Lume Contributors',

    'theme.toLight': '切换到亮色模式',
    'theme.toDark': '切换到暗色模式',
    'lang.switch': '切换语言',
  },
  en: {
    'nav.features': 'Features',
    'nav.team': 'Team',
    'nav.docs': 'Docs',
    'nav.changelog': 'Changelog',
    'nav.download': 'Download',
    'nav.github': 'GitHub',

    'hero.badge': 'v0.3.0 · Open Source (MIT)',
    'hero.title': 'The Local-First AI Workbench',
    'hero.subtitle': 'It remembers, it has opinions, it gets things done. Your data stays in your hands; your assistant works for you.',
    'hero.ctaDownload': 'Download Lume',
    'hero.ctaGithub': 'GitHub',
    'hero.screenshotAlt': 'Lume app screenshot',
    'hero.meta': 'Windows · macOS · Free · Open source (MIT)',
    'hero.teamHint': 'Your AI team, ready to go',

    'team.title': 'A Team with Personality',
    'team.desc':
      'Fourteen specialists, each with a name, a voice and their own way of working. The main thread understands the task first, then hands it to the best fit — they are not templates.',
    'team.photoAlt': 'The Lume agent team',
    'team.explorer.role': 'Explorer',
    'team.explorer.desc': 'Codebase exploration, file lookup, context gathering and structure mapping.',
    'team.planner.role': 'Planner',
    'team.planner.desc': 'Read-only implementation planning, architecture trade-offs, key-file identification and step design.',
    'team.code-reviewer.role': 'Code Reviewer',
    'team.code-reviewer.desc': 'Code review, regression risk, boundary conditions and implementation quality.',
    'team.researcher.role': 'Researcher',
    'team.researcher.desc': 'Web search, investigation, fact-checking and local material analysis.',
    'team.translator.role': 'Translator',
    'team.translator.desc': 'Multilingual translation, localization and tone calibration.',
    'team.writer.role': 'Writer',
    'team.writer.desc': 'Long-form writing, brand copy, article structure and report expression.',
    'team.voice.role': 'Voice Artist',
    'team.voice.desc': 'TTS scripts, podcast copy, reading rhythm and spoken-word rewrites.',
    'team.designer.role': 'Design Engineer',
    'team.designer.desc': 'Frontend design, page implementation, visualization, PPT/Word layout and prototypes.',
    'team.artist.role': 'Illustrator',
    'team.artist.desc': 'AI image generation, illustration direction, visual concepts and prompt engineering.',
    'team.analyst.role': 'Data Analyst',
    'team.analyst.desc': 'Data analysis, statistical modeling, spreadsheet processing and chart interpretation.',
    'team.quant.role': 'Quant Analyst',
    'team.quant.desc': 'Market data, technical indicators, quant strategies and financial news analysis.',
    'team.novelist.role': 'Novelist',
    'team.novelist.desc': 'Long fiction, worldbuilding, outlines, chapter continuation and foreshadowing.',
    'team.developer.role': 'Developer',
    'team.developer.desc': 'Full-stack development, scripting, debugging, refactoring and code review.',

    'models.title': 'Bring Your Own Model',
    'models.desc': 'Connect mainstream models through an OpenAI-compatible API — and assign different models to different tasks.',

    'why.title': 'Why Lume',
    'why.para1':
      'Most AI products are a revolving door: open a browser tab, sign in, chat, close — next time you are back to zero. It forgets what you did yesterday, cannot touch your file system, and never moves anything forward while you sleep.',
    'why.para2':
      'Lume runs on your own computer. Memories, conversations, project context and skill configs all live as plain local files under ~/.lume/. With a complete toolset and a team of opinionated personas, it takes part in your workflow instead of watching from the sidelines.',

    'features.title': 'Core Features',
    'features.local.title': 'Local First',
    'features.local.desc': 'Everything lives under ~/.lume/. Markdown is the source of truth — readable, greppable, backup-able, portable.',
    'features.memory.title': 'Persistent Memory',
    'features.memory.desc': 'Three scopes × six types, recalled naturally in new conversations; contradictions coexist — you decide.',
    'features.personas.title': 'Persona Team',
    'features.personas.desc': '14 characters with distinct styles and specialties; the main thread routes each task to the best fit.',
    'features.skills.title': 'Skills & MCP',
    'features.skills.desc': 'Hot-reloading SKILL.md skill system plus a standard MCP client — extend it endlessly.',
    'features.tools.title': 'Full Toolset',
    'features.tools.desc': 'File system, Bash, Office documents, web search & fetch, image generation.',
    'features.automation.title': 'Automation',
    'features.automation.desc': 'Cron jobs and daily schedules run on time and push results to your channels.',
    'features.im.title': 'IM Channels',
    'features.im.desc': 'WeChat, Feishu, DingTalk and WeCom integration; messages bind to workspace threads automatically.',
    'features.models.title': 'Any Model',
    'features.models.desc': 'Bring mainstream models through an OpenAI-compatible API and assign different models per task.',

    'sdk.title': 'Agent SDK',
    'sdk.desc': 'The agent engine ships as a standalone SDK: the full agent loop runs in-process with no local CLI dependency — deployable to cloud, serverless, Docker and CI/CD.',

    'cta.title': 'Get Started Now',
    'cta.desc': 'Free and open source. Running within minutes.',
    'cta.button': 'Download Lume',

    'download.title': 'Download Lume',
    'download.desc': 'Latest version v0.3.0 · Available for Windows and macOS',
    'download.windows': 'Windows',
    'download.windowsDesc': 'Windows 10/11 · x64 installer',
    'download.macos': 'macOS',
    'download.macAppleSilicon': 'Apple Silicon',
    'download.macIntel': 'Intel chip',
    'download.linux': 'Linux',
    'download.linuxSoon': 'Builds on the way — follow progress on the Releases page.',
    'download.installTitle': 'Installation Notes',
    'download.windowsInstall': "Run the .exe and follow the wizard. If SmartScreen shows up on first launch, choose 'Run anyway'.",
    'download.macInstall': "Open the .dmg and drag Lume into Applications. For unsigned builds, allow it once in System Settings.",
    'download.allReleases': 'Browse all releases →',
    'download.versionLabel': 'Current version',

    'changelog.title': 'Changelog',
    'changelog.desc': 'Improvements and new capabilities per release, synced from GitHub Releases.',

    'docs.title': 'Documentation',
    'docs.desc': 'From installation to advanced usage — everything Lume can do.',
    'docs.index': 'Documentation',
    'docs.backToDocs': 'Back to documentation',

    'footer.tagline': 'The local-first AI workbench — it remembers, it has opinions, it gets things done.',
    'footer.product': 'Product',
    'footer.community': 'Community',
    'footer.license': 'MIT License',
    'footer.copyright': '© 2026 CavinHuang · Lume Contributors',

    'theme.toLight': 'Switch to light mode',
    'theme.toDark': 'Switch to dark mode',
    'lang.switch': 'Switch language',
  },
} as const;

export type UiKey = keyof typeof ui.zh;

export function t(lang: Lang, key: UiKey): string {
  return ui[lang][key];
}

/** 从 URL 推断当前语言：默认 zh（无前缀），/en/ 前缀为 en */
export function getLangFromUrl(url: URL): Lang {
  return url.pathname === '/en' || url.pathname.startsWith('/en/') ? 'en' : 'zh';
}

/** 当前路径的语言镜像：/foo ↔ /en/foo */
export function counterpartPath(pathname: string): string {
  const isEn = pathname === '/en' || pathname.startsWith('/en/');
  if (isEn) return pathname.slice(3) || '/';
  return '/en' + pathname;
}
