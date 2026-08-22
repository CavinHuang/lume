// 站点常量：发新版本时同步更新 VERSION 与对应资产文件名

/** GitHub Pages 项目页子路径前缀（base: '/lume'）；根路径部署时 BASE_URL 为 '/' */
const RAW_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
const BASE_PREFIX = RAW_BASE === '' ? '/' : `${RAW_BASE}/`;

/** 给站内根相对路径补 base 前缀；外链不要经过这里 */
export const withBase = (path: string): string => `${RAW_BASE}${path}`;

/** 去掉当前 URL 上的 base 前缀，得到语言层路径（'/lume/en/docs/' → '/en/docs/'） */
export function stripBase(pathname: string): string {
  if (RAW_BASE === '') return pathname;
  if (pathname === RAW_BASE) return '/'; // 首页构建时 pathname 无尾斜杠
  return pathname.startsWith(BASE_PREFIX)
    ? pathname.slice(BASE_PREFIX.length - 1)
    : pathname;
}

export const REPO = 'CavinHuang/lume';
export const REPO_URL = `https://github.com/${REPO}`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;

export const VERSION = '0.3.0';

const latestAsset = (file: string) => `${LATEST_RELEASE_URL}/download/${file}`;

export const downloads = {
  windows: {
    file: `Lume-${VERSION}-x64.exe`,
    url: latestAsset(`Lume-${VERSION}-x64.exe`),
    requirement: 'Windows 10+',
  },
  macAppleSilicon: {
    file: `Lume-${VERSION}-arm64.dmg`,
    url: latestAsset(`Lume-${VERSION}-arm64.dmg`),
  },
  macIntel: {
    file: `Lume-${VERSION}-x64.dmg`,
    url: latestAsset(`Lume-${VERSION}-x64.dmg`),
  },
} as const;
