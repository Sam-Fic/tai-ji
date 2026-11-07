/**
 * npm-installer fetchPackageVersions 单测（插件安装前版本下拉数据源）。
 *
 * 覆盖目标：fetchPackageVersions 全分支——合法路径（semver 过滤 + 降序 + latest 取
 * dist-tags 而非最大版本）/ 无 latest（not_found）/ 全非法版本（not_found）。
 *
 * registry 注入沿用 npm-installer-tarball-stall.test.ts 模式：本地 HTTPS 服务器
 * （自签证书 fixture + NODE_TLS_REJECT_UNAUTHORIZED=0）+ NPM_CONFIG_REGISTRY 覆盖。
 * 本文件只回 metadata JSON（无 tarball / 无解压），loopback 毫秒级确定性完成。
 *
 * 运行：cd packages/runtime && npx vitest run test/npm-installer-fetch-versions.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { fetchPackageVersions, NpmInstallError } from '../src/infra/installers/npm-installer.js'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test-localhost-cert')
const TLS_OPTIONS = {
  key: readFileSync(join(FIXTURE_DIR, 'key.pem')),
  cert: readFileSync(join(FIXTURE_DIR, 'cert.pem')),
}

/** registry metadata 应答（按用例切换；undefined = 404） */
let metadataBody: Record<string, unknown> | undefined

let server: https.Server
let baseUrl: string
let originalRegistry: string | undefined

beforeAll(() => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  server = https.createServer(TLS_OPTIONS, (req, res) => {
    if (req.url === '/fake-pkg' && metadataBody !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(metadataBody))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  // 显式绑 127.0.0.1 单栈（端口撞号面收窄，同 npm-installer-tarball-stall 注释）
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(() => {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
})

beforeEach(() => {
  originalRegistry = process.env.NPM_CONFIG_REGISTRY
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`
  process.env.NPM_CONFIG_REGISTRY = baseUrl
})

afterEach(() => {
  if (originalRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY
  else process.env.NPM_CONFIG_REGISTRY = originalRegistry
})

describe('fetchPackageVersions', () => {
  it('合法路径：非法 semver 被过滤、合法版本降序、prerelease 保留、latest 取 dist-tags（非最大版本）', async () => {
    metadataBody = {
      'dist-tags': { latest: '1.0.0' },
      versions: {
        // 乱序 + 混入非法版本：2.0.0 > 1.0.0 > 1.0.0-beta.1 > 0.9.1（prerelease 低于同号 release）
        '0.9.1': { version: '0.9.1', dist: { tarball: 'x' } },
        'not-semver': { version: 'not-semver', dist: { tarball: 'x' } },
        '1.0.0-beta.1': { version: '1.0.0-beta.1', dist: { tarball: 'x' } },
        '2.0.0': { version: '2.0.0', dist: { tarball: 'x' } },
        '1.0.0': { version: '1.0.0', dist: { tarball: 'x' } },
      },
    }
    const result = await fetchPackageVersions('fake-pkg')
    expect(result.versions).toEqual(['2.0.0', '1.0.0', '1.0.0-beta.1', '0.9.1'])
    // latest 是 dist-tags 契约值——2.0.0 存在但 latest 仍取 1.0.0（下拉默认值语义）
    expect(result.latest).toBe('1.0.0')
  })

  it('无 latest dist-tag：not_found', async () => {
    metadataBody = {
      'dist-tags': {},
      versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'x' } } },
    }
    const promise = fetchPackageVersions('fake-pkg')
    await expect(promise).rejects.toBeInstanceOf(NpmInstallError)
    await expect(promise).rejects.toMatchObject({ code: 'not_found' })
    await expect(promise).rejects.toThrow(/No latest version found for fake-pkg/)
  })

  it('versions 全部非法 semver：not_found（过滤后空集不可当「有版本」返回）', async () => {
    metadataBody = {
      'dist-tags': { latest: '1.0.0' },
      versions: {
        'not-semver': { version: 'not-semver', dist: { tarball: 'x' } },
        'also-bad!': { version: 'also-bad!', dist: { tarball: 'x' } },
      },
    }
    const promise = fetchPackageVersions('fake-pkg')
    await expect(promise).rejects.toBeInstanceOf(NpmInstallError)
    await expect(promise).rejects.toMatchObject({ code: 'not_found' })
    await expect(promise).rejects.toThrow(/No published versions found for fake-pkg/)
  })
})
