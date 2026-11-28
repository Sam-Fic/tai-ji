/**
 * upgradeExtension 安装预算接线测试（extension-upgrade-hang-fix）。
 *
 * 缺陷背景：installAndValidate 此前只传单请求 timeout（无进展检测语义），弱网
 * 慢速持续下载时长无上界 → npm 安装串行锁（withInstallLock）被长期占用 → 后续
 * extension.upgrade RPC 无限排队，90 秒无 reply 无 error 信封。修复 = installNpm
 * 同时携带 budgetMs（整次安装网络总预算），预算到点以可重试 network 错误终止，
 * 锁占用有上界、超时以结构化 error 信封应答。
 *
 * 本文件测服务层接线：upgradeExtension 走升级路径时传给 IInstaller.installNpm 的
 * options 必须同时含 timeout 与 budgetMs（预算漏传 = 缺陷回归）。install 链内部的
 * 预算触发行为（fake registry + fake timers）在 npm-installer-tarball-stall.test.ts。
 *
 * 运行：cd packages/runtime && npx vitest run test/extension-upgrade-budget.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExtensionService } from '../src/services/extension-service.js'
import type { IInstaller, IExtensionResolver, DiscoveredExtension } from '../src/services/ports/installer.js'
import type { IExtensionSettings } from '../src/services/ports/extension-settings.js'

// 断言目标 = 预算与单请求窗口同值接线（extension-service.ts 的 NPM_INSTALL_TIMEOUT
// 模块私有常量，当前 60_000；不为测试导出改变服务层公共 API）
const EXPECTED_INSTALL_TIMEOUT = 60_000

// ── fake ports（接线断言只需捕获调用参数，无需真 npm 目录） ────────────────

function makeDeps(extDir: string) {
  const capturedInstallNpm: Array<{ spec: string; dir: string; opts: { timeout?: number; budgetMs?: number } | undefined }> = []

  const installer: IInstaller = {
    async installNpm(spec, dir, opts) {
      capturedInstallNpm.push({ spec, dir, opts })
      // 模拟安装产物落盘：installAndValidate 在 install 后检查
      // node_modules/<name> 存在 + isValidPiExtension，缺目录会走回滚失败路径
      const pkgDir = join(dir, 'fake-ext')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-ext', version: '2.0.0' }))
    },
    async uninstallNpm() {},
    async installDeps() { return { failed: [] } },
    async installGit() {},
    // latest 高于 fixture 版本 → upgradeExtension 走真实升级路径（installAndValidate）
    async getLatestVersion() { return '2.0.0' },
  }
  const resolver: IExtensionResolver = {
    resolve: (): { extensionDirs: DiscoveredExtension[] } => ({ extensionDirs: [{ path: extDir, source: 'settings' }] }),
    isValidPiExtension: () => true,
  }
  const extensionSettings: IExtensionSettings = {
    getPackages: () => ['npm:fake-ext'],
    addPackage: async () => {},
    removePackage: async () => {},
    getDisabled: () => [],
    setEnabled: async () => {},
    getAutoUpgrade: () => [],
    setAutoUpgrade: async () => {},
  }
  return { installer, resolver, extensionSettings, capturedInstallNpm }
}

describe('upgradeExtension 安装预算接线（budgetMs 传入 IInstaller.installNpm）', () => {
  let workDir: string
  let extDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ext-upgrade-budget-'))
    // 真文件：scanExtensions 链（resolveExtensions → readPkgMeta）要读 package.json
    // 推导 name/version（version 缺失会在 semver 判定段直接判「无需升级」，不走安装）
    extDir = join(workDir, 'fake-ext')
    mkdirSync(extDir)
    writeFileSync(join(extDir, 'package.json'), JSON.stringify({ name: 'fake-ext', version: '1.0.0' }))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('升级路径：installNpm 同时收到 timeout 与 budgetMs（预算漏传 = 挂死缺陷回归）', async () => {
    const { installer, resolver, extensionSettings, capturedInstallNpm } = makeDeps(extDir)
    const service = new ExtensionService({
      settingsDir: workDir,
      installer,
      resolver,
      extensionSettings,
      extensionsDir: join(workDir, 'extensions'),
      npmDir: join(workDir, 'npm'),
      tmpDir: join(workDir, 'tmp'),
    })

    const result = await service.upgradeExtension('fake-ext')

    expect(result.upgraded).toBe(true)
    expect(capturedInstallNpm).toHaveLength(1)
    const call = capturedInstallNpm[0]
    expect(call.spec).toBe('fake-ext')
    expect(call.opts?.timeout).toBe(EXPECTED_INSTALL_TIMEOUT)
    expect(call.opts?.budgetMs).toBe(EXPECTED_INSTALL_TIMEOUT)
  })

  it('无需升级（已是 latest）：不触发 install，无预算接线面', async () => {
    const { installer, resolver, extensionSettings, capturedInstallNpm } = makeDeps(extDir)
    vi.spyOn(installer, 'getLatestVersion').mockResolvedValue('1.0.0')
    const service = new ExtensionService({
      settingsDir: workDir,
      installer,
      resolver,
      extensionSettings,
      extensionsDir: join(workDir, 'extensions'),
      npmDir: join(workDir, 'npm'),
      tmpDir: join(workDir, 'tmp'),
    })

    const result = await service.upgradeExtension('fake-ext')

    expect(result.upgraded).toBe(false)
    expect(capturedInstallNpm).toHaveLength(0)
  })
})
