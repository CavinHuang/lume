// 站点常量：发新版本时同步更新 VERSION 与对应资产文件名
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
