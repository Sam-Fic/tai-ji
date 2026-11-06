import type { InstallResult } from '../ports/plugin-installer.js'
import type { PluginCatalogService } from './plugin-catalog.js'
import type { IPluginServiceDeps } from './plugin-types.js'

type ExtensionMemberInstaller = NonNullable<IPluginServiceDeps['piExtensionInstaller']>

function isErrorWithCode(err: unknown): err is { code: string } {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
}

function extensionMemberInstallFailure(packageName: string, err: unknown): InstallResult {
  const detail = err instanceof Error ? err.message : String(err)
  console.warn(`[plugin-service] pi extension member install failed for ${packageName}:`, detail)
  return {
    success: false,
    error: `插件已安装，但配套 pi 扩展成员安装失败：${detail}。请重试安装（幂等覆盖；扩展侧恢复后即自愈）`,
  }
}

/**
 * pi 扩展成员安装（provider-plugin-access U7/D6 双产物安装编排）：按清单条目判定双产物
 * ——条目携带 piExtensionVersion（guard 契约：仅双产物条目携带）→ 调端口安装，失败整体报
 * 失败（fail-fast：静默成功 = 对话链在很远的下游报「模型不存在」，排障成本远高于此刻失败）。
 * 三类跳过（不误伤单产物插件）：端口未配置（测试/联调，warn 留痕）、清单不可得（fail-safe
 * 链尾 config undefined——无法判定双产物 ≠ 必为双产物，跳过 + warn；清单恢复后重试安装自愈）、
 * 条目无 piExtensionVersion（单产物）。
 *
 * VERSION_PAIR_MISMATCH 自愈：v2-plugins.json 有 4h 本地缓存窗，发布后的新 wool-manifest
 * 可能先于清单缓存到达。配对失败时先强制刷新一次清单再重试，避免用户等缓存自然过期。
 */
export async function installPiExtensionMember(
  deps: { piExtensionInstaller?: ExtensionMemberInstaller },
  catalogService: PluginCatalogService,
  preview: { packageName: string },
): Promise<InstallResult | undefined> {
  const installer = deps.piExtensionInstaller
  if (!installer) {
    console.warn(`[plugin-service] no piExtensionInstaller configured; pi extension member skipped for ${preview.packageName}`)
    return undefined
  }
  const load = await catalogService.load()
  const entry = load.config?.plugins.find((p) => p.packageName === preview.packageName)
  if (!entry) {
    console.warn(`[plugin-service] catalog has no entry for ${preview.packageName}; pi extension member skipped`)
    return undefined
  }
  if (entry.piExtensionVersion === undefined) {
    return undefined
  }
  try {
    await installer.installForCatalogEntry({ packageName: entry.packageName, piExtensionVersion: entry.piExtensionVersion })
    return undefined
  } catch (err) {
    if (!isErrorWithCode(err) || err.code !== 'VERSION_PAIR_MISMATCH') {
      return extensionMemberInstallFailure(entry.packageName, err)
    }
    const refreshed = await catalogService.load({ force: true })
    const refreshedEntry = refreshed.config?.plugins.find((p) => p.packageName === preview.packageName)
    if (refreshedEntry?.piExtensionVersion === undefined || refreshedEntry.piExtensionVersion === entry.piExtensionVersion) {
      return extensionMemberInstallFailure(entry.packageName, err)
    }
    try {
      await installer.installForCatalogEntry({
        packageName: refreshedEntry.packageName,
        piExtensionVersion: refreshedEntry.piExtensionVersion,
      })
      return undefined
    } catch (retryErr) {
      return extensionMemberInstallFailure(entry.packageName, retryErr)
    }
  }
}
