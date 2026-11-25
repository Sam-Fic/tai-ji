/**
 * 按当前平台 + 架构选择 release 对应的 asset。
 *
 * 与 orchestrator 的 pickAsset 同源逻辑：darwin 按 process.arch 分流（arm64 →
 * macArm64Dmg，x64 → macX64Dmg），win32 → winX64Exe，linux → linuxX64AppImage。
 * 抽成独立模块供 orchestrator / preloaded-update / manual-claim / platform-updater
 * 复用，避免多处平台×架构分流逻辑漂移。
 *
 * x64 语义（v0.13.3 起，替代旧版「darwin 非 arm64 一律拒绝」门控）：release 双架构
 * 发布（mac-x64.dmg 自 v0.13.1 起），Intel mac 消费 macX64Dmg 槽位自动升级；槽位
 * 缺失（release 未发布该架构产物）由 orchestrator 判 unsupported → 前端跳 release
 * 页手动下载降级。
 *
 * 依赖方向：pick-platform-asset → @taiji/shared
 */
import type { LatestReleaseInfo, ReleaseAsset } from '@taiji/shared'

/** LatestReleaseInfo.assets 的全部键位（含 darwin 双架构槽位）。 */
export type PlatformAssetKey = 'macArm64Dmg' | 'macX64Dmg' | 'winX64Exe' | 'linuxX64AppImage'

/**
 * 解析「平台 × 架构」对应的 asset 槽位键。
 *
 * darwin 的分流依据是 process.arch（arm64 → macArm64Dmg，其余 → macX64Dmg；
 * darwin 上 process.arch 值域只有 'arm64' | 'x64'）。win32 / linux 与架构无关。
 *
 * @param platform 目标平台（缺省读 process.platform；测试显式注入）
 * @param arch 目标架构（缺省读 process.arch；测试显式注入）
 * @returns asset 槽位键；未知平台返回 undefined
 */
export function resolvePlatformAssetKey(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformAssetKey | undefined {
  switch (platform) {
    case 'darwin': return arch === 'arm64' ? 'macArm64Dmg' : 'macX64Dmg'
    case 'win32': return 'winX64Exe'
    case 'linux': return 'linuxX64AppImage'
    default: return undefined
  }
}

/**
 * darwin 当前架构对应的 dmg asset 槽位键（MacUpdater 专用）。
 *
 * MacUpdater 只会在 darwin 上被 createPlatformUpdater 构造，用本函数取 sha256
 * 槽位与 pickPlatformAsset 的分流同源（改架构分流只改这一处）。
 */
export function macDmgAssetKeyForArch(arch: string): 'macArm64Dmg' | 'macX64Dmg' {
  return arch === 'arm64' ? 'macArm64Dmg' : 'macX64Dmg'
}

/**
 * 根据当前进程（process.platform + process.arch）选择对应平台 asset。
 *
 * @param release release 信息
 * @returns 当前平台 asset；平台不支持或 asset 缺失返回 undefined
 */
export function pickPlatformAsset(release: LatestReleaseInfo): ReleaseAsset | undefined {
  const key = resolvePlatformAssetKey()
  return key ? release.assets[key] : undefined
}

/**
 * 当前平台对应 asset 的 name（用于预下载产物校验）。
 *
 * @param release release 信息
 * @returns asset name；无对应 asset 返回 undefined
 */
export function pickPlatformAssetName(release: LatestReleaseInfo): string | undefined {
  return pickPlatformAsset(release)?.name
}
