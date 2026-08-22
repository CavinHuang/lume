export const languages = {
  zh: '中文',
  en: 'English',
} as const;

export type Lang = keyof typeof languages;

export const ui = {
  zh: {
    'nav.features': '功能',
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
    'features.personas.desc': '11 位有独立风格与专长的角色，主线程理解任务后分发给最合适的人。',
    'features.skills.title': 'Skills 与 MCP',
    'features.skills.desc': 'SKILL.md 热加载的技能体系 + 标准 MCP 客户端，能力无限扩展。',
    'features.tools.title': '完整工具集',
    'features.tools.desc': '文件系统、Bash、LSP 代码智能、Office 文档、Web 搜索与抓取、图片生成。',
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
    'features.personas.desc': '11 characters with distinct styles and specialties; the main thread routes each task to the best fit.',
    'features.skills.title': 'Skills & MCP',
    'features.skills.desc': 'Hot-reloading SKILL.md skill system plus a standard MCP client — extend it endlessly.',
    'features.tools.title': 'Full Toolset',
    'features.tools.desc': 'File system, Bash, LSP code intelligence, Office documents, web search & fetch, image generation.',
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
