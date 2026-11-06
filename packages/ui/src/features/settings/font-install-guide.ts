/**
 * Maple Mono 安装指引（font-system D12）：只指向系统包管理器与官方下载页，
 * taiji 不代下载。Linux 没有跨发行版的统一安装命令，直接给官方下载页。
 */
export const FONT_INSTALL_GUIDE = [
  {
    id: 'macos',
    labelKey: 'settings.fonts.installMacOS',
    valueKey: 'settings.fonts.installBrew',
  },
  {
    id: 'windows',
    labelKey: 'settings.fonts.installWindows',
    valueKey: 'settings.fonts.installScoop',
  },
  {
    id: 'linux',
    labelKey: 'settings.fonts.installLinux',
    valueKey: 'settings.fonts.installDownload',
  },
] as const
