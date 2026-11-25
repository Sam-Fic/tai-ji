/**
 * pick-platform-asset 单元测试（I#7 test-coverage）。
 *
 * 覆盖 pickPlatformAsset / pickPlatformAssetName 全部导出：
 *   1. darwin → macArm64Dmg
 *   2. win32 → winX64Exe
 *   3. linux → linuxX64AppImage
 *   4. unknown（如 freebsd/aix）→ undefined
 *   5. 平台 asset 缺失（release 未发布该平台产物）→ undefined
 *   6. pickPlatformAssetName 返回对应 asset 的 name（或 undefined）
 *
 * 之前仅经 preloaded-update / orchestrator 间接覆盖 darwin/win/linux，
 * 未覆盖 default → undefined 分支与各平台资产缺失分支。本测试补齐独立单测。
 *
 * Mock 策略（对齐 shell-env.test.ts / orchestrator.test.ts）：
 * - process.platform 只读，用 Object.defineProperty 桩（configurable:true 便于还原）
 * - pickPlatformAsset 在函数体内读 process.platform（非模块加载时），无需 vi.resetModules
 *
 * 运行：npx vitest run apps/electron/main/test/pick-platform-asset.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { LatestReleaseInfo, ReleaseAsset } from '@taiji/shared'
import { pickPlatformAsset, pickPlatformAssetName } from '../update/pick-platform-asset.js'

const ORIG_PLATFORM = process.platform
const ORIG_ARCH = process.arch

/** 临时覆盖 process.platform（只读属性，需 Object.defineProperty）。 */
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** 临时覆盖 process.arch（mac 资产选择已 arch 感知，ADR-0198；测试需显式锁定）。 */
function setArch(arch: string): void {
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

/** 构造包含全部 3 个平台 asset 的 release fixture。 */
function makeFullRelease(): LatestReleaseInfo {
  return {
    version: '0.9.0',
    tagName: 'v0.9.0',
    releaseNotes: '## What changed\n- pick-platform-asset fixture',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
    assets: {
      macArm64Dmg: {
        name: 'TaiJi-0.10.0-mac-arm64.dmg',
        downloadUrl: 'https://example.com/mac.dmg',
        size: 1000,
        sha256: 'a'.repeat(64),
      },
      winX64Exe: {
        name: 'TaiJi-0.10.0-win-x64.exe',
        downloadUrl: 'https://example.com/win.exe',
        size: 2000,
        sha256: 'b'.repeat(64),
      },
      linuxX64AppImage: {
        name: 'TaiJi-0.10.0-linux-x64.AppImage',
        downloadUrl: 'https://example.com/linux.AppImage',
        size: 3000,
        sha256: 'c'.repeat(64),
      },
    },
  }
}

/** 构造含 darwin 双架构槽位的 release fixture（ADR-0198）。 */
function makeFullReleaseWithX64(): LatestReleaseInfo {
  const release = makeFullRelease()
  release.assets.macX64Dmg = {
    name: 'TaiJi-0.10.0-mac-x64.dmg',
    downloadUrl: 'https://example.com/mac-x64.dmg',
    size: 1100,
    sha256: 'd'.repeat(64),
  }
  return release
}

beforeEach(() => {
  // 默认还原平台与架构，单个用例内自行 setPlatform / setArch
  setPlatform(ORIG_PLATFORM)
  setArch(ORIG_ARCH)
})

afterEach(() => {
  setPlatform(ORIG_PLATFORM)
  setArch(ORIG_ARCH)
})

describe('pickPlatformAsset', () => {
  it('darwin + arm64 → 返回 macArm64Dmg asset', () => {
    setPlatform('darwin')
    setArch('arm64')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset?.name).toBe('TaiJi-0.10.0-mac-arm64.dmg')
    expect(asset?.size).toBe(1000)
  })

  it('win32 → 返回 winX64Exe asset', () => {
    setPlatform('win32')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset?.name).toBe('TaiJi-0.10.0-win-x64.exe')
    expect(asset?.size).toBe(2000)
  })

  it('linux → 返回 linuxX64AppImage asset', () => {
    setPlatform('linux')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset?.name).toBe('TaiJi-0.10.0-linux-x64.AppImage')
    expect(asset?.size).toBe(3000)
  })

  it('unknown 平台（如 freebsd）→ 返回 undefined（覆盖 default 分支）', () => {
    setPlatform('freebsd')
    const asset = pickPlatformAsset(makeFullRelease())
    expect(asset).toBeUndefined()
  })

  it('当前平台 asset 缺失（release 未发布该平台产物）→ 返回 undefined', () => {
    setPlatform('darwin')
    setArch('arm64')
    const release = makeFullRelease()
    // 删掉 mac 产物，模拟 release 未提供 mac 包
    delete release.assets.macArm64Dmg
    const asset = pickPlatformAsset(release)
    expect(asset).toBeUndefined()
  })
})

describe('pickPlatformAssetName', () => {
  it('darwin + arm64 → 返回 macArm64Dmg.name', () => {
    setPlatform('darwin')
    setArch('arm64')
    expect(pickPlatformAssetName(makeFullRelease())).toBe('TaiJi-0.10.0-mac-arm64.dmg')
  })

  it('darwin + x64 → 返回 macX64Dmg.name（ADR-0198 双架构）', () => {
    setPlatform('darwin')
    setArch('x64')
    expect(pickPlatformAssetName(makeFullReleaseWithX64())).toBe('TaiJi-0.10.0-mac-x64.dmg')
  })

  it('darwin + x64 且 macX64Dmg 缺失 → 返回 undefined（槽位缺失语义）', () => {
    setPlatform('darwin')
    setArch('x64')
    const release = makeFullRelease()
    expect(pickPlatformAsset(release)).toBeUndefined()
  })

  it('darwin + arm64 且仅有 macX64Dmg → 返回 undefined（双槽位互不兜底）', () => {
    setPlatform('darwin')
    setArch('arm64')
    const release = makeFullReleaseWithX64()
    delete release.assets.macArm64Dmg
    expect(pickPlatformAsset(release)).toBeUndefined()
  })

  it('win32 → 返回 winX64Exe.name', () => {
    setPlatform('win32')
    expect(pickPlatformAssetName(makeFullRelease())).toBe('TaiJi-0.10.0-win-x64.exe')
  })

  it('linux → 返回 linuxX64AppImage.name', () => {
    setPlatform('linux')
    expect(pickPlatformAssetName(makeFullRelease())).toBe('TaiJi-0.10.0-linux-x64.AppImage')
  })

  it('unknown 平台 → 返回 undefined', () => {
    setPlatform('aix')
    expect(pickPlatformAssetName(makeFullRelease())).toBeUndefined()
  })

  it('平台 asset 缺失 → 返回 undefined', () => {
    setPlatform('linux')
    const release = makeFullRelease()
    delete release.assets.linuxX64AppImage
    expect(pickPlatformAssetName(release)).toBeUndefined()
  })

  it('返回的 name 与 pickPlatformAsset 返回对象的 name 一致', () => {
    setPlatform('darwin')
    setArch('arm64')
    const release = makeFullRelease()
    const asset: ReleaseAsset | undefined = pickPlatformAsset(release)
    const name: string | undefined = pickPlatformAssetName(release)
    expect(name).toBe(asset?.name)
  })
})
