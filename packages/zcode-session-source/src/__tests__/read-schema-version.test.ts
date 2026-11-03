/**
 * readSchemaVersion 诊断面契约：queryLatestSchemaVersion 的两个调用侧分流——
 * 门禁面（assertKnownSchema）不可用时 fail-fast 抛 drift，诊断面（wrapDb 的
 * readSchemaVersion）吞错返 undefined。
 *
 * 用路由假驱动（与 error-contract.test.ts 同款形态，但版本行可换）覆盖诊断面
 * 全程：打开时版本行合法（门禁通过）→ 读版本返原值；版本行变成不可用形态
 * （非对象 / 空串）→ 返 undefined，不回填假值。纯逻辑，不依赖真实 sqlite，
 * 两条执行路径（node / bun 驱动）断言集同一。
 *
 * 驱动注入只在本文件生效（vi.mock 文件级）：fixture 用例仍走真实驱动。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { SqliteDb, SqliteDriver } from '../sqlite-driver.ts'
import { openZcodeSessionDb } from '../sqlite-access.ts'

const fakeDriverSlot = vi.hoisted(() => ({ driver: null as SqliteDriver | null }))

vi.mock('../sqlite-driver.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sqlite-driver.ts')>()
  return {
    ...actual,
    loadSqliteDriver: async () => fakeDriverSlot.driver ?? actual.loadSqliteDriver(),
  }
})

/** 版本行可变：拉开「开库门禁读到的行」与「诊断面再读的行」的时点。 */
type SchemaRowRef = { row: unknown }

/** 按 sql 路由的假连接：sqlite_master 探测（固定三表）/ schema_migration（可变行）/ 其余空。 */
function routingFakeDb(rowRef: SchemaRowRef): SqliteDb {
  const masterRows = [{ name: 'session' }, { name: 'message' }, { name: 'part' }]
  return {
    prepare(sql: string) {
      if (sql.includes('sqlite_master')) {
        return { all: () => masterRows, get: () => masterRows[0] }
      }
      if (sql.includes('schema_migration')) {
        return { all: () => [rowRef.row], get: () => rowRef.row }
      }
      return { all: () => [], get: () => undefined }
    },
    close() {},
  }
}

describe('readSchemaVersion 诊断面', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    fakeDriverSlot.driver = null
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  function openWithFakeDriver(rowRef: SchemaRowRef) {
    fakeDriverSlot.driver = { id: 'fake-test-driver', open: () => routingFakeDb(rowRef) }
    const dir = mkdtempSync(join(tmpdir(), 'zss-schema-diag-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'db.sqlite')
    // openZcodeSessionDb 前置存在性检查：内容由假驱动接管，只需文件在场
    writeFileSync(dbPath, 'dummy bytes — orchestration entry requires the file to exist')
    return openZcodeSessionDb(dbPath)
  }

  it('版本行可读：返回库内最新版本', async () => {
    const handle = await openWithFakeDriver({ row: { app_version: '0.16.5' } })
    try {
      expect(handle.db.readSchemaVersion()).toBe('0.16.5')
    } finally {
      handle.dispose()
    }
  })

  it('版本行不可用（非对象 / 空串）：返 undefined，不回填假值', async () => {
    const rowRef: SchemaRowRef = { row: { app_version: '0.16.5' } }
    const handle = await openWithFakeDriver(rowRef)
    try {
      rowRef.row = 42
      expect(handle.db.readSchemaVersion()).toBeUndefined()
      rowRef.row = { app_version: '' }
      expect(handle.db.readSchemaVersion()).toBeUndefined()
    } finally {
      handle.dispose()
    }
  })
})
