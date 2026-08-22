# Lume 官网设计

日期：2026-08-22 ｜ 状态：已确认

## 决策记录

| 维度 | 决策 |
|------|------|
| 范围 | 多页官网：首页 + 下载 + 更新日志 + 使用文档 |
| 技术栈 | Astro（纯自建，不用 Starlight），落点 `packages/website/` |
| 语言 | 中英双语，中文默认（无前缀），英文 `/en/` 前缀 |
| 视觉 | 全新设计，亮暗双主题（跟随系统 + 手动切换） |
| 文案 | 从代码库提取功能点撰写 |
| 部署 | 暂定，先保证 `astro build` 静态产物可部署任意静态托管 |

## 信息架构

```
/                首页 Landing
/download        下载页
/changelog       更新日志
/docs/[...slug]  使用文档
/en/...          以上四页英文镜像
```

导航：Logo ｜ 功能 · 文档 · 更新日志 ｜ GitHub ｜ 语言切换 ｜ 下载按钮（常驻 CTA）

## 页面内容

**首页**：Hero（标题 + 一句话价值主张 + 双 CTA「下载 / GitHub」+ 产品截图）→ 功能亮点网格 → 截图展示区 → 底部下载 CTA。功能清单（从代码库提取）：

1. 智能 Agent——自研 agent loop，多模型自由切换
2. 浏览器 Agent——AI 直接操控浏览器完成网页任务
3. IM 企业渠道——飞书 / 钉钉 / 企业微信双向打通
4. 办公文档预览——PDF / Word / Excel / PPT 本地渲染
5. Skills 与 MCP 生态——能力无限扩展
6. 本地优先——数据留在本机，隐私可控
7. 桌面集成——macOS 灵动岛浮窗、系统级入口
8. 开放 SDK——provider 契约化，宿主注入即用

**下载页**：三平台卡片（Windows / macOS / Linux），链接指向 GitHub Releases latest，附安装说明。

**更新日志**：markdown content collection；初版从现有 GitHub Releases 导入一次，后续随发版手动更新（不依赖构建期 GitHub API，避免 rate limit 与部署耦合）。

**使用文档**：markdown content collection，板块：快速开始 / 核心概念 / 场景指南（IM 接入、浏览器 agent、SDK 开发）/ 参考。

## 技术架构

```
packages/website/
├── astro.config.mjs          # i18n: defaultLocale zh (prefixDefaultLocale: false), locales [zh, en]
├── src/
│   ├── styles/global.css     # Tailwind v4 @theme tokens；亮色 :root + 暗色 media/manual
│   ├── layouts/Base.astro    # head / Nav / Footer / 主题+语言初始化脚本
│   ├── components/           # Nav, Footer, LangSwitch, ThemeToggle, Hero,
│   │                         # FeatureGrid, ScreenshotShowcase, DownloadCTA, Prose ≈10 个
│   ├── pages/                # index / download / changelog/index / docs/[...slug] + en/ 镜像
│   ├── content/
│   │   ├── docs/{zh,en}/…md  # 同 slug 中英映射，页面内互切
│   │   └── changelog/*.md    # frontmatter 带 lang 与 date
│   └── i18n/ui.ts            # UI 字典 zh/en + t(lang, key)
```

- 客户端零框架：仅主题切换与语言跳转的原生脚本。
- 字体：MiSans 官方 VF 转 woff2 自托管（npm 包字重错位，勿用 npm misans）；代码块系统 mono。
- 图标/吉祥物：logo 与吉祥物作为品牌资产保留，布局配色全新。

## 视觉方向

- 双主题 CSS tokens：`:root` 亮色为基，暗色经 `prefers-color-scheme` + `[data-theme="dark"]` 双通道覆盖。
- 品牌色：绿色 accent 延续品牌辨识度；底色中性石墨灰系。
- 语言：大圆角卡片、细边框、柔和渐变点缀，hero 网格光晕背景；排版用语义字号 token。

## 验证标准

1. `astro check` 与 `astro build` 通过。
2. 双语路由正确（zh 无前缀 / en 带 `/en/`），docs 页同 slug 互切不丢位置。
3. 亮暗主题跟随系统且手动切换生效、刷新后保持。
4. 移动端响应式，无横向滚动。
5. 所有下载链接指向真实 GitHub Release asset。
